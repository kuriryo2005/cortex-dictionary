/**
 * AI 呼び出しの利用上限（日/週/月）。
 *
 * 1回ごとに Gemini 側へ実費が発生するため、プランごとに上限を設ける
 * （具体値と原価の根拠は api/_lib/plan.ts の PLAN_QUOTA を参照）。
 * カウンタは Firestore の usage_counters/{uid} に置く。
 *
 * ## 書き込みをサービスアカウントで行う理由（重要）
 *
 * 以前は「本人の ID トークンをそのまま Firestore REST に使い回す」方式だった。
 * 秘密情報を増やさずに済むのが狙いだったが、これは上限機構として成立して
 * いなかった。ユーザーは自分の usage_counters を自分の権限で書けるので、
 * カウンタを 0 に戻せば何度でも AI を呼べてしまう（＝実費が青天井）。
 *
 * Stripe Webhook 用にサービスアカウントを導入したので、カウンタの読み書きも
 * そちらに寄せ、firestore.rules ではユーザーからの書き込みを禁止した。
 * 読み取りだけは本人に許可してある（残り回数の表示に使えるようにするため）。
 *
 * ## バケット
 *
 * lookup 以外にも実費の出るエンドポイントがあるので、種類ごとにカウンタを
 * 分ける。lookup は既存データを引き継ぐため、歴史的に接頭辞なしの
 * フィールド名（dayKey / dayCount …）をそのまま使う。
 *
 * 同時リクエストがまれに1件分カウントを取りこぼす可能性はあるが（読み取り
 * →判定→書き込みの間にレースがあり得る）、「多少緩くても制限機構自体の
 * 障害でサービスを止めない」方針に合わせ、簡易な実装にとどめる。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };
import { PLAN_QUOTA, resolvePlan, type PlanId, type QuotaBucket } from "./plan.js";
import { getServiceAccessToken } from "./googleAuth.js";

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

/**
 * 後方互換の別名。実際の上限はプランごとに `PLAN_QUOTA` で決まる。
 * （Pro の lookup の値と一致させてある）
 */
export const LOOKUP_QUOTA = PLAN_QUOTA.pro.lookup;

export type QuotaResult =
  | { ok: true; plan: PlanId }
  | { ok: false; plan: PlanId; message: string; upgradable: boolean };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC の Date から「日本時間で見た日付」の年月日を取り出す簡便法。 */
function jstParts(now: Date): { y: number; m: number; d: number } {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return { y: jst.getUTCFullYear(), m: jst.getUTCMonth() + 1, d: jst.getUTCDate() };
}

