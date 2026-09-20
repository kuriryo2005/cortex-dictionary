/**
 * `subscriptions/{uid}` への書き込み（Stripe Webhook 専用）。
 *
 * ユーザー側からは firestore.rules で書き込みを完全に禁止しているため、
 * ここだけがサービスアカウント権限で契約状態を更新する。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };
import { getServiceAccessToken } from "./googleAuth.js";

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

export interface SubscriptionRecord {
  status: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  /** epoch ms */
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
}

/**
 * Firebase の uid として妥当な形か。
 *
 * uid は Stripe の metadata 由来で、そのまま Firestore REST のドキュメント
 * パスに入る。現状その metadata を設定できるのは自サーバーだけだが、書き込みは
 * サービスアカウント権限なので、万一おかしな値が入ったときに別のコレクションを
 * 書き換えられる形にはしておかない。
 */
function isValidUid(uid: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(uid);
}

export async function writeSubscription(uid: string, rec: SubscriptionRecord): Promise<void> {
  if (!isValidUid(uid)) {
    throw new Error(`uid の形式が不正です: ${JSON.stringify(uid).slice(0, 64)}`);
  }
  const token = await getServiceAccessToken();
  const fields = {
    userId: { stringValue: uid },
    status: { stringValue: rec.status },
    stripeCustomerId: { stringValue: rec.stripeCustomerId },
    stripeSubscriptionId: { stringValue: rec.stripeSubscriptionId },
    currentPeriodEnd: { integerValue: String(rec.currentPeriodEnd) },
    cancelAtPeriodEnd: { booleanValue: rec.cancelAtPeriodEnd },
    updatedAt: { integerValue: String(Date.now()) },
  };

  const res = await fetch(`${BASE_URL}/subscriptions/${uid}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    throw new Error(`subscriptions/${uid} の更新に失敗しました: ${res.status} ${await res.text()}`);
  }
}

/** 本人の ID トークンで自分の Stripe 顧客 ID を読む（Portal 用）。 */
export async function readStripeCustomerId(idToken: string, uid: string): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/subscriptions/${uid}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) return null;
  const fields = ((await res.json()) as { fields?: Record<string, any> }).fields;
  return (fields?.stripeCustomerId?.stringValue as string | undefined) ?? null;
}
