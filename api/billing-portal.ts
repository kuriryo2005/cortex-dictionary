/**
 * Stripe Customer Portal のセッションを作る。
 * 解約・支払い方法の変更・請求書の閲覧はすべて Stripe 側の画面に任せる。
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { createPortalSession } from "./_lib/stripe.js";
import { readStripeCustomerId } from "./_lib/subscriptionStore.js";

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "billing", async (user) => {
    const idToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const customerId = await readStripeCustomerId(idToken, user.uid);
    if (!customerId) return errorResponse(404, "ご契約が見つかりません。");

    const origin = process.env.APP_BASE_URL ?? new URL(request.url).origin;
    const session = await createPortalSession({ customer: customerId, return_url: origin });
    return jsonResponse({ url: session.url });
  });
}
