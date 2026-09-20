/**
 * 復習間隔の計算（SM-2 系 + 当日の学習ステップ）。
 *
 * これまで次回日時は /api/review-analysis で毎回 LLM に決めさせていた。
 * その設計には三つの問題があった。
 *
 *   - 評価のたびに課金と数秒の待ちが発生する（連続で評価すると詰まる）
 *   - 同じ履歴でも返る日付が揺れるので、間隔が伸びていく保証がない
 *   - 通信に失敗すると nextReviewAt が更新されず、その語が永久に期限超過になる
 *
 * ここでは間隔をローカルで決定的に計算する。呼び出しは同期で、失敗しない。
 *
 * **スキーマを増やしていない**のが要点。SM-2 は ease と interval を持ち越す
 * 必要があるが、それらは reviewHistory（{rating, timestamp} の列）を頭から
 * 再生すれば復元できる。既存ドキュメントに新しいフィールドを足さずに
 * 済むので、firestore.rules もデータ移行も触らない（鉄則 R2 / R3）。
 *
 * AI の出番は「なぜ間違えるのか」の解説だけに絞る。日付決めからは外す。
 */

import { ReviewRating, ReviewSession, SavedWord } from "../types";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/**
 * 卒業前の短い刻み。新しい語は「その日のうちに 3 回触る」。
 *
 * 1 日 1 回しか出さない設計だと、覚える前に間隔が開いて忘却に負ける。
 * 初回の定着だけは分単位で詰めるのが効く（Anki の learning steps と同じ考え）。
 */
export const LEARNING_STEPS_MS = [1 * MIN, 10 * MIN, 1 * DAY];

/** 卒業直後の間隔。 */
const GRADUATED_MS = 3 * DAY;
/** EASY で一気に卒業したときの間隔。 */
const EASY_GRADUATED_MS = 5 * DAY;

const MIN_EASE = 1.3;
const MAX_EASE = 2.8;
const START_EASE = 2.3;

/** 間隔の上限。これ以上空けても実用上意味がない。 */
const MAX_INTERVAL_MS = 300 * DAY;

/** AGAIN がこの回数を超えた語は「漏れバケツ」扱いにする。 */
export const LEECH_THRESHOLD = 6;

export interface SrsState {
  /** 学習ステップの何段目か。卒業済みなら null */
  step: number | null;
  /** 直近の間隔（ms）。卒業前は 0 */
  intervalMs: number;
  ease: number;
  reps: number;
  lapses: number;
  /** 最後の評価の時刻。履歴が空なら null */
  lastReviewedAt: number | null;
}

export const INITIAL_STATE: SrsState = {
  step: 0,
  intervalMs: 0,
  ease: START_EASE,
  reps: 0,
  lapses: 0,
  lastReviewedAt: null,
};

const clampEase = (v: number) => Math.min(MAX_EASE, Math.max(MIN_EASE, v));

/** 1 回の評価を state に適用する。純粋関数。 */
export function applyRating(state: SrsState, rating: ReviewRating, at: number): SrsState {
  const next: SrsState = { ...state, reps: state.reps + 1, lastReviewedAt: at };

  // --- 卒業前（学習ステップの途中） ---
  if (state.step !== null) {
    if (rating === ReviewRating.AGAIN) {
      next.step = 0;
      next.ease = clampEase(state.ease - 0.2);
      return next;
    }
    if (rating === ReviewRating.HARD) {
      // 段を進めない。同じ刻みをもう一度
      next.step = state.step;
      return next;
    }
    if (rating === ReviewRating.EASY) {
      // 途中でも一気に卒業させる。分かっている語を何度も出さない
      next.step = null;
      next.intervalMs = EASY_GRADUATED_MS;
      next.ease = clampEase(state.ease + 0.15);
      return next;
    }
    // GOOD: 次の段へ。最終段を越えたら卒業
    const advanced = state.step + 1;
    if (advanced >= LEARNING_STEPS_MS.length) {
      next.step = null;
      next.intervalMs = GRADUATED_MS;
    } else {
      next.step = advanced;
    }
    return next;
  }

  // --- 卒業後（SM-2） ---
  const base = Math.max(state.intervalMs, DAY);

  if (rating === ReviewRating.AGAIN) {
    // 忘れた語は学習ステップへ戻す。間隔はゼロに戻さず記憶を残す
    next.step = 0;
    next.lapses = state.lapses + 1;
    next.ease = clampEase(state.ease - 0.2);
    next.intervalMs = Math.max(DAY, base * 0.4);
    return next;
  }

  if (rating === ReviewRating.HARD) {
    next.ease = clampEase(state.ease - 0.15);
    next.intervalMs = Math.min(MAX_INTERVAL_MS, base * 1.2);
    return next;
  }

  if (rating === ReviewRating.EASY) {
    next.ease = clampEase(state.ease + 0.15);
    next.intervalMs = Math.min(MAX_INTERVAL_MS, base * next.ease * 1.3);
    return next;
  }

  // GOOD
  next.intervalMs = Math.min(MAX_INTERVAL_MS, base * next.ease);
  return next;
}

