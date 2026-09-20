/**
 * データのインポート / 復元（実装仕様書 F8）。
 *
 * 方針:
 * - 実行前に必ずドライランで件数を提示し、ユーザーの確認を経てから書き込む。
 * - userId は常に現在のログインユーザーで上書きする（他人のエクスポートを取り込んでも
 *   セキュリティルール違反にならないようにするため）。
 * - timestamp は元の値を保持する（保存日でのグルーピングを復元するため）。
 *   ただし既存ドキュメントの上書き時は timestamp が immutable なので変更しない。
 */

import { collection, doc, writeBatch } from "firebase/firestore";
import { db } from "../firebase";
import { fetchRawWords } from "./exportData";
import { saveWords } from "../services/wordService";
import { toModeSlug, toWordLower } from "./normalize";

export type ConflictStrategy = "skip" | "overwrite" | "duplicate";

export const MAX_IMPORT_WORDS = 5000;
const BATCH_SIZE = 400;
/** /api/save-words が1回で受け付ける上限に合わせる。 */
const SAVE_CHUNK = 100;

/** セキュリティルール（isValidWord）が課している上限。 */
const LIMITS = {
  word: 500,
  meaning: 1000,
  grammar: 100,
  examples: 10,
  specializedContexts: 5,
  synonyms: 10,
  antonyms: 10,
  reviewHistory: 1000,
  senses: 8,
  targetPhrases: 8,
  derivatives: 8,
} as const;

/** 現行ルールで update 時に変更が許可されているキー（内容側）。 */
const UPDATABLE_CONTENT_KEYS = [
  "word", "meaning", "grammar", "category", "etymology", "nuance",
  "specializedContexts", "examples", "synonyms", "antonyms",
  "etymologyNodes", "mode", "nextReviewAt", "aiAnalysis",
  // v3（単語帳の紙面用）
  "senses", "targetPhrases", "derivatives", "examLevel",
] as const;

/** 現行ルールで update 時に変更が許可されているキー（復習側）。 */
const UPDATABLE_REVIEW_KEYS = ["reviewHistory", "nextReviewAt", "aiAnalysis"] as const;

const VALID_MODES = ["一般", "学術（Academic）"];

export interface ImportPlan {
  /** 新規追加される単語 */
  toCreate: Record<string, unknown>[];
  /** 既存と重複した単語（strategy に応じて処理される） */
  duplicates: { incoming: Record<string, unknown>; existingId: string }[];
  /** 必須項目を欠くなど、取り込めなかった単語 */
  invalid: { word: string; reason: string }[];
  /** エクスポートに含まれていたが Phase 0 では取り込まないデッキ数 */
  skippedDecks: number;
  exportedAt: number | null;
}

export class ImportValidationError extends Error {}

/** JSON をパースして構造を検証する。 */
export function parseBundle(text: string): {
  words: Record<string, unknown>[];
  decks: Record<string, unknown>[];
  exportedAt: number | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportValidationError("JSON として読み込めませんでした。ファイルが壊れている可能性があります。");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ImportValidationError("ファイルの形式が正しくありません。");
  }

  const b = parsed as Record<string, unknown>;

  if (b.app !== "cortex-dictionary") {
    throw new ImportValidationError(
      "Cortex Dictionary のエクスポートファイルではないようです（app フィールドが一致しません）。"
    );
  }
  if (typeof b.formatVersion !== "number" || b.formatVersion > 1) {
    throw new ImportValidationError(
      `未対応の形式バージョンです（formatVersion: ${String(b.formatVersion)}）。アプリを更新してください。`
    );
  }
  if (!Array.isArray(b.words)) {
    throw new ImportValidationError("words が配列ではありません。");
  }
  if (b.words.length > MAX_IMPORT_WORDS) {
    throw new ImportValidationError(
      `単語数が上限（${MAX_IMPORT_WORDS}件）を超えています: ${b.words.length}件`
    );
  }

  return {
    words: b.words as Record<string, unknown>[],
    decks: Array.isArray(b.decks) ? (b.decks as Record<string, unknown>[]) : [],
    exportedAt: typeof b.exportedAt === "number" ? b.exportedAt : null,
  };
}

