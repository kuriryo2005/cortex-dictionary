/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  BookOpen,
  Plus,
  Trash2,
  Loader2,
  LogIn,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  BrainCircuit,
  Map as MapIcon,
  Download,
  Volume2,
  ClipboardPaste,
  Home,
  Tag as TagIcon,
  Sparkles,
  HelpCircle,
  X
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";
import { lookupWord, planNextReview, getCachedWord, fetchPhonetic, ApiError } from "./services/geminiService";
import { usePlan } from "./hooks/usePlan";
import { saveWords, SaveLimitError } from "./services/wordService";
import { useUsage } from "./hooks/useUsage";
import { UpgradeModal } from "./components/UpgradeModal";
import { LandingPage } from "./components/LandingPage";
import {
  TARGET_SCHEMA_VERSION,
  coerceWordDetail,
  normalizeExamples,
  normalizeWord,
} from "./lib/normalize";
import { WordDetail, SavedWord, DictionaryMode, ReviewRating, ReviewSession, UserStats, WordFilter } from "./types";
import { useReviewSession } from "./hooks/useReviewSession";
import { useDecks } from "./hooks/useDecks";
import { useEnrichQueue } from "./hooks/useEnrichQueue";
import { applyFilter, collectTags, dedupeTags, isFilterActive, loadFilter, saveFilter } from "./lib/filter";
import { nextStreak } from "./lib/stats";
import { isLeech, schedule } from "./lib/srs";
import { computeCycle, type StageKey } from "./lib/cycle";
import {
  formatPhonetic,
  isTtsAvailable,
  loadTtsSettings,
  onVoicesReady,
  speak,
} from "./lib/tts";
import { EtymologyGraph } from "./components/EtymologyGraph";
import { KnowledgeMap } from "./components/KnowledgeMap";
import { Wordbook } from "./components/Wordbook";
import { DataTransferModal } from "./components/DataTransferModal";
import { ReviewMode } from "./components/ReviewMode";
import { Dashboard } from "./components/Dashboard";
import { FirstRun } from "./components/FirstRun";
import { ServiceNotice } from "./components/ServiceNotice";
import { DeckManager } from "./components/DeckManager";
import { BulkExtractModal } from "./components/BulkExtractModal";
import { StartupGuide, hasSeenGuide } from "./components/StartupGuide";
import { CoachMarks, hasSeenCoach, markCoachSeen } from "./components/CoachMarks";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { Skeleton } from "./components/ui/skeleton";
import { ScrollArea } from "./components/ui/scroll-area";
import { Toaster, toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { auth, db } from "./firebase";
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User as FirebaseUser
} from "firebase/auth";
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  deleteDoc,
  doc,
  orderBy,
  updateDoc,
  getDoc,
  setDoc
} from "firebase/firestore";

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  toast.error("データベースエラーが発生しました。");
}

/** サイドバーの1ページ分の件数（実装仕様書 F2-c） */
const SIDEBAR_PAGE_SIZE = 100;