/**
 * 履歴を頭から再生して現在の state を得る。
 *
 * これがあるおかげで ease / interval を Firestore に持たなくてよい。
 */
export function replay(history: ReviewSession[] | undefined): SrsState {
  let state = INITIAL_STATE;
  for (const h of history ?? []) {
    if (!h || typeof h.rating !== "number") continue;
    state = applyRating(state, h.rating, typeof h.timestamp === "number" ? h.timestamp : Date.now());
  }
  return state;
}

/**
 * 次回の出題時刻。
 *
 * 同じ日に保存した語が一斉に同じ日へ集まるのを避けるため、1 日以上の
 * 間隔には ±5% のばらつきを入れる（分単位の学習ステップには入れない）。
 */
export function dueAt(state: SrsState, from: number): number {
  if (state.step !== null) {
    const stepMs = LEARNING_STEPS_MS[Math.min(state.step, LEARNING_STEPS_MS.length - 1)];
    return from + stepMs;
  }
  const fuzz = 1 + (Math.random() - 0.5) * 0.1;
  return from + Math.max(DAY, Math.round(state.intervalMs * fuzz));
}

export interface ScheduleResult {
  nextReviewAt: number;
  state: SrsState;
  /** 同じセッション中にもう一度出すべきか（学習ステップの分単位の刻み） */
  requeueInSession: boolean;
  /** 人に見せる間隔の文字列。「10分後」「3日後」 */
  intervalLabel: string;
}

/** 同じセッション内で再出題する上限。これを越える間隔なら次回以降に回す。 */
const SESSION_REQUEUE_WINDOW_MS = 30 * MIN;

/**
 * 評価から次回日時までを一度に出す。UI とデータ更新の双方がこれを使う。
 */
export function schedule(
  history: ReviewSession[] | undefined,
  rating: ReviewRating,
  now = Date.now()
): ScheduleResult {
  const state = applyRating(replay(history), rating, now);
  const nextReviewAt = dueAt(state, now);
  const delta = nextReviewAt - now;

  return {
    nextReviewAt,
    state,
    requeueInSession: delta <= SESSION_REQUEUE_WINDOW_MS,
    intervalLabel: formatInterval(delta),
  };
}

/**
 * 評価ボタンに添える予告。押す前に「次いつ出るか」が見えると、
 * どの評価を押すべきかの判断がぶれない。
 */
export function previewIntervals(
  history: ReviewSession[] | undefined,
  now = Date.now()
): Record<ReviewRating, string> {
  const base = replay(history);
  const of = (rating: ReviewRating) => {
    const state = applyRating(base, rating, now);
    // 予告にばらつきを混ぜると押すたびに表示が変わるので、ここでは使わない
    const ms =
      state.step !== null
        ? LEARNING_STEPS_MS[Math.min(state.step, LEARNING_STEPS_MS.length - 1)]
        : Math.max(DAY, state.intervalMs);
    return formatInterval(ms);
  };

  return {
    [ReviewRating.AGAIN]: of(ReviewRating.AGAIN),
    [ReviewRating.HARD]: of(ReviewRating.HARD),
    [ReviewRating.GOOD]: of(ReviewRating.GOOD),
    [ReviewRating.EASY]: of(ReviewRating.EASY),
  };
}

export function formatInterval(ms: number): string {
  if (ms < 60 * 1000) return "すぐ";
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)}分後`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}時間後`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}日後`;
  if (days < 365) return `${Math.round(days / 30)}か月後`;
  return `${(days / 365).toFixed(1)}年後`;
}

/**
 * 何度も忘れている語。ふつうに間隔を伸ばしても抜けないので、
 * 別の覚え方（語源・例文・つづり）に切り替える合図として扱う。
 */
export function isLeech(word: SavedWord): boolean {
  return countAgain(word) >= LEECH_THRESHOLD;
}

export function countAgain(word: SavedWord): number {
  return (word.reviewHistory ?? []).filter((h) => h?.rating === ReviewRating.AGAIN).length;
}

/**
 * 定着の度合い（0..1）。ease と連続正解からの粗い指標。
 * ダッシュボードの「定着」表示に使う。
 */
export function retention(word: SavedWord): number {
  const state = replay(word.reviewHistory);
  if (state.reps === 0) return 0;
  if (state.step !== null) return Math.min(0.35, state.reps * 0.1);
  const byInterval = Math.min(1, state.intervalMs / (30 * DAY));
  const byEase = (state.ease - MIN_EASE) / (MAX_EASE - MIN_EASE);
  return Math.min(1, 0.35 + 0.65 * (byInterval * 0.6 + byEase * 0.4));
}
