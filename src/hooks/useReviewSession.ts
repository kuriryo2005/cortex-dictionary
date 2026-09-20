/**
 * 復習セッションの状態管理（実装仕様書 F3）。
 *
 * 直していた不具合:
 *
 *   旧実装は flashcardList（nextReviewAt でソートした配列）と数値インデックスで
 *   カードを特定していた。評価すると updateDoc → onSnapshot → 再ソートで
 *   **配列の並びが変わる**。その裏で setTimeout が index+1 を進めるため、
 *   進んだ先が意図しないカードになったり、同じカードが再び出たり、
 *   件数が変わって % length の剰余がずれたりしていた。
 *
 * 対策は「セッション開始時に wordId の配列を確定し、以後 onSnapshot の影響を
 * 受けない」こと。表示内容は最新の savedWords から id で引くので、AI 分析の
 * 追記などの更新は反映されつつ、**順序だけが固定**される。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DictionaryMode, ReviewRating, SavedWord } from "../types";

const STORAGE_KEY = "cortex_dict_review_session";
/** 中断したセッションを再開できる期間。これを過ぎたら破棄する。 */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUE = 200;
/** 1 セッションで学習ステップの語を戻せる上限。終われなくなるのを防ぐ。 */
const MAX_REQUEUE = 40;

export interface ReviewFilter {
  /** 期限が来ているものだけに絞る */
  onlyDue: boolean;
  mode?: DictionaryMode;
}

/**
 * 出題の形式。
 *
 *   flip … カードをめくって自己申告する（再認）
 *   type … 日本語を見て綴りを打つ（想起）
 *
 * 想起のほうが定着に効くが、初見の語にいきなり打たせても手が出ないので、
 * 「今日のサイクル」は導入を flip、2 周目を type に割り当てている。
 */
export type ReviewMode = "flip" | "type";

export interface ReviewSessionState {
  /**
   * wordId の配列。
   *
   * 以前は「セッション中は不変」だった。学習ステップ（1分 / 10分）で
   * 数分後に再出題すべき語が出てきたため、**末尾への追加だけ**を許す。
   * 既に出した位置より手前は決して書き換えないので、index のずれは起きない。
   */
  queue: string[];
  index: number;
  results: Record<string, ReviewRating>;
  startedAt: number;
  filter: ReviewFilter;
  mode: ReviewMode;
  /** 同じセッション内で再出題した回数。無限に膨らませないための上限管理 */
  requeued?: number;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Fisher-Yates。毎回同じ順序で覚えてしまうのを防ぐ。 */
function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * キューを組み立てる。純粋関数なので単体テストできる（scripts/verify-phase2.ts）。
 *
 * 並び: 期限超過 → 本日分 → 未復習（新規）。同順位内はシャッフル。
 */
export function buildQueue(words: SavedWord[], filter: ReviewFilter, now = Date.now()): string[] {
  const dayStart = startOfToday();
  const dayEnd = endOfToday();

  const candidates = words.filter((w) => {
    if (filter.mode && w.mode !== filter.mode) return false;
    if (!filter.onlyDue) return true;
    // 未復習は常に対象。復習済みは今日中に期限が来るものだけ。
    return w.nextReviewAt == null || w.nextReviewAt <= dayEnd;
  });

  const overdue: SavedWord[] = [];
  const today: SavedWord[] = [];
  const fresh: SavedWord[] = [];

  for (const w of candidates) {
    if (w.nextReviewAt == null) fresh.push(w);
    else if (w.nextReviewAt < dayStart) overdue.push(w);
    else if (w.nextReviewAt <= dayEnd) today.push(w);
    else today.push(w); // onlyDue=false で未来のものが混ざった場合
  }

  // 期限超過は古い順（長く放置されたものほど先）
  overdue.sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0));

  return [...overdue, ...shuffle(today), ...shuffle(fresh)]
    .slice(0, MAX_QUEUE)
    .map((w) => w.id);
}

function readStored(): ReviewSessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReviewSessionState;
    if (!Array.isArray(parsed?.queue) || parsed.queue.length === 0) return null;
    if (Date.now() - (parsed.startedAt ?? 0) > RESUME_WINDOW_MS) return null;
    if (parsed.index >= parsed.queue.length) return null; // 完了済みは再開しない
    // mode を足す前に保存されたセッションには存在しない。既定へ寄せる
    return { ...parsed, mode: parsed.mode === "type" ? "type" : "flip" };
  } catch {
    return null;
  }
}

function writeStored(state: ReviewSessionState | null): void {
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存できなくてもセッション自体は続行できる
  }
}

export interface ReviewSessionApi {
  session: ReviewSessionState | null;
  /** 表示中のカード。null なら該当なし（削除済みなど）。 */
  current: SavedWord | null;
  /** 現在位置（1始まり）。サマリー画面では queue.length と等しい。 */
  position: number;
  total: number;
  isFinished: boolean;
  /** 中断中のセッションがあるか（開始前のみ意味を持つ） */
  resumable: ReviewSessionState | null;
  start: (words: SavedWord[], filter: ReviewFilter, mode?: ReviewMode) => number;
  /** 並び替えずに、渡された順のまま出す（「今日のサイクル」の各段で使う） */
  startExact: (words: SavedWord[], mode?: ReviewMode) => number;
  /** 学習ステップの語を同じセッションの末尾へ戻す */
  requeue: (wordId: string) => void;
  mode: ReviewMode;
  resume: () => void;
  discardResumable: () => void;
  grade: (rating: ReviewRating) => SavedWord | null;
  next: () => void;
  prev: () => void;
  /** AGAIN が付いた単語だけでもう一周する */
  restartWithAgain: () => number;
  end: () => void;
}