function WordSkeleton() {
  return (
    <div className="max-w-4xl mx-auto flex flex-col h-full animate-pulse">
      <div className="flex justify-between items-start mb-10">
        <div className="space-y-3">
          <Skeleton className="h-14 w-64 rounded-none" />
          <Skeleton className="h-4 w-40 rounded-none" />
        </div>
        <Skeleton className="h-6 w-28 rounded-none" />
      </div>
      <div className="max-w-3xl space-y-14">
        <Skeleton className="h-20 w-full rounded-none" />
        <Skeleton className="h-28 w-full rounded-none" />
        <Skeleton className="h-40 w-full rounded-none" />
        <Skeleton className="h-40 w-full rounded-none" />
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WordDetail | null>(null);
  const [savedWords, setSavedWords] = useState<SavedWord[]>([]);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "home" | "detail" | "flashcards" | "map" | "wordbook"
  >("home");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [dictionaryMode, setDictionaryMode] = useState<DictionaryMode>(DictionaryMode.GENERAL);
  /** サイドバーに描画する件数。全件を一度に DOM へ出さない（実装仕様書 F2-c）。 */
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_PAGE_SIZE);
  const [suggestions, setSuggestions] = useState<SavedWord[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isDataModalOpen, setIsDataModalOpen] = useState(false);
  const [ttsAvailable, setTtsAvailable] = useState(isTtsAvailable);
  const [isDeckManagerOpen, setIsDeckManagerOpen] = useState(false);
  const [isExtractOpen, setIsExtractOpen] = useState(false);
  const [filter, setFilter] = useState<WordFilter>(loadFilter);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  /** 絞り込みを開いているか。既定は畳む（単語一覧の高さを優先する） */
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  /** 初回のスタートアップガイド。スキップ・完了のどちらでも二度と自動では出さない */
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [isCoachOpen, setIsCoachOpen] = useState(false);

  const decks = useDecks(user?.uid ?? null);

  // 絞り込みは一覧・復習・マップで同じ関数を通す。
  // 「一覧では絞れているのに復習には全部出る」というズレを防ぐため（F7）。
  const filteredWords = applyFilter(savedWords, filter);
  const allTags = collectTags(savedWords);

  const review = useReviewSession(savedWords);
  // 「今日のサイクル」。絞り込みを効かせた集合から計算する（一覧・復習とズレないように）
  const cycle = useMemo(() => computeCycle(filteredWords), [filteredWords]);
  const enriching = useEnrichQueue(savedWords, !!user);

  // 表示中の単語が既にリストにある（＝保存済みドキュメントを開いている、
  // または同じ綴りが別途保存済み）かどうか。大文字小文字は区別しない。
  const isResultSaved = useMemo(() => {
    if (!result) return false;
    if ((result as SavedWord).id) return true;
    const lower = result.word.trim().toLowerCase();
    return savedWords.some((w) => w.word.trim().toLowerCase() === lower);
  }, [result, savedWords]);

  useEffect(() => saveFilter(filter), [filter]);

  // 音声リストは非同期に読み込まれる。埋まったら再判定して再生ボタンを出す。
  useEffect(() => onVoicesReady(() => setTtsAvailable(isTtsAvailable())), []);

  // Auth state listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  /**
   * 初回ログイン時に一度だけガイドを出す。
   *
   * ランディングページの裏で開いてしまわないよう、user が入ってから判定する。
   * 既読の判定は localStorage なので、消せばまた出る（出し直したい人向け）。
   */
  /**
   * 初めて使う人には、スライドショーではなく実物を指すコーチマークを出す。
   * 読んで閉じた瞬間に忘れるのは、説明と「どこを押すか」が結びつかないため。
   * 一度見た人（旧ガイドの既読者を含む）には出さない。
   */
  useEffect(() => {
    if (!user) return;
    if (hasSeenCoach()) return;
    if (hasSeenGuide()) {
      // 旧ガイドを見終わっている人にいまさら出すと邪魔なので、見たことにする
      markCoachSeen();
      return;
    }
    // 画面が組み上がってから測りたいので1フレーム待つ
    const id = requestAnimationFrame(() => setIsCoachOpen(true));
    return () => cancelAnimationFrame(id);
  }, [user]);

  // 課金プラン。取得に失敗しても free として動くので UI は壊れない。
  const { status: planStatus, isPro, refresh: refreshPlan } = usePlan(user);
  // 無料プランの「今日あと何語」。上限に対する納得感と Pro 検討のきっかけになる。
  const { usage, refresh: refreshUsage } = useUsage(user, planStatus);
  // 無料プランの本当の壁は「保存は30語まで」。削除すれば枠は戻る。
  // 検索の残りと同じ 30 という数字なので、どちらの話かを文言で区別する。
  const wordLimit = planStatus.wordLimit;
  const wordsLeft =
    wordLimit === null ? Infinity : Math.max(0, wordLimit - savedWords.length);
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<string | undefined>(undefined);

  /** 上限に当たったときなど、理由つきでアップグレード画面を開く。 */
  const openUpgrade = (reason?: string) => {
    setUpgradeReason(reason);
    setIsUpgradeOpen(true);
  };

  /**
   * 語源ページから `/?w=<単語>` で来た人を、その単語の検索結果まで運ぶ。
   *
   * 検索でたどり着いた人は、特定の単語を読んでいる途中でここに来る。
   * ログイン後に空の画面を見せると、何を調べに来たのか分からなくなる。
   * 一度だけ実行して、URL からは取り除く（リロードで再実行しない）。
   */
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (!user || deepLinkDone.current) return;

    const params = new URLSearchParams(window.location.search);
    const word = (params.get("w") ?? "").trim().toLowerCase();
    if (!word || !/^[a-z][a-z' -]{1,63}$/.test(word)) return;

    deepLinkDone.current = true;
    params.delete("w");
    const query = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));

    setSearchQuery(word);
    void handleSearch(undefined, word);
  }, [user]);

  /**
   * 英文からの一括抽出は Pro 限定。サーバー側でも弾いているが、押してから
   * エラーを見せるより、押した瞬間に案内を出すほうが伝わる。
   */
  const openExtract = () => {
    if (!isPro) {
      openUpgrade("英文からの一括抽出は Pro プランの機能です。");
      return;
    }
    setIsExtractOpen(true);
  };

  /**
   * 単語一覧の購読（実装仕様書 F2-b）。
   *
   * orderBy は以前「インデックス回避のため」外されていた。複合インデックス
   * （firestore.indexes.json）を作ったので復活させるが、インデックスの作成は
   * デプロイとは別作業なので、未作成の環境では failed-precondition で
   * 一覧が丸ごと出なくなってしまう。それを避けるため、失敗したら並べ替え無しで
   * 購読し直す。
   */
  useEffect(() => {
    if (!user) {
      setSavedWords([]);
      return;
    }

    let unsubscribe: () => void = () => {};
    let cancelled = false;

    const subscribe = (ordered: boolean) => {
      const q = ordered
        ? query(collection(db, "words"), where("userId", "==", user.uid), orderBy("timestamp", "desc"))
        : query(collection(db, "words"), where("userId", "==", user.uid));

      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          // Firestore から読んだデータは例外なく normalizeWord を通す（鉄則 R3）。
          // v1 の既存データに tags や examplePairs を補うのはここだけの責務。
          const words = snapshot.docs.map((d) => normalizeWord(d.id, d.data()));
          // ordered の場合は既にサーバー側で並んでいるが、フォールバック時の
          // 順序を保証するために念のため揃える（43件程度では実測差が出ない）。
          words.sort((a, b) => b.timestamp - a.timestamp);
          setSavedWords(words);
        },
        (error) => {
          if (ordered && (error as { code?: string }).code === "failed-precondition") {
            console.warn("複合インデックスが未作成のため、並べ替え無しで購読し直します。", error);
            // Firestore の Watch ストリームが自身のエラーコールバックの中で
            // 同期的に unsubscribe → 新しい listener を張り直すと、SDK 内部の
            // target 管理が再入して壊れ、INTERNAL ASSERTION FAILED (b815) で
            // クラッシュする。コールバックのスタックを抜けてから張り直す。
            setTimeout(() => {
              if (cancelled) return;
              unsubscribe();
              subscribe(false);
            }, 0);
            return;
          }
          handleFirestoreError(error, OperationType.LIST, "words");
        }
      );
    };

    subscribe(true);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user]);

  // 連続学習日数だけは単語一覧から計算できないので Firestore に置いてある（F6）。
  // 読み取りはログイン時の1回だけ。
  useEffect(() => {
    if (!user) {
      setUserStats(null);
      return;
    }
    let alive = true;
    getDoc(doc(db, "user_stats", user.uid))
      .then((snap) => {
        if (alive) setUserStats(snap.exists() ? (snap.data() as UserStats) : null);
      })
      .catch((e) => console.warn("学習統計の読み取りに失敗しました:", e));
    return () => {
      alive = false;
    };
  }, [user]);

  /** 今日まだ記録していなければ連続日数を進める。1日1回だけ書き込む。 */
  const touchStreak = () => {
    if (!user) return;
    const today = format(Date.now(), "yyyy-MM-dd");
    if (userStats?.lastStudiedOn === today) return;

    const updated = { ...nextStreak(userStats, new Date()), userId: user.uid };
    setUserStats(updated);
    setDoc(doc(db, "user_stats", user.uid), updated, { merge: true }).catch((e) =>
      console.warn("学習統計の保存に失敗しました:", e)
    );
  };

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      toast.success("ログインしました");
    } catch (error) {
      console.error(error);
      toast.error("ログインに失敗しました");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      toast.info("ログアウトしました");
    } catch (error) {
      console.error(error);
    }
  };

  /**
   * 評価を記録して次のカードへ（実装仕様書 F3）。
   *
   * 進行はキュー側が同期的に進めるので、旧実装のような setTimeout での
   * インデックス操作は無い。DB 書き込みは待たせない（UI を止めない）。
   */
  const handleReview = (rating: ReviewRating) => {
    const word = review.grade(rating);
    if (!word || !user) return;

    touchStreak();

    const now = Date.now();
    const session: ReviewSession = { rating, timestamp: now };
    const updatedHistory = [...(word.reviewHistory || []), session];

    // 次回日時はローカルで決める（src/lib/srs.ts）。
    // 以前は毎回 /api/review-analysis を待っていたため、評価のたびに課金と
    // 数秒の遅延が発生し、通信に失敗すると nextReviewAt が更新されないまま
    // その語が永久に期限超過へ残っていた。計算は同期で、失敗しない。
    const plan = schedule(word.reviewHistory, rating, now);

    // 学習ステップ（1分 / 10分）の語は、その日のうちにもう一度出す。
    // 翌日まで待たずに詰めて触るのが、初回の定着にいちばん効く。
    if (plan.requeueInSession) review.requeue(word.id);

    updateDoc(doc(db, "words", word.id), {
      reviewHistory: updatedHistory,
      nextReviewAt: plan.nextReviewAt,
      updatedAt: now,
    }).catch((error) => console.error("復習結果の保存に失敗しました:", error));

    // AI の出番は日付決めから外し、「何度やっても抜けない語」の原因分析だけに絞る。
    // 全評価で呼んでいた頃と比べて呼び出し回数が二桁減る。
    const graded = { ...word, reviewHistory: updatedHistory };
    if (isLeech(graded) && !word.aiAnalysis) {
      (async () => {
        try {
          const { aiAnalysis } = await planNextReview(graded);
          if (aiAnalysis) {
            await updateDoc(doc(db, "words", word.id), { aiAnalysis, updatedAt: Date.now() });
          }
        } catch (error) {
          console.debug("苦手分析の生成をスキップしました:", error);
        }
      })();
    }
  };

