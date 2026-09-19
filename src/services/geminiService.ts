/**
 * 単語検索とAI機能のクライアント（実装仕様書 F1）。
 *
 * Gemini API キーはサーバー側にのみ存在し、ここからは自前の /api/* を叩く。
 * このファイルに API キーを持ち込まないこと。
 */

import { track } from "@vercel/analytics";
import { WordDetail, SavedWord, DictionaryMode, ExtractedCandidate } from "../types";
import { db, auth } from "../firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { toModeSlug, toWordLower } from "../lib/normalize";

/**
 * localStorage のキャッシュキー。
 * 旧 "lexilog_local_cache" とは cacheKey の形式が変わったため名前を変えている
 * （キャッシュはユーザーデータではないので破棄してよい）。
 *
 * v2 -> v3: 綴りミス自動修正のプロンプト変更に伴い破棄する。v2 時代に生成
 * された結果は word フィールドが未修正（綴りミスのまま）で保存されている
 * ため、シェアド Firestore キャッシュと同様、端末に残っていると古い内容が
 * 優先されてしまう。
 */
const CACHE_KEY = "cortex_dict_cache_v3";

const localCache = new Map<string, WordDetail>(
  (() => {
    try {
      const saved = localStorage.getItem(CACHE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  })()
);

function saveLocalCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Array.from(localCache.entries())));
  } catch (e) {
    // 容量超過などで失敗しても検索自体は続行できる
    console.warn("Local cache write failed:", e);
  }
}

/**
 * Firestore のドキュメントIDとして使えるキー。
 *
 * 旧実装は `${word}_${mode}` で mode に日本語が入っていたため、
 * セキュリティルールの isValidId（^[a-zA-Z0-9_\-|]+$）を通らず
 * dictionary_cache への書き込みが常に失敗していた。
 */
export function buildCacheKey(word: string, mode: DictionaryMode): string {
  return `${toWordLower(word)}__${toModeSlug(mode)}`;
}

export function getCachedWord(word: string, mode: DictionaryMode): WordDetail | null {
  return localCache.get(buildCacheKey(word, mode)) ?? null;
}

/**
 * 採算はキャッシュヒット率で決まるので、検索1回ごとにどの層で解決したかを
 * 記録する。local / firestore はコストゼロ、ai だけが実費（約1.8円）。
 * 計測基盤が無効でも track は黙って捨てられるだけで、検索には影響しない。
 */
function trackLookupSource(source: "local" | "firestore" | "ai", mode: DictionaryMode): void {
  try {
    track("lookup", { source, mode: String(mode) });
  } catch {
    // 計測の失敗で検索を止めない
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, "ログインが必要です。");
  const token = await user.getIdToken();
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(response.status, String(detail.error ?? "リクエストに失敗しました。"));
  }
  return (await response.json()) as T;
}

/**
 * 単語を引く。
 *
 * 1. localStorage（即時）
 * 2. Firestore の共有キャッシュ
 * 3. /api/lookup（AI生成。ここで初めて課金が発生する）
 *
 * 旧実装は Promise.any でキャッシュとAI生成を同時に走らせていたため、
 * キャッシュがヒットしてもAI呼び出しが必ず発生していた。順に試すことで
 * ヒット時のコストをゼロにしている。
 *
 * @param onPartial 部分的な結果が届くたびに呼ばれる（ストリーミング表示用）
 */