export function useReviewSession(words: SavedWord[]): ReviewSessionApi {
  const [session, setSession] = useState<ReviewSessionState | null>(null);
  const [resumable, setResumable] = useState<ReviewSessionState | null>(() => readStored());

  const byId = useMemo(() => {
    const map = new Map<string, SavedWord>();
    for (const w of words) map.set(w.id, w);
    return map;
  }, [words]);

  // grade() から最新の単語一覧を参照するため（クロージャに古い値が固定されるのを防ぐ）
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  /**
   * 現在のセッションを同期的に読むための参照。
   *
   * setSession の更新関数の中で外側の変数に代入して戻り値にする書き方は、
   * React が更新をレンダー時まで遅らせるため機能しない（常に初期値が返る）。
   * 連打されても取りこぼさないよう、setSession と同時にこの ref も進める。
   */
  const sessionRef = useRef<ReviewSessionState | null>(session);
  sessionRef.current = session;

  const apply = useCallback((nextState: ReviewSessionState | null) => {
    sessionRef.current = nextState;
    setSession(nextState);
  }, []);

  useEffect(() => {
    writeStored(session && session.index < session.queue.length ? session : null);
  }, [session]);

  const isFinished = !!session && session.index >= session.queue.length;

  /**
   * セッション中に単語が削除されると id を引けなくなる。
   * その場合は自動で次へ送る（空白のカードを表示しない）。
   */
  useEffect(() => {
    if (!session || isFinished) return;
    const id = session.queue[session.index];
    if (byId.has(id)) return;
    apply({ ...session, index: session.index + 1 });
  }, [session, byId, isFinished, apply]);

  const current = session && !isFinished ? byId.get(session.queue[session.index]) ?? null : null;

  const start = useCallback(
    (source: SavedWord[], filter: ReviewFilter, mode: ReviewMode = "flip") => {
      const queue = buildQueue(source, filter);
      if (queue.length === 0) return 0;
      apply({ queue, index: 0, results: {}, startedAt: Date.now(), filter, mode });
      setResumable(null);
      return queue.length;
    },
    [apply]
  );

  const startExact = useCallback(
    (source: SavedWord[], mode: ReviewMode = "flip") => {
      const queue = source.map((w) => w.id).slice(0, MAX_QUEUE);
      if (queue.length === 0) return 0;
      apply({
        queue,
        index: 0,
        results: {},
        startedAt: Date.now(),
        filter: { onlyDue: false },
        mode,
      });
      setResumable(null);
      return queue.length;
    },
    [apply]
  );

  /**
   * 1 分後・10 分後に再出題すべき語を末尾へ戻す。
   *
   * 1 セッションで戻せる回数に上限を置く。AGAIN を押し続けると
   * キューが伸び続けて終われなくなるため。
   */
  const requeue = useCallback(
    (wordId: string) => {
      const prev = sessionRef.current;
      if (!prev) return;
      if ((prev.requeued ?? 0) >= MAX_REQUEUE) return;
      // 未出題の分がまだ末尾に残っているなら二重に積まない
      if (prev.queue.slice(prev.index).includes(wordId)) return;
      apply({
        ...prev,
        queue: [...prev.queue, wordId],
        requeued: (prev.requeued ?? 0) + 1,
      });
    },
    [apply]
  );

  const resume = useCallback(() => {
    const stored = readStored();
    if (stored) apply(stored);
    setResumable(null);
  }, [apply]);

  const discardResumable = useCallback(() => {
    writeStored(null);
    setResumable(null);
  }, []);

  /**
   * 評価して次へ。書き込み対象の単語を返す（DB 更新は呼び出し側の責務）。
   * 返り値が null なら、対象が既に削除されているので書き込み不要。
   */
  const grade = useCallback(
    (rating: ReviewRating): SavedWord | null => {
      const prev = sessionRef.current;
      if (!prev || prev.index >= prev.queue.length) return null;
      const id = prev.queue[prev.index];
      apply({
        ...prev,
        index: prev.index + 1,
        results: { ...prev.results, [id]: rating },
      });
      return byIdRef.current.get(id) ?? null;
    },
    [apply]
  );

  // 末尾に到達したら終了する。旧実装の % length による無限ループは廃止した。
  const next = useCallback(() => {
    const prev = sessionRef.current;
    if (prev && prev.index < prev.queue.length) apply({ ...prev, index: prev.index + 1 });
  }, [apply]);

  const prev = useCallback(() => {
    const s = sessionRef.current;
    if (s && s.index > 0) apply({ ...s, index: s.index - 1 });
  }, [apply]);

  const restartWithAgain = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return 0;
    const queue = s.queue.filter((id) => s.results[id] === ReviewRating.AGAIN);
    if (queue.length === 0) return 0;
    apply({
      queue: shuffle(queue),
      index: 0,
      results: {},
      startedAt: Date.now(),
      filter: s.filter,
      mode: s.mode,
    });
    return queue.length;
  }, [apply]);

  const end = useCallback(() => {
    apply(null);
    writeStored(null);
    setResumable(null);
  }, [apply]);

  return {
    session,
    current,
    position: session ? Math.min(session.index + 1, session.queue.length) : 0,
    total: session ? session.queue.length : 0,
    isFinished,
    resumable,
    start,
    startExact,
    requeue,
    mode: session?.mode ?? "flip",
    resume,
    discardResumable,
    grade,
    next,
    prev,
    restartWithAgain,
    end,
  };
}