const handleSearch = async (e?: React.FormEvent, overrideQuery?: string) => {
    e?.preventDefault();
    const query = (overrideQuery || searchQuery).trim();
    if (!query) return;

    // 「a」のような断片や記号だけの入力は、無駄な AI 呼び出しを避けるため
    // ネットワークに出す前にここで弾く（api/lookup.ts の同じチェックと対）。
    if (query.length < 2 || !/^[a-z][a-z' -]*$/i.test(query)) {
      toast.error("英単語として認識できない入力です。");
      return;
    }

    // NOTE: 以前ここに search_history への addDoc があったが、firestore.rules に
    // search_history のルールが無く、全書き込みが PERMISSION_DENIED で失敗していた
    // （エラーは .catch で握り潰されていた）。検索履歴が必要になった時点で
    // ルールとあわせて設計し直す。

    const cached = getCachedWord(query, dictionaryMode);
    if (cached) {
      setResult(cached);
      setActiveTab("detail");
      setSuggestions([]);
      setShowSuggestions(false);
      return; 
    }

    setLoading(true);
    setIsStreaming(true);
    setResult(null);
    setSuggestions([]);
    setShowSuggestions(false);
    setActiveTab("detail");

    try {
      const detail = await lookupWord(query, dictionaryMode, (partial) => {
        // 意味が届いた時点で描画を始める。全項目が揃うのを待たない。
        if (!partial?.meaning) return;
        setResult(coerceWordDetail(partial));
        setLoading(false);
      });
      setResult(detail);

      // 綴りミスが自動修正された場合は一言添える（正しい綴りは detail.word に入っている）
      if (detail.word && detail.word.trim().toLowerCase() !== query.toLowerCase()) {
        setSearchQuery(detail.word);
        toast.info(`「${query}」を「${detail.word}」として検索しました`);
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "単語の検索に失敗しました。";
      // 無料プランの上限に当たった場合は、トーストで流さずアップグレード画面を出す
      if (error instanceof ApiError && error.status === 429 && !isPro) {
        openUpgrade(message);
      } else {
        toast.error(message);
      }
      setResult(null);
    } finally {
      setLoading(false);
      setIsStreaming(false);
      // 上限カウンタはサーバーが進めるので、検索後に読み直す
      void refreshUsage();
    }
  };
  // Debounced search suggestions
  useEffect(() => {
    if (searchQuery.length > 1) {
      const filtered = savedWords.filter(w => 
        w.word.toLowerCase().includes(searchQuery.toLowerCase())
      ).slice(0, 5);
      setSuggestions(filtered);
      setShowSuggestions(true);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, [searchQuery, savedWords]);

  /**
   * 発音記号の遅延補完（実装仕様書 F4）。
   *
   * 既存の保存済み単語には phonetic が無い。鉄則 R2 により一括更新はしないので、
   * 詳細を開いたときに1件だけ取得して書き戻す。失敗しても UI には出さない
   * （無くても困らない付加情報なので、エラーで邪魔をしない）。
   */
  const phoneticAttempts = useRef<Set<string>>(new Set());

  useEffect(() => {
    const saved = result as SavedWord | null;
    if (!user || !saved?.id || saved.phonetic) return;
    if (phoneticAttempts.current.has(saved.id)) return;
    phoneticAttempts.current.add(saved.id);

    (async () => {
      try {
        const phonetic = await fetchPhonetic(saved.word);
        await updateDoc(doc(db, "words", saved.id), { phonetic, updatedAt: Date.now() });
        setResult((prev) =>
          prev && (prev as SavedWord).id === saved.id ? { ...prev, phonetic } : prev
        );
      } catch (e) {
        console.debug("発音記号の補完をスキップしました:", e);
      }
    })();
  }, [result, user]);

  // Re-search when mode changes if there's a query
  useEffect(() => {
    if (searchQuery.trim() && activeTab === 'detail') {
      handleSearch();
    }
  }, [dictionaryMode]);

  const saveWord = async () => {
    if (!result || !user) {
      if (!user) toast.error("ログインが必要です");
      return;
    }
    if (isResultSaved) {
      toast.info(`「${result.word}」は既にリストにあります`);
      return;
    }

    try {
      const now = Date.now();
      // id と examplePairs は読み取り時に作る派生値。書き戻さない
      const { id: _id, examplePairs: _pairs, ...detail } = result as unknown as Record<
        string,
        unknown
      >;

      const wordData = {
        ...detail,
        userId: user.uid,
        timestamp: now,
        mode: dictionaryMode,
        // v3 のフィールド。新規保存分だけ付ける（既存ドキュメントは書き換えない）
        schemaVersion: TARGET_SCHEMA_VERSION,
        wordLower: result.word.trim().toLowerCase(),
        updatedAt: now,
      };
      // 保存はサーバー経由。無料プランの上限はここでしか強制できない
      const { saved, limit } = await saveWords([wordData], "search");
      if (limit !== null && saved !== null) {
        const left = Math.max(0, limit - saved);
        toast.success(
          left === 0
            ? `${result.word} を追加しました（無料プランの上限 ${limit} 語に達しました）`
            : `${result.word} を追加しました（あと ${left} 語）`
        );
      } else {
        toast.success(`${result.word} をリストに追加しました！`);
      }
    } catch (error) {
      // 上限に当たったときは、エラーを流すよりアップグレード画面を出すほうが伝わる
      if (error instanceof SaveLimitError) {
        if (error.upgradable) openUpgrade(error.message);
        else toast.error(error.message);
        return;
      }
      handleFirestoreError(error, OperationType.CREATE, "words");
    }
  };

  const deleteWord = async (id: string) => {
    try {
      await deleteDoc(doc(db, "words", id));
      toast.info("単語を削除しました。");
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `words/${id}`);
    }
  };

  /**
   * 復習を開始する。
   *
   * デッキ/タグの絞り込みを先に効かせてから、ダッシュボードで押された
   * ブロックに応じて対象をさらに絞る。キューの構築自体は useReviewSession
   * が担当する（並び順とシャッフルはそちら）。
   */
  const startFlashcards = (scope: "due" | "overdue" | "fresh" | "all" = "all") => {
    const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const dayEnd = new Date(new Date().setHours(23, 59, 59, 999)).getTime();

    const pool = filteredWords.filter((w) => {
      if (scope === "all") return true;
      if (scope === "fresh") return w.nextReviewAt == null;
      if (scope === "overdue") return w.nextReviewAt != null && w.nextReviewAt < dayStart;
      // due: 期限超過と本日分、および未復習
      return w.nextReviewAt == null || w.nextReviewAt <= dayEnd;
    });

    if (pool.length === 0) {
      toast.error(
        isFilterActive(filter)
          ? "この絞り込みに該当する単語がありません。"
          : "復習できる単語がありません。"
      );
      return;
    }

    review.start(pool, { onlyDue: false });
    setActiveTab("flashcards");
    setIsSidebarOpen(false);
  };

  /**
   * 「今日のサイクル」の段を開始する（src/lib/cycle.ts）。
   *
   * 並びはサイクル側が決めた順のまま出す（startExact）。ここでシャッフルし直すと
   * 「導入 → 想起」で同じ語を続けて見せる狙いが崩れる。
   */
  const startStage = (key: StageKey) => {
    const stage = cycle.stages.find((s) => s.key === key);
    if (!stage || stage.words.length === 0) return;

    // 定着の段だけは、今日の語と古い語を混ぜて出す（インターリービング）。
    // 同じ日に入れた語だけを並べると、前後の文脈で思い出せてしまう。
    const pool =
      key === "mix"
        ? [...stage.words, ...cycle.stages[1].words].filter(
            (w, i, list) => list.findIndex((o) => o.id === w.id) === i
          )
        : stage.words;

    review.startExact(pool, key === "recall" ? "type" : "flip");
    setActiveTab("flashcards");
    setIsSidebarOpen(false);
  };

  const exitFlashcards = () => {
    review.end();
    setActiveTab("home");
  };

  /** 単語詳細でタグを付け外しする（F7）。既存単語は初めてここで更新される。 */
  const updateTags = async (word: SavedWord, tags: string[]) => {
    try {
      await updateDoc(doc(db, "words", word.id), {
        tags: dedupeTags(tags),
        updatedAt: Date.now(),
      });
      setResult((prev) =>
        prev && (prev as SavedWord).id === word.id ? { ...prev, tags: dedupeTags(tags) } : prev
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `words/${word.id}`);
    }
  };

  /** 単語をデッキへ移す（F7）。 */
  const moveToDeck = async (word: SavedWord, deckId: string | null) => {
    try {
      await updateDoc(doc(db, "words", word.id), { deckId, updatedAt: Date.now() });
      setResult((prev) =>
        prev && (prev as SavedWord).id === word.id ? { ...prev, deckId } : prev
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `words/${word.id}`);
    }
  };

  // 表示は先頭 N 件だけに絞る（実装仕様書 F2-c）。
  // データ自体はローカルキャッシュ上に全件あり、復習・ナレッジマップ・
  // 書き出しはいずれも savedWords 全体を参照するので機能は制限されない。
  const visibleWords = filteredWords.slice(0, visibleCount);
  const hasMore = filteredWords.length > visibleWords.length;

  // Group words by date
  const groupedWords = visibleWords.reduce((acc, word) => {
    const date = format(word.timestamp, "yyyy/MM/dd");
    if (!acc[date]) acc[date] = [];
    acc[date].push(word);
    return acc;
  }, {} as Record<string, SavedWord[]>);

  const sortedDates = Object.keys(groupedWords).sort((a, b) => b.localeCompare(a));

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f8f9fa]">
        <Loader2 className="w-8 h-8 animate-spin text-[#2A5CFF]" />
      </div>
    );
  }

  // 未ログインではアプリ本体を描画しない。
  // 検索は AI 生成を伴うため、認証なしに叩ける経路を残さない（実装仕様書 F1）。
  // 代わりに、何ができるアプリなのかを伝えるランディングページを出す。
  if (!user) {
    return (
      <>
        <LandingPage onLogin={handleLogin} />
        <Toaster position="bottom-right" richColors />
      </>
    );
  }

  return (
    <div className="flex h-screen bg-white overflow-hidden relative print:h-auto print:overflow-visible print:block">
      {/* Mobile Toggle */}
      <div className="lg:hidden fixed bottom-6 right-6 z-[100] print:hidden">
        <button
          type="button"
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="w-12 h-12 bg-[#1A1C1E] text-white flex items-center justify-center"
        >
          {isSidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <BookOpen className="w-5 h-5" />}
        </button>
      </div>

      {/* Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="lg:hidden fixed inset-0 bg-black/40 backdrop-blur-sm z-[80]"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={`
        fixed lg:relative z-[90] h-full
        w-[280px] md:w-[320px] 
        bg-white border-r border-[#EAECEF] flex flex-col transition-transform duration-300 ease-out
        print:hidden
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        {/* 上段。常に出す。ここに置くものを増やすと一覧の高さがそのまま削れる */}
        <div className="px-6 pt-6 pb-4 shrink-0">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h1 className="text-base font-black tracking-tight">Cortex Dictionary</h1>
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setIsSidebarOpen(false)}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
          </div>

          <form onSubmit={handleSearch} className="relative group" data-coach="search">
            <Input
              placeholder="単語を検索"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => searchQuery.length > 1 && setShowSuggestions(true)}
              className="field h-10 text-sm"
            />
            {loading && (
              <div className="absolute right-0 top-2.5">
                <Loader2 className="w-4 h-4 animate-spin text-[#2A5CFF]" />
              </div>
            )}

            <AnimatePresence>
              {showSuggestions && suggestions.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="absolute top-full left-0 right-0 z-50 bg-white shadow-lg py-2"
                >
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        setSearchQuery(s.word);
                        handleSearch(undefined, s.word);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-[#F5F6F7] transition-colors flex items-center justify-between"
                    >
                      <span className="text-xs font-bold text-[#1A1C1E]">{s.word}</span>
                      <span className="text-[10px] text-[#8A9199] truncate ml-4">{s.meaning.slice(0, 15)}</span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </form>

          {/* 検索モード。検索欄のすぐ下に小さく置く（一覧の高さを食わない） */}
          <div className="flex gap-4 mt-2" data-coach="mode">
            {[
              { mode: DictionaryMode.GENERAL, label: "一般" },
              { mode: DictionaryMode.ACADEMIC, label: "学術" },
            ].map(({ mode, label }) => (
              <button
                key={label}
                type="button"
                onClick={() => setDictionaryMode(mode)}
                className={`text-[11px] font-bold pb-0.5 border-b transition-colors ${
                  dictionaryMode === mode
                    ? "text-[#1A1C1E] border-[#1A1C1E]"
                    : "text-[#8A9199] border-transparent hover:text-[#1A1C1E]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/*
          ナビゲーション。
          以前は高さ 36px のボタンを 5 行に積んでいて、それだけで 180px あった。
          サイドバーの上半分が操作系で埋まり、肝心の単語一覧が数行しか見えない
          原因になっていたので、2 列に詰めて 3 行に収める。
        */}
        <nav className="px-6 pb-3 shrink-0 grid grid-cols-2 gap-x-3" data-coach="nav">
          {[
            { key: "wordbook", icon: BookOpen, label: "単語帳", onClick: () => setActiveTab("wordbook") },
            { key: "home", icon: Home, label: "今日の学習", onClick: () => setActiveTab("home") },
            { key: "flashcards", icon: BrainCircuit, label: "単語カード", onClick: () => startFlashcards() },
            { key: "map", icon: MapIcon, label: "つながり", onClick: () => setActiveTab("map") },
            { key: "extract", icon: ClipboardPaste, label: "英文から追加", onClick: openExtract },
          ].map(({ key, icon: Icon, label, onClick }) => (
            <button
              key={key}
              type="button"
              onClick={onClick}
              className={`flex items-center gap-2 h-8 text-[11px] font-bold transition-colors ${
                activeTab === key ? "text-[#2A5CFF]" : "text-[#656E77] hover:text-[#1A1C1E]"
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav>

        {/*
          絞り込み。既定では畳んでおく。
          デッキの select とタグの一覧を常に出していると、タグが増えるほど
          一覧の高さが削られていった。効いているかどうかは見出しの点で示す。
        */}
        <div className="px-6 pb-3 shrink-0 border-b border-[#EAECEF]">
          <button
            type="button"
            onClick={() => setIsFilterOpen((v) => !v)}
            className="w-full flex items-center justify-between h-7 text-[11px] font-bold text-[#8A9199] hover:text-[#1A1C1E] transition-colors"
          >
            <span className="flex items-center gap-2">
              絞り込み
              {isFilterActive(filter) && <span className="w-1.5 h-1.5 rounded-full bg-[#2A5CFF]" />}
            </span>
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${isFilterOpen ? "rotate-180" : ""}`}
            />
          </button>

          {isFilterOpen && (
            <div className="pt-2">
              <div className="flex gap-1.5 mb-2">
                <select
                  value={filter.deckId === undefined ? "__all" : filter.deckId ?? "__none"}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFilter((f) => ({
                      ...f,
                      deckId: v === "__all" ? undefined : v === "__none" ? null : v,
                    }));
                    setVisibleCount(SIDEBAR_PAGE_SIZE);
                  }}
                  className="flex-1 h-8 bg-transparent border-0 border-b border-[#E5E7EB] rounded-none text-[11px] font-bold text-[#1A1C1E] focus:outline-none"
                >
                  <option value="__all">すべてのデッキ</option>
                  <option value="__none">未分類</option>
                  {decks.decks.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setIsDeckManagerOpen(true)}
                  title="デッキを管理"
                  className="h-8 shrink-0 text-[11px] font-bold text-[#8A9199] hover:text-[#2A5CFF] transition-colors"
                >
                  管理
                </button>
              </div>

              {allTags.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1.5 max-h-24 overflow-y-auto">
                  {allTags.slice(0, 12).map(({ tag, count }) => {
                    const active = filter.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() =>
                          setFilter((f) => ({
                            ...f,
                            tags: active
                              ? f.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
                              : [...f.tags, tag],
                          }))
                        }
                        className={`text-[11px] font-bold transition-colors ${
                          active
                            ? "text-[#2A5CFF] underline underline-offset-4"
                            : "text-[#8A9199] hover:text-[#1A1C1E]"
                        }`}
                      >
                        {tag} <span className="opacity-50">{count}</span>
                      </button>
                    );
                  })}
                  {isFilterActive(filter) && (
                    <button
                      type="button"
                      onClick={() => setFilter({ tags: [] })}
                      className="text-[11px] font-bold text-[#8A9199] hover:text-red-500 flex items-center gap-1"
                    >
                      <X className="w-3 h-3" />
                      解除
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 中断したセッションの再開（実装仕様書 F3）。リロードやタブ移動で
            進行が失われないように localStorage から復元する。 */}
        {!review.session && review.resumable && (
          <div className="px-6 py-3 shrink-0 border-b border-[#EAECEF] flex items-center justify-between gap-3">
            <p className="text-[11px] text-[#656E77] leading-snug min-w-0">
              中断した復習 {review.resumable.index} / {review.resumable.queue.length} 枚
            </p>
            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => {
                  review.resume();
                  setActiveTab("flashcards");
                }}
                className="text-[11px] font-bold text-[#2A5CFF] border-b border-[#2A5CFF]"
              >
                再開
              </button>
              <button
                type="button"
                onClick={review.discardResumable}
                className="text-[11px] font-bold text-[#8A9199] hover:text-red-500"
              >
                破棄
              </button>
            </div>
          </div>
        )}

        {/*
          単語一覧。
          min-h を置いているのは、上の操作系が縦に伸びたときに flex-1 が
          ゼロ近くまで潰れて、記録した単語が 1〜2 行しか見えなくなるのを
          防ぐため。潰れる代わりにサイドバー側がスクロールする。
        */}
        <ScrollArea className="flex-1 min-h-[35vh]">
          <div className="px-6 pb-6 pt-3">
            {!user ? (
              <div className="py-10">
                <p className="text-xs text-[#656E77] mb-4">保存するにはログインが必要です</p>
                <button type="button" onClick={handleLogin} className="btn-quiet h-9 px-0 text-xs">
                  ログイン
                </button>
              </div>
            ) : filteredWords.length === 0 ? (
              <div className="py-10">
                <p className="text-xs text-[#8A9199]">
                  {isFilterActive(filter)
                    ? "この絞り込みに該当する単語はありません"
                    : "保存された単語はありません"}
                </p>
              </div>
            ) : (
              <div>
                <p className="text-[10px] font-bold text-[#8A9199] mb-3 tabular-nums">
                  {filteredWords.length} 語
                </p>
                {sortedDates.map(date => (
                  <div key={date} className="mb-7 last:mb-0">
                    {/* 日付は貼り付けておく。長い一覧でも、いまどの日を見ているか分かる */}
                    <h3 className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm -mx-6 px-6 py-1.5 text-[10px] font-bold text-[#8A9199] uppercase tracking-[0.12em] mb-2">
                      {date}
                    </h3>
                    <div>
                      {groupedWords[date].map((word) => {
                        const selected = result?.word === word.word && activeTab === "detail";
                        return (
                          <div
                            key={word.id}
                            onClick={() => {
                              setResult(word);
                              setActiveTab("detail");
                            }}
                            className="group py-2.5 cursor-pointer border-t border-[#F1F3F5] first:border-t-0"
                          >
                            <div className="flex justify-between items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <div className={`font-bold text-sm break-words ${selected ? "text-[#2A5CFF]" : "text-[#1A1C1E]"}`}>
                                  {word.word}
                                </div>
                                <div className="text-[11px] text-[#656E77] line-clamp-2 mt-0.5 leading-snug">
                                  {word.meaning}
                                </div>
                                {word.nextReviewAt && (
                                  <div className={`mt-1 text-[10px] ${word.nextReviewAt < Date.now() ? "text-red-500" : "text-[#8A9199]"}`}>
                                    復習 {format(word.nextReviewAt, "MM/dd HH:mm", { locale: ja })}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteWord(word.id);
                                }}
                                title="削除"
                                className="w-6 h-6 shrink-0 flex items-center justify-center text-[#C9CDD2] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {hasMore && (
                  <button
                    type="button"
                    onClick={() => setVisibleCount((n) => n + SIDEBAR_PAGE_SIZE)}
                    className="mt-6 text-xs font-bold text-[#2A5CFF] border-b border-[#2A5CFF]"
                  >
                    さらに表示（残り {filteredWords.length - visibleWords.length} 件）
                  </button>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {user && (
          <div className="px-6 py-4 border-t border-[#EAECEF] bg-white space-y-3">
            {/* 一括取り込みした単語の詳細生成の進捗（F5） */}
            {enriching.remaining > 0 && (
              <div className="flex items-center gap-2">
                <Loader2 className="w-3 h-3 text-[#2A5CFF] animate-spin shrink-0" />
                <span className="text-[10px] font-bold text-[#2A5CFF]">
                  詳細を生成中 残り {enriching.remaining} 語
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => openUpgrade()}
              className={`flex items-start gap-2.5 text-left text-xs font-bold transition-colors ${
                isPro ? "text-[#656E77] hover:text-[#1A1C1E]" : "text-[#2A5CFF] hover:text-[#1A3FCC]"
              }`}
            >
              <Sparkles className="w-4 h-4 shrink-0 mt-px" />
              {isPro ? (
                <span>Pro プラン（契約中）</span>
              ) : (
                <span>
                  Pro にアップグレード
                  {/*
                    無料プランの本当の壁は「保存は30語まで」のほう。
                    検索の残り（1日30語）を出していたら、どちらも 30 で紛らわしく、
                    「無料枠は30語」の意味が伝わらなかった。
                    枠は削除すれば戻るので、残り語数で出すのが実態に合う。
                  */}
                  <span
                    className={`block font-normal mt-0.5 ${
                      wordsLeft === 0
                        ? "text-red-500"
                        : wordsLeft <= 3
                          ? "text-[#EA580C]"
                          : "text-[#8A9199]"
                    }`}
                  >
                    {wordsLeft === 0
                      ? `保存は上限の ${wordLimit} 語です（無料枠）`
                      : `保存はあと ${wordsLeft} 語（無料枠）`}
                  </span>
                  {/*
                    検索の残りは常に出す。隠していたら「検索は無限にできるの？」と
                    誤解された。上限は保存数と検索数の2本立てで、どちらもある。
                  */}
                  <span
                    className={`block font-normal mt-0.5 ${
                      usage.remaining === 0
                        ? "text-red-500"
                        : usage.remaining <= 5
                          ? "text-[#EA580C]"
                          : "text-[#8A9199]"
                    }`}
                  >
                    新しい検索は今日あと {usage.remaining} 語
                  </span>
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setIsDataModalOpen(true)}
              className="flex items-center gap-2.5 text-xs font-bold text-[#656E77] hover:text-[#1A1C1E] transition-colors"
            >
              <Download className="w-4 h-4" />
              データの書き出し / 復元
            </button>
            {/* ガイドはスキップできる代わりに、いつでもここから開き直せる */}
            <button
              type="button"
              onClick={() => setIsGuideOpen(true)}
              className="flex items-center gap-2.5 text-xs font-bold text-[#656E77] hover:text-[#1A1C1E] transition-colors"
            >
              <HelpCircle className="w-4 h-4" />
              使い方
            </button>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <img src={user.photoURL || ""} alt="" className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" />
                <span className="text-xs font-bold truncate max-w-[140px]">{user.displayName}</span>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                title="ログアウト"
                className="w-7 h-7 flex items-center justify-center text-[#8A9199] hover:text-red-500"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 h-full overflow-y-auto bg-white p-6 md:p-10 lg:p-16 print:h-auto print:overflow-visible print:p-0">
        {/* 生成が止まっているときだけ出る。検索してエラーを踏む前に伝える */}
        <div className="print:hidden">
          <ServiceNotice />
        </div>
        <AnimatePresence mode="wait">
          {activeTab === "home" && savedWords.length === 0 ? (
            // 保存が1語も無い人にはダッシュボードではなく最初の一歩を出す。
            // 空の数値を並べても何をすればいいか伝わらない。
            <motion.div key="firstrun" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <FirstRun
                onPick={(word) => {
                  setSearchQuery(word);
                  void handleSearch(undefined, word);
                }}
              />
            </motion.div>
          ) : activeTab === "home" ? (
            <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Dashboard
                words={filteredWords}
                decks={decks.decks}
                stats={userStats}
                enriching={enriching}
                cycle={cycle}
                onStartReview={startFlashcards}
                onStartStage={startStage}
                onWordClick={(w) => {
                  setResult(w);
                  setActiveTab("detail");
                }}
                onOpenExtract={openExtract}
                onSelectDeck={(deckId) => {
                  setFilter((f) => ({ ...f, deckId }));
                  setVisibleCount(SIDEBAR_PAGE_SIZE);
                }}
              />
            </motion.div>
          ) : activeTab === "map" ? (
             <motion.div
               key="map"
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: -10 }}
               className="h-full"
             >
               <KnowledgeMap
                 words={filteredWords}
                 onWordClick={(w) => {
                   setResult(w);
                   setActiveTab("detail");
                 }}
                 onSearchWord={(word) => {
                   setSearchQuery(word);
                   handleSearch(undefined, word);
                   setActiveTab("detail");
                 }}
                 onReviewWords={(list) => {
                   // 房や孤立語をそのまま出す。並び替えないのは、
                   // 意味の近い語を続けて見せて弁別させるため
                   if (review.startExact(list) > 0) {
                     setActiveTab("flashcards");
                     setIsSidebarOpen(false);
                   }
                 }}
                 onStoryGenerated={async (wordId, story) => {
                   try {
                     await updateDoc(doc(db, "words", wordId), {
                       etymologyStory: story,
                       updatedAt: Date.now(),
                     });
                   } catch (e) {
                     console.error("語源の解説を保存できませんでした:", e);
                   }
                 }}
               />
             </motion.div>
          ) : activeTab === "wordbook" ? (
            <motion.div key="wordbook" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Wordbook
                words={filteredWords}
                onWordClick={(w) => {
                  setResult(w);
                  setActiveTab("detail");
                }}
              />
            </motion.div>
          ) : activeTab === "flashcards" && review.session ? (
            <ReviewMode
              key="flashcards"
              api={review}
              onGrade={handleReview}
              onExit={exitFlashcards}
            />
          ) : loading ? (
             <motion.div
               key="skeleton"
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               className="h-full flex flex-col"
             >
               <WordSkeleton />
             </motion.div>
          ) : result ? (
            <motion.div
              key={result.word}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              className="max-w-4xl mx-auto flex flex-col h-full"
            >
              <div className="flex justify-between items-start gap-6 mb-10">
                <div className="word-title-group min-w-0">
                  <div className="flex items-center gap-3 mb-2">
                    <h1 className="text-4xl md:text-6xl font-black tracking-tighter text-[#1A1C1E] break-all md:break-words">{result.word}</h1>
                    {ttsAvailable && result.word && (
                      <button
                        type="button"
                        onClick={() => speak(result.word, loadTtsSettings())}
                        title="発音を再生"
                        className="w-9 h-9 shrink-0 text-[#8A9199] hover:text-[#2A5CFF] flex items-center justify-center transition-colors"
                      >
                        <Volume2 className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                  {formatPhonetic(result.phonetic) && (
                    <p className="text-base md:text-lg text-[#656E77] tracking-wide mb-3">
                      {formatPhonetic(result.phonetic)}
                    </p>
                  )}
                  {/* 属性は中点区切りの一行。個別に囲まない */}
                  <p className="text-sm font-bold text-[#8A9199]">
                    {[
                      result.grammar,
                      "mode" in result ? (result as SavedWord).mode : dictionaryMode,
                      result.category,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={saveWord}
                  disabled={isResultSaved}
                  className="btn-quiet shrink-0 px-0 text-sm"
                >
                  <Plus className="w-4 h-4" />
                  {isResultSaved ? "保存済み" : "リストに追加"}
                </button>
              </div>

              {/* タグ / デッキ（F7）。保存済みの単語にのみ出す。 */}
              {(result as SavedWord).id && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-10 pb-5 border-b border-[#EAECEF]">
                  <select
                    value={(result as SavedWord).deckId ?? ""}
                    onChange={(e) => moveToDeck(result as SavedWord, e.target.value || null)}
                    className="h-8 bg-transparent border-0 rounded-none text-[11px] font-bold text-[#656E77] focus:outline-none"
                  >
                    <option value="">未分類</option>
                    {decks.decks.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>

                  {((result as SavedWord).tags ?? []).map((tag) => (
                    <span
                      key={tag}
                      className="text-[11px] font-bold text-[#1A1C1E] flex items-center gap-1"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() =>
                          updateTags(
                            result as SavedWord,
                            ((result as SavedWord).tags ?? []).filter((t) => t !== tag)
                          )
                        }
                        className="w-4 h-4 flex items-center justify-center text-[#C9CDD2] hover:text-red-500"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}

                  <div className="flex items-center gap-1 h-8">
                    <TagIcon className="w-3 h-3 text-[#8A9199]" />
                    <input
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || !tagDraft.trim()) return;
                        updateTags(result as SavedWord, [
                          ...((result as SavedWord).tags ?? []),
                          tagDraft,
                        ]);
                        setTagDraft("");
                      }}
                      list="cortex-tag-suggestions"
                      placeholder="タグを追加"
                      className="w-24 bg-transparent text-[11px] font-bold outline-none placeholder:text-[#8A9199]"
                    />
                    <datalist id="cortex-tag-suggestions">
                      {allTags.map(({ tag }) => (
                        <option key={tag} value={tag} />
                      ))}
                    </datalist>
                  </div>
                </div>
              )}

              {(result as SavedWord).enrichStatus === "pending" && (
                <p className="mb-10 pl-4 border-l-2 border-[#2A5CFF] text-xs text-[#656E77] leading-relaxed">
                  この単語の詳細を生成しています。しばらくすると例文や語源が表示されます。
                </p>
              )}

              <div className="max-w-3xl">
                <section className="section">
                  <h3 className="section-label">意味</h3>
                  <p className="text-2xl font-bold text-[#1A1C1E] leading-snug">
                    {result.meaning}
                  </p>
                </section>

                <section className="section">
                  <h3 className="section-label">使い分け</h3>
                  <p className="text-base text-[#1A1C1E] leading-loose">
                    {result.nuance}
                  </p>
                </section>

                <section className="section">
                  <h3 className="section-label">語源</h3>
                  <p className="text-base text-[#656E77] leading-loose mb-8">
                    {result.etymology}
                  </p>
                  {result.etymologyNodes && (
                    <EtymologyGraph mainWord={result.word} nodes={result.etymologyNodes} />
                  )}
                </section>

                {result.specializedContexts && result.specializedContexts.length > 0 && (
                  <section className="section">
                    <h3 className="section-label">専門分野での意味</h3>
                    <dl>
                      {result.specializedContexts.map((ctx, i) => (
                        <div
                          key={i}
                          className="py-5 border-t border-[#F1F3F5] first:border-t-0 first:pt-0 md:flex md:gap-8"
                        >
                          <dt className="text-xs font-bold text-[#1A1C1E] mb-1.5 md:mb-0 md:w-40 md:shrink-0">
                            {ctx.field}
                          </dt>
                          <dd className="text-sm text-[#656E77] leading-loose">{ctx.context}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}

                <section className="section">
                  <h3 className="section-label">例文</h3>
                  <div className="space-y-7">
                    {normalizeExamples(result.examples).map((ex, i) => (
                      <div key={i}>
                        <div className="flex items-start gap-2">
                          <p className="text-[#1A1C1E] font-bold text-base leading-relaxed flex-1">
                            {ex.en}
                          </p>
                          {ttsAvailable && ex.en && (
                            <button
                              type="button"
                              onClick={() => speak(ex.en, loadTtsSettings())}
                              title="例文を読み上げる"
                              className="w-6 h-6 shrink-0 text-[#C9CDD2] hover:text-[#2A5CFF] flex items-center justify-center transition-colors"
                            >
                              <Volume2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <p className="text-[#8A9199] text-sm mt-1">{ex.ja}</p>
                      </div>
                    ))}
                  </div>
                </section>

                {result.synonyms.length > 0 && (
                  <section className="section">
                    <h3 className="section-label">類義語</h3>
                    <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
                      {result.synonyms.map((s, i) => (
                        <div key={i}>
                          <dt className="text-sm font-bold text-[#1A1C1E]">{s.word}</dt>
                          <dd className="text-[11px] text-[#8A9199]">{s.translation}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}

                {result.antonyms.length > 0 && (
                  <section className="section">
                    <h3 className="section-label">対義語</h3>
                    <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
                      {result.antonyms.map((a, i) => (
                        <div key={i}>
                          <dt className="text-sm font-bold text-[#1A1C1E]">{a.word}</dt>
                          <dd className="text-[11px] text-[#8A9199]">{a.translation}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}
              </div>
            </motion.div>
          ) : (
            <div className="h-full flex flex-col justify-center max-w-xl mx-auto w-full">
              <h2 className="text-3xl md:text-4xl font-black text-[#1A1C1E] mb-3 tracking-tight">
                単語を調べる
              </h2>

              <p className="text-[#656E77] text-sm mb-10 leading-relaxed">
                英単語を入力すると、意味、使い分け、語源、例文、専門分野での用法を表示します。
              </p>

              <form onSubmit={handleSearch} className="w-full">
                <div className="flex items-end gap-4 border-b-2 border-[#1A1C1E] pb-2">
                  <Input
                    placeholder="単語を入力"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="flex-1 h-12 px-0 bg-transparent border-0 rounded-none text-xl md:text-2xl font-bold focus:ring-0 focus:outline-none placeholder:text-[#C9CDD2]"
                  />
                  <button
                    type="submit"
                    disabled={loading || !searchQuery.trim()}
                    className="h-12 w-10 shrink-0 flex items-center justify-center text-[#1A1C1E] disabled:opacity-25"
                  >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ChevronRight className="w-6 h-6" />}
                  </button>
                </div>
              </form>
            </div>
          )}
        </AnimatePresence>
      </main>
      {user && (
        <>
          <DataTransferModal
            open={isDataModalOpen}
            onClose={() => setIsDataModalOpen(false)}
            uid={user.uid}
            wordCount={savedWords.length}
          />
          <DeckManager
            open={isDeckManagerOpen}
            onClose={() => setIsDeckManagerOpen(false)}
            api={decks}
            words={savedWords}
          />
          <UpgradeModal
            open={isUpgradeOpen}
            onClose={() => {
              setIsUpgradeOpen(false);
              setUpgradeReason(undefined);
              void refreshPlan();
            }}
            status={planStatus}
            reason={upgradeReason}
          />
          <StartupGuide open={isGuideOpen} onClose={() => setIsGuideOpen(false)} />
          <CoachMarks open={isCoachOpen} onClose={() => setIsCoachOpen(false)} />
          <BulkExtractModal
            open={isExtractOpen}
            onClose={() => setIsExtractOpen(false)}
            uid={user.uid}
            words={savedWords}
            decks={decks.decks}
            mode={dictionaryMode}
          />
        </>
      )}
      <Toaster position="bottom-right" richColors />
    </div>
  );
}