/** Firestore が受け付けない undefined を再帰的に除去する。 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== undefined).map(stripUndefined) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

function clampList(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

/**
 * セキュリティルールの isValidWord を通る形に整える。
 * 通せない場合は理由を返す。
 */
interface SanitizeResult {
  ok: boolean;
  /** ok が true のときのみ設定される */
  data?: Record<string, unknown>;
  /** ok が false のときのみ設定される */
  reason?: string;
}

function sanitizeForCreate(raw: Record<string, unknown>, uid: string): SanitizeResult {
  const word = String(raw.word ?? "").trim();
  if (!word) return { ok: false, reason: "word が空です" };
  if (word.length > LIMITS.word) return { ok: false, reason: `word が${LIMITS.word}文字を超えています` };

  const meaning = String(raw.meaning ?? "").trim().slice(0, LIMITS.meaning);
  if (!meaning) return { ok: false, reason: "meaning が空です" };

  // id はドキュメントIDであってフィールドではないので除外する
  const { id: _id, userId: _userId, ...rest } = raw;

  const mode = VALID_MODES.includes(String(raw.mode)) ? String(raw.mode) : "一般";
  const timestamp =
    typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();

  const data: Record<string, unknown> = {
    ...rest,
    word,
    meaning,
    grammar: String(raw.grammar ?? "").slice(0, LIMITS.grammar),
    mode,
    userId: uid,
    timestamp,
    examples: clampList(raw.examples, LIMITS.examples),
    specializedContexts: clampList(raw.specializedContexts, LIMITS.specializedContexts),
    synonyms: clampList(raw.synonyms, LIMITS.synonyms),
    antonyms: clampList(raw.antonyms, LIMITS.antonyms),
    reviewHistory: clampList(raw.reviewHistory, LIMITS.reviewHistory),
    // v3（単語帳の紙面用）。ルールの上限に合わせて切り詰める
    senses: clampList(raw.senses, LIMITS.senses),
    targetPhrases: clampList(raw.targetPhrases, LIMITS.targetPhrases),
    derivatives: clampList(raw.derivatives, LIMITS.derivatives),
    wordLower: toWordLower(word),
    // 紙面用の項目を伴って入ってきたものは v3 扱いにする。
    // でないと取り込んだ直後にまた補完対象として拾われる
    schemaVersion: Array.isArray(raw.senses) && raw.senses.length > 0 ? 3 : 2,
    updatedAt: Date.now(),
  };

  if (raw.nextReviewAt !== undefined && typeof raw.nextReviewAt !== "number") {
    delete data.nextReviewAt;
  }

  return { ok: true, data: stripUndefined(data) };
}

/** 重複判定キー。単語（小文字）とモードの組み合わせ。 */
function dedupeKey(raw: Record<string, unknown>): string {
  return `${toWordLower(raw.word)}|${toModeSlug(raw.mode)}`;
}

/**
 * ドライラン。実際の書き込みは行わず、何が起きるかだけを返す。
 */
export async function planImport(bundleText: string, uid: string): Promise<ImportPlan> {
  const { words, decks, exportedAt } = parseBundle(bundleText);
  const existing = await fetchRawWords(uid);
  return buildPlan({ words, decks, exportedAt }, existing, uid);
}

/**
 * ドライランの判定ロジック本体。Firestore に依存しないので単体でテストできる。
 *
 * @param existing 既に保存されている単語の生データ（id を含む）
 */
