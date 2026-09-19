/** 現在のプランと上限をクライアントに返す。UI の出し分けに使う。 */

import { withAuth, jsonResponse } from "./_lib/handler.js";
import { PLAN_QUOTA, PLAN_WORD_LIMIT, resolvePlan } from "./_lib/plan.js";

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "billing", async (user) => {
    const idToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const state = await resolvePlan(idToken, user.uid);
    return jsonResponse({
      ...state,
      quota: PLAN_QUOTA[state.plan],
      wordLimit: PLAN_WORD_LIMIT[state.plan],
      billingEnabled: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY),
    });
  });
}
