/**
 * 課金プランの判定。
 *
 * 契約状態は Firestore の `subscriptions/{uid}` に置く。書き込みは Stripe
 * Webhook（サービスアカウント経由）だけが行い、`firestore.rules` 側で
 * ユーザーからの書き込みを全面禁止しているため、本人が自分を Pro に
 * 書き換えることはできない。読み取りは本人に許可しているので、ここでは
 * quota.ts と同じく「検証済みの本人 ID トークン」をそのまま使い回す。
 *
 * 読み取りに失敗したときは free として扱う（上限が厳しくなる側に倒す）。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

export type PlanId = "free" | "pro";

/**
 * 実費が発生する AI 呼び出しの種類。エンドポイントごとにカウンタを分ける。
 * - `lookup`  … 単語検索（/api/lookup）
 * - `extract` … 英文からの一括抽出（/api/extract）。最大8,000字を処理するので最も高い
 * - `story`   … 語源ストーリー（/api/story, /api/expand-root）
 * - `review`  … 復習コメントと発音記号の補完（/api/review-analysis, /api/phonetic）。軽い
 */
export type QuotaBucket = "lookup" | "extract" | "story" | "review";

export interface QuotaLimit {
  day: number;
  week: number;
  month: number;
}

/**
 * プラン × 種類ごとの上限。
 *
 * 上限は「気分」ではなく原価から逆算している。gemini-3.8-flash は
 * 出力 $3.75/1M トークン（2026年末までの導入価格。2027/01 から $7.50）で、
 * 1回の検索は thinking を含め出力 3,000 トークン前後に達する。つまり
 * **キャッシュに当たらなかった検索1回あたり約1.8円**かかる。
 *
 * 当初は Pro の検索を日300語にしていたが、それだと月9,000語 ≒ 原価16,000円で、
 * 月額600円では桁違いの赤字になる。dictionary_cache は全ユーザー共有なので
 * 実際には多くがキャッシュヒットするが、それに賭けた上限設定は危険。
 *
 * そこで Pro の検索は日100語・月1,500語に抑えた（学習者としては十分に多い）。
 * 実効ヒット率8割を見込むと原価は月540円程度に収まる。ここを実測で詰めるまでは
 * この保守的な上限を動かさないこと（実測は api/_lib/costLog.ts のログから）。
 *
 * extract は LP と課金画面で Pro 限定と謳っている機能なので、free は 0 にして
 * サーバー側で確実に止める。
 */
export const PLAN_QUOTA: Record<PlanId, Record<QuotaBucket, QuotaLimit>> = {
  free: {
    lookup: { day: 10, week: 40, month: 100 },
    extract: { day: 0, week: 0, month: 0 },
    story: { day: 3, week: 10, month: 20 },
    review: { day: 20, week: 80, month: 300 },
  },
  pro: {
    lookup: { day: 100, week: 400, month: 1500 },
    extract: { day: 10, week: 40, month: 100 },
    story: { day: 20, week: 80, month: 300 },
    review: { day: 100, week: 400, month: 1500 },
  },
};

/** プランごとの保存語数の上限。null は無制限。 */
export const PLAN_WORD_LIMIT: Record<PlanId, number | null> = {
  free: 200,
  pro: null,
};

/** Pro 限定の機能キー。クライアントの表示制御と共有する。 */
export const PRO_FEATURES = [
  "knowledgeMap",
  "bulkExtract",
  "tts",
  "stats",
  "ankiExport",
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export interface PlanState {
  plan: PlanId;
  /** 有効期限（epoch ms）。Pro のときのみ入る。 */
  currentPeriodEnd?: number;
  /** Stripe 側で解約予約済みか（期末まで Pro のまま）。 */
  cancelAtPeriodEnd?: boolean;
}

const FREE: PlanState = { plan: "free" };

/**
 * `subscriptions/{uid}` を読んで現在のプランを返す。
 *
 * ドキュメントが無い / 読めない / status が有効でない / 期限切れ の場合は free。
 * 期限には Stripe の請求失敗を考慮して 3 日の猶予を持たせる（webhook の
 * 取りこぼしでいきなり止まるのを防ぐ）。
 */
export async function resolvePlan(idToken: string, uid: string): Promise<PlanState> {
  const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

  let fields: Record<string, any> | undefined;
  try {
    const res = await fetch(`${BASE_URL}/subscriptions/${uid}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return FREE;
    fields = ((await res.json()) as { fields?: Record<string, any> }).fields;
  } catch (e) {
    console.warn("[plan] subscriptions read error:", e);
    return FREE;
  }
  if (!fields) return FREE;

  const status = fields.status?.stringValue as string | undefined;
  // Stripe の subscription.status のうち利用を許すもの
  if (status !== "active" && status !== "trialing" && status !== "past_due") return FREE;

  const end = Number(fields.currentPeriodEnd?.integerValue ?? 0);
  if (end && Date.now() > end + GRACE_MS) return FREE;

  return {
    plan: "pro",
    currentPeriodEnd: end || undefined,
    cancelAtPeriodEnd: fields.cancelAtPeriodEnd?.booleanValue === true,
  };
}