export function buildPlan(
  bundle: { words: Record<string, unknown>[]; decks: Record<string, unknown>[]; exportedAt: number | null },
  existing: Record<string, unknown>[],
  uid: string
): ImportPlan {
  const { words, decks, exportedAt } = bundle;

  const existingByKey = new Map<string, string>();
  for (const e of existing) {
    existingByKey.set(dedupeKey(e), String(e.id));
  }

  const plan: ImportPlan = {
    toCreate: [],
    duplicates: [],
    invalid: [],
    skippedDecks: decks.length,
    exportedAt,
  };

  // 同一ファイル内の重複も 1 件に畳む
  const seenInFile = new Set<string>();

  for (const raw of words) {
    const sanitized = sanitizeForCreate(raw, uid);
    if (!sanitized.ok || !sanitized.data) {
      plan.invalid.push({
        word: String(raw.word ?? "(不明)"),
        reason: sanitized.reason ?? "不明なエラー",
      });
      continue;
    }
    const data = sanitized.data;

    const key = dedupeKey(data);
    if (seenInFile.has(key)) {
      plan.invalid.push({ word: String(data.word), reason: "ファイル内で重複" });
      continue;
    }
    seenInFile.add(key);

    const existingId = existingByKey.get(key);
    if (existingId) {
      plan.duplicates.push({ incoming: data, existingId });
    } else {
      plan.toCreate.push(data);
    }
  }

  return plan;
}

export interface ImportResult {
  created: number;
  overwritten: number;
  skipped: number;
  invalid: number;
}

/**
 * ドライランの結果を実際に適用する。
 *
 * 上書きは、現行のセキュリティルールが update の変更キーをホワイトリストで
 * 制限しているため「内容」と「復習履歴」の 2 回に分けて実行する。
 * （どちらも既存ルールで許可されている組み合わせ）
 */
export async function applyImport(
  plan: ImportPlan,
  uid: string,
  strategy: ConflictStrategy,
  onProgress?: (done: number, total: number) => void
): Promise<ImportResult> {
  const result: ImportResult = {
    created: 0,
    overwritten: 0,
    skipped: 0,
    invalid: plan.invalid.length,
  };

  const creates = [...plan.toCreate];
  if (strategy === "duplicate") {
    creates.push(...plan.duplicates.map((d) => d.incoming));
  } else if (strategy === "skip") {
    result.skipped = plan.duplicates.length;
  }

  const total =
    creates.length + (strategy === "overwrite" ? plan.duplicates.length * 2 : 0);
  let done = 0;

  // --- 新規作成 ---
  //
  // 保存はサーバー経由。クライアントから `words` に直接書けないようにしてある
  // （無料プランの上限をセキュリティルールでは強制できないため）。復元自体も
  // Pro 限定で、サーバー側が弾く。
  for (let i = 0; i < creates.length; i += SAVE_CHUNK) {
    const chunk = creates.slice(i, i + SAVE_CHUNK);
    await saveWords(chunk as Record<string, unknown>[], "restore");
    result.created += chunk.length;
    done += chunk.length;
    onProgress?.(done, total);
  }

  // --- 上書き ---
  if (strategy === "overwrite") {
    for (let i = 0; i < plan.duplicates.length; i += BATCH_SIZE) {
      const chunk = plan.duplicates.slice(i, i + BATCH_SIZE);

      // 1回目: 内容の更新
      const contentBatch = writeBatch(db);
      for (const { incoming, existingId } of chunk) {
        const patch: Record<string, unknown> = {};
        for (const k of UPDATABLE_CONTENT_KEYS) {
          if (incoming[k] !== undefined) patch[k] = incoming[k];
        }
        contentBatch.update(doc(db, "words", existingId), patch);
      }
      await contentBatch.commit();
      done += chunk.length;
      onProgress?.(done, total);

      // 2回目: 復習履歴の更新（内容とは別のキー集合なのでルール上まとめられない）
      const reviewBatch = writeBatch(db);
      let hasReviewUpdate = false;
      for (const { incoming, existingId } of chunk) {
        const patch: Record<string, unknown> = {};
        for (const k of UPDATABLE_REVIEW_KEYS) {
          if (incoming[k] !== undefined) patch[k] = incoming[k];
        }
        if (Object.keys(patch).length > 0) {
          reviewBatch.update(doc(db, "words", existingId), patch);
          hasReviewUpdate = true;
        }
      }
      if (hasReviewUpdate) await reviewBatch.commit();

      result.overwritten += chunk.length;
      done += chunk.length;
      onProgress?.(done, total);
    }
  }

  return result;
}
