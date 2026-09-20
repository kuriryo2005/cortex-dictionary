/**
 * Stripe Webhook。契約状態を `subscriptions/{uid}` に反映する。
 *
 * ここだけは認証ヘッダを持たないので withAuth を通さず、署名検証で真正性を
 * 担保する（api/_lib/stripe.ts の verifyWebhook）。書き込みはサービス
 * アカウント権限で行う。
 *
 * Stripe 側の設定で送るイベント:
 *   checkout.session.completed / customer.subscription.updated /
 *   customer.subscription.deleted
 */

import { jsonResponse, errorResponse } from "./_lib/handler.js";
import { getSubscription, verifyWebhook, type StripeSubscription } from "./_lib/stripe.js";
import { writeSubscription } from "./_lib/subscriptionStore.js";

/**
 * uid は subscription.metadata が第一。Checkout 経由の初回だけは
 * client_reference_id にしか入っていないことがあるので、そちらも見る。
 */
function pickUid(sub: StripeSubscription, fallback?: string): string | undefined {
  return sub.metadata?.uid || fallback || undefined;
}

/**
 * 期末の unix 秒。API バージョンによって subscription 直下だったり
 * items.data[0] 側だったりするので両方見る。
 */
function periodEndMs(sub: StripeSubscription & { items?: { data?: { current_period_end?: number }[] } }): number {
  const sec = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? 0;
  return sec ? sec * 1000 : 0;
}

async function applySubscription(sub: StripeSubscription, fallbackUid?: string): Promise<boolean> {
  const uid = pickUid(sub, fallbackUid);
  if (!uid) {
    console.error("[webhook] uid を特定できませんでした:", sub.id);
    return false;
  }
  await writeSubscription(uid, {
    status: sub.status,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : "",
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: periodEndMs(sub),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  });
  return true;
}

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return errorResponse(400, "署名がありません。");

  let event: Record<string, any>;
  try {
    event = await verifyWebhook(await request.text(), signature);
  } catch (e) {
    console.warn("[webhook] 検証に失敗:", e);
    return errorResponse(400, "署名の検証に失敗しました。");
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as {
          subscription?: string;
          client_reference_id?: string;
          metadata?: Record<string, string>;
        };
        if (!session.subscription) break;
        const sub = await getSubscription(session.subscription);
        await applySubscription(sub, session.metadata?.uid ?? session.client_reference_id);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await applySubscription(event.data.object as StripeSubscription);
        break;
      }
      default:
        // 購読していない種類が届いても 200 を返す（Stripe の再送を招かない）
        break;
    }
  } catch (e) {
    // 5xx を返すと Stripe が再送してくれるので、一時障害はここで拾わせる
    console.error("[webhook] 処理に失敗:", e);
    return errorResponse(500, "Webhook の処理に失敗しました。");
  }

  return jsonResponse({ received: true });
}