export async function lookupWord(
  word: string,
  mode: DictionaryMode = DictionaryMode.GENERAL,
  onPartial?: (partial: Partial<WordDetail>) => void
): Promise<WordDetail> {
  const cacheKey = buildCacheKey(word, mode);

  const local = localCache.get(cacheKey);
  if (local) {
    trackLookupSource("local", mode);
    return local;
  }

  const cacheRef = doc(db, "dictionary_cache", cacheKey);
  try {
    const snap = await getDoc(cacheRef);
    if (snap.exists()) {
      const data = snap.data() as WordDetail;
      localCache.set(cacheKey, data);
      saveLocalCache(); // 旧実装はここで保存しておらず、毎回 Firestore を往復していた
      trackLookupSource("firestore", mode);
      return data;
    }
  } catch (e) {
    console.warn("Dictionary cache read failed, falling back to AI:", e);
  }

  trackLookupSource("ai", mode);
  const result = await streamLookup(word, mode, onPartial);

  localCache.set(cacheKey, result);
  saveLocalCache();

  // 共有キャッシュへの書き込みは失敗しても検索結果には影響しない
  setDoc(cacheRef, { ...result, cachedAt: serverTimestamp() }).catch((e) =>
    console.warn("Dictionary cache write failed:", e)
  );

  // 綴りミスが自動修正された場合、正しい綴りのキーにも保存しておく。
  // 次に正しい綴りで検索したときに AI 呼び出しを待たせない。
  const correctedKey = buildCacheKey(result.word, mode);
  if (correctedKey !== cacheKey) {
    localCache.set(correctedKey, result);
    saveLocalCache();
    setDoc(doc(db, "dictionary_cache", correctedKey), { ...result, cachedAt: serverTimestamp() }).catch(
      (e) => console.warn("Dictionary cache write failed:", e)
    );
  }

  return result;
}

/** /api/lookup の SSE を読み、完成した WordDetail を返す。 */
async function streamLookup(
  word: string,
  mode: DictionaryMode,
  onPartial?: (partial: Partial<WordDetail>) => void
): Promise<WordDetail> {
  const response = await fetch("/api/lookup", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ word, mode: toModeSlug(mode) }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(response.status, String(detail.error ?? "検索に失敗しました。"));
  }
  if (!response.body) throw new ApiError(502, "応答が空でした。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: WordDetail | null = null;
  let failure: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE は空行でイベントを区切る
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const raw of events) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;

      let event: { type?: string; payload?: unknown; message?: string };
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }

      if (event.type === "partial") {
        onPartial?.(event.payload as Partial<WordDetail>);
      } else if (event.type === "done") {
        final = event.payload as WordDetail;
      } else if (event.type === "error") {
        failure = event.message ?? "AI の応答に失敗しました。";
      }
    }
  }

  if (failure) throw new ApiError(502, failure);
  if (!final) throw new ApiError(502, "AI の応答が完了しませんでした。");
  return final;
}

export async function planNextReview(
  savedWord: SavedWord
): Promise<{ nextReviewAt: number; aiAnalysis: string }> {
  return postJson("/api/review-analysis", {
    word: savedWord.word,
    meaning: savedWord.meaning,
    reviewHistory: savedWord.reviewHistory ?? [],
    synonyms: savedWord.synonyms ?? [],
  });
}

export interface RootRelative {
  word: string;
  meaning: string;
  root: string;
}

/** 語根を共有する単語を追加で取得する（語源グラフの展開用）。 */
export async function expandEtymologyRoot(root: string): Promise<RootRelative[]> {
  const { words } = await postJson<{ words: RootRelative[] }>("/api/expand-root", { root });
  return words;
}

/**
 * 発音記号だけを取得する（F4 の遅延補完用）。
 * 既存の保存済み単語には phonetic が無いため、詳細を開いたときに1件ずつ補う。
 */
export async function fetchPhonetic(word: string): Promise<string> {
  const { phonetic } = await postJson<{ phonetic: string }>("/api/phonetic", { word });
  return phonetic;
}

/** 英文から未知語の候補を抽出する（F5）。 */
export async function extractCandidates(
  text: string,
  known: string[]
): Promise<ExtractedCandidate[]> {
  const { candidates } = await postJson<{ candidates: ExtractedCandidate[] }>("/api/extract", {
    text,
    known,
  });
  return candidates;
}

export async function getEtymologyStory(
  word: string,
  meaning: string,
  etymology: string
): Promise<string> {
  try {
    const { story } = await postJson<{ story: string }>("/api/story", { word, meaning, etymology });
    return story;
  } catch (error) {
    console.error("Story generation error:", error);
    return "ストーリーを生成できませんでした。";
  }
}
