/**
 * 単語検索のフェアユース上限（日/週/月）。
 *
 * 1検索ごとに Gemini 側へ実費が発生するため、無制限プランでも上限を設けて
 * 一部のヘビーユーザーだけで採算が崩れるのを防ぐ（プラン別の具体値と
 * その根拠は api/_lib/plan.ts の PLAN_QUOTA を参照）。カウンタは
 * Firestore の usage_counters/{uid} に置く。
 *
 * サーバーは firebase-admin を持たない（秘密情報を GEMINI_API_KEY 1本に
 * 抑える設計。api/_lib/auth.ts 参照）。代わりに、リクエストで既に検証済みの
 * ユーザー本人の ID トークンをそのまま Firestore REST API の Authorization
 * に使い回す。firestore.rules 側で usage_counters/{uid} は本人しか
 * 読み書きできないため、これで安全に完結する。
 *
 * 同時リクエストがまれに1件分カウントを取りこぼす可能性はあるが（読み取り
 * →判定→書き込みの間にレースがあり得る）、api/_lib/ratelimit.ts の
 * インメモリ制限と同じく「多少緩くても制限機構自体の障害でサービスを
 * 止めない」方針に合わせ、簡易な実装にとどめる。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };
import { PLAN_QUOTA, resolvePlan, type PlanId } from "./plan.js";

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

/**
 * 後方互換の別名。実際の上限はプランごとに `PLAN_QUOTA` で決まる。
 * （Pro の値と一致させてある）
 */
export const LOOKUP_QUOTA = PLAN_QUOTA.pro;

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

function currentKeys(now = new Date()) {
  const { y, m, d } = jstParts(now);
  const { year: wy, week } = isoWeek(now);
  return {
    dayKey: `${y}-${pad(m)}-${pad(d)}`,
    weekKey: `${wy}-W${pad(week)}`,
    monthKey: `${y}-${pad(m)}`,
  };
}

function fieldNumber(fields: Record<string, any> | undefined, key: string): number {
  const v = fields?.[key];
  if (!v) return 0;
  return Number(v.integerValue ?? v.doubleValue ?? 0);
}

/**
 * 上限に達していなければカウントを1消費して ok を返す。
 * 達していれば ok:false と、どの期間の上限かを伝えるメッセージを返す。
 */
export async function checkAndConsumeLookupQuota(idToken: string, uid: string): Promise<QuotaResult> {
  const { plan } = await resolvePlan(idToken, uid);
  const limit = PLAN_QUOTA[plan];
  const { dayKey, weekKey, monthKey } = currentKeys();
  const docUrl = `${BASE_URL}/usage_counters/${uid}`;
  const authHeader = { Authorization: `Bearer ${idToken}` };

  let dayCount = 0;
  let weekCount = 0;
  let monthCount = 0;

  try {
    const getRes = await fetch(docUrl, { headers: authHeader });
    if (getRes.ok) {
      const doc = (await getRes.json()) as { fields?: Record<string, any> };
      const f = doc.fields;
      if (f?.dayKey?.stringValue === dayKey) dayCount = fieldNumber(f, "dayCount");
      if (f?.weekKey?.stringValue === weekKey) weekCount = fieldNumber(f, "weekCount");
      if (f?.monthKey?.stringValue === monthKey) monthCount = fieldNumber(f, "monthCount");
    } else if (getRes.status !== 404) {
      // 読み取り自体に失敗した場合は、上限機構の不調でサービスを止めないよう許可する
      console.warn("[quota] usage_counters read failed:", getRes.status);
      return { ok: true, plan };
    }
  } catch (e) {
    console.warn("[quota] usage_counters read error:", e);
    return { ok: true, plan };
  }

  const over = (
    count: number,
    max: number,
    period: string,
    resetNote: string
  ): QuotaResult | null =>
    count < max
      ? null
      : {
          ok: false,
          plan,
          upgradable: plan === "free",
          message:
            plan === "free"
              ? `無料プランの${period}の検索上限（${max}語）に達しました。${resetNote} Pro にすると1日100語まで検索できます。`
              : `${period}の検索上限（${max}語）に達しました。${resetNote}`,
        };

  const exceeded =
    over(dayCount, limit.day, "本日", "日本時間の日付が変わるとリセットされます。") ??
    over(weekCount, limit.week, "今週", "来週になるとリセットされます。") ??
    over(monthCount, limit.month, "今月", "来月になるとリセットされます。");
  if (exceeded) return exceeded;

  try {
    await fetch(docUrl, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          userId: { stringValue: uid },
          dayKey: { stringValue: dayKey },
          dayCount: { integerValue: String(dayCount + 1) },
          weekKey: { stringValue: weekKey },
          weekCount: { integerValue: String(weekCount + 1) },
          monthKey: { stringValue: monthKey },
          monthCount: { integerValue: String(monthCount + 1) },
          updatedAt: { integerValue: String(Date.now()) },
        },
      }),
    });
  } catch (e) {
    // 書き込みに失敗してもカウントが多少不正確になるだけなので検索は続行する
    console.warn("[quota] usage_counters write error:", e);
  }

  return { ok: true, plan };
}