/** ISO 8601 週番号（月曜始まり）。年またぎの週も正しく year を返す。 */
function isoWeek(now: Date): { year: number; week: number } {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const date = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function currentKeys(now = new Date()): Record<"dayKey" | "weekKey" | "monthKey", string> {
  const { y, m, d } = jstParts(now);
  const { year: wy, week } = isoWeek(now);
  return {
    dayKey: `${y}-${pad(m)}-${pad(d)}`,
    weekKey: `${wy}-W${pad(week)}`,
    monthKey: `${y}-${pad(m)}`,
  };
}

/**
 * フィールド名。lookup は既存データを引き継ぐため接頭辞を付けない。
 * 新しいバケットは `extract_dayKey` のように接頭辞を付ける。
 */
function fieldName(bucket: QuotaBucket, base: string): string {
  return bucket === "lookup" ? base : `${bucket}_${base}`;
}

function fieldNumber(fields: Record<string, any> | undefined, key: string): number {
  const v = fields?.[key];
  if (!v) return 0;
  return Number(v.integerValue ?? v.doubleValue ?? 0);
}

const PERIODS = [
  {
    keyBase: "dayKey",
    countBase: "dayCount",
    limitKey: "day",
    label: "本日",
    reset: "日本時間の日付が変わるとリセットされます。",
  },
  {
    keyBase: "weekKey",
    countBase: "weekCount",
    limitKey: "week",
    label: "今週",
    reset: "来週になるとリセットされます。",
  },
  {
    keyBase: "monthKey",
    countBase: "monthCount",
    limitKey: "month",
    label: "今月",
    reset: "来月になるとリセットされます。",
  },
] as const;

const BUCKET_LABEL: Record<QuotaBucket, string> = {
  lookup: "検索",
  extract: "英文からの一括抽出",
  story: "語源ストーリーの生成",
  review: "復習コメントの生成",
};

/**
 * 上限に達していなければカウントを1消費して ok を返す。
 * 達していれば ok:false と、どの期間のどの上限かを伝えるメッセージを返す。
 *
 * Firestore にアクセスできないときは通す（上限機構の障害でサービス自体を
 * 止めない）。プラン判定に失敗した場合は free 扱いになるので、緩む方向には
 * 倒れない。
 */
export async function checkAndConsumeQuota(
  idToken: string,
  uid: string,
  bucket: QuotaBucket
): Promise<QuotaResult> {
  const { plan } = await resolvePlan(idToken, uid);
  const limit = PLAN_QUOTA[plan][bucket];
  const what = BUCKET_LABEL[bucket];

  // 上限0＝そのプランでは使えない機能。Firestore を触るまでもなく弾く。
  if (limit.day === 0) {
    return {
      ok: false,
      plan,
      upgradable: plan === "free",
      message: `${what}は Pro プランの機能です。`,
    };
  }

  const keys = currentKeys();

  let token: string;
  try {
    token = await getServiceAccessToken();
  } catch (e) {
    console.warn("[quota] サービスアカウントのトークン取得に失敗:", e);
    return { ok: true, plan };
  }

  const docUrl = `${BASE_URL}/usage_counters/${uid}`;
  const authHeader = { Authorization: `Bearer ${token}` };

  let fields: Record<string, any> | undefined;
  try {
    const res = await fetch(docUrl, { headers: authHeader });
    if (res.ok) {
      fields = ((await res.json()) as { fields?: Record<string, any> }).fields;
    } else if (res.status !== 404) {
      console.warn("[quota] usage_counters read failed:", res.status);
      return { ok: true, plan };
    }
  } catch (e) {
    console.warn("[quota] usage_counters read error:", e);
    return { ok: true, plan };
  }

  // 期間キーが変わっていればカウントは 0 から数え直す
  const counts = PERIODS.map((p) => {
    const keyField = fieldName(bucket, p.keyBase);
    const countField = fieldName(bucket, p.countBase);
    const current = keys[p.keyBase];
    const stored = fields?.[keyField]?.stringValue as string | undefined;
    return {
      keyField,
      countField,
      current,
      value: stored === current ? fieldNumber(fields, countField) : 0,
      max: limit[p.limitKey],
      label: p.label,
      reset: p.reset,
    };
  });

  const exceeded = counts.find((c) => c.value >= c.max);
  if (exceeded) {
    return {
      ok: false,
      plan,
      upgradable: plan === "free",
      message:
        plan === "free"
          ? `無料プランの${exceeded.label}の${what}の上限（${exceeded.max}回）に達しました。${exceeded.reset} Pro にすると上限が広がります。`
          : `${exceeded.label}の${what}の上限（${exceeded.max}回）に達しました。${exceeded.reset}`,
    };
  }

  // 触ったフィールドだけを更新する（他のバケットのカウントを消さない）
  const updateFields: Record<string, unknown> = {
    userId: { stringValue: uid },
    updatedAt: { integerValue: String(Date.now()) },
  };
  const mask: string[] = ["userId", "updatedAt"];
  for (const c of counts) {
    updateFields[c.keyField] = { stringValue: c.current };
    updateFields[c.countField] = { integerValue: String(c.value + 1) };
    mask.push(c.keyField, c.countField);
  }

  try {
    const url = `${docUrl}?${mask.map((f) => `updateMask.fieldPaths=${f}`).join("&")}`;
    await fetch(url, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: updateFields }),
    });
  } catch (e) {
    // 書き込みに失敗してもカウントが多少不正確になるだけなので処理は続行する
    console.warn("[quota] usage_counters write error:", e);
  }

  return { ok: true, plan };
}

/** 既存の呼び出し元のための薄い別名。 */
export function checkAndConsumeLookupQuota(idToken: string, uid: string): Promise<QuotaResult> {
  return checkAndConsumeQuota(idToken, uid, "lookup");
}
