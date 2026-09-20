/**
 * Stripe Checkout のセッションを作り、決済ページの URL を返す。
 *
 * 顧客と uid の対応は client_reference_id と subscription_data.metadata.uid の
 * 両方に入れる。Webhook 側はどちらからでも uid を復元できる。
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { createCheckoutSession } from "./_lib/stripe.js";
import { readStripeCustomerId } from "./_lib/subscriptionStore.js";

function priceId(interval: string): string | undefined {
  return interval === "year" ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY;
}

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "billing", async (user, body) => {
    const interval = body.interval === "year" ? "year" : "month";
    const price = priceId(interval);
    if (!price) return errorResponse(500, "料金プランが設定されていません。");

    const origin = process.env.APP_BASE_URL ?? new URL(request.url).origin;
    const idToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const customerId = await readStripeCustomerId(idToken, user.uid);

    const session = await createCheckoutSession({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      // 既に顧客がいれば使い回す。いなければメールから新規作成させる。
      ...(customerId ? { customer: customerId } : { customer_email: user.email }),
      client_reference_id: user.uid,
      subscription_data: { metadata: { uid: user.uid } },
      metadata: { uid: user.uid },
      allow_promotion_codes: true,
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
    });

    return jsonResponse({ url: session.url });
  });
}
