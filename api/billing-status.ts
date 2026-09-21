/** 現在のプランと上限をクライアントに返す。UI の出し分けに使う。 */

import { withAuth, jsonResponse } from "./_lib/handler.js";
import { PLAN_QUOTA, PLAN_WORD_LIMIT, resolvePlan, type QuotaBucket, type QuotaLimit } from "./_lib/plan.js";

/** 運営者向け。画面の残数表示が意味を持たなくなるので、十分に大きい値を返す。 */
const BIG = 1_000_000;
const UNLIMITED_QUOTA: Record<QuotaBucket, QuotaLimit> = {
  lookup: { day: BIG, week: BIG, month: BIG },
  extract: { day: BIG, week: BIG, month: BIG },
  story: { day: BIG, week: BIG, month: BIG },
  review: { day: BIG, week: BIG, month: BIG },
};

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "billing", async (user) => {
    const idToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const state = await resolvePlan(idToken, user.uid, user);
    return jsonResponse({
      ...state,
      // バケット別の上限をそのまま渡す（クライアントは lookup を主に使う）
      // 運営者は上限をかけないので、画面にも残数を出さない（null = 無制限）
      quota: state.unlimited ? UNLIMITED_QUOTA : PLAN_QUOTA[state.plan],
      wordLimit: state.unlimited ? null : PLAN_WORD_LIMIT[state.plan],
      billingEnabled: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY),
    });
  });
}
