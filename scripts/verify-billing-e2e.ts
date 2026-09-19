/**
 * 「お金を払ったら Pro になる」一本道を、実際の Firestore に対して通す。
 *
 *   npx tsx scripts/verify-billing-e2e.ts
 *
 * verify-billing.ts が純粋ロジックだけを見るのに対し、こちらは Webhook の
 * 受信 → サービスアカウントでの書き込み → プラン判定、という実際に
 * お金が絡む経路をそのまま動かす。ネットワークと本物の Firestore を使うので
 * `npm run verify` には入れず、課金まわりを触ったときに手で走らせる。
 *
 * 書き込み先は専用の uid で、最後に必ず消す。
 * STRIPE_WEBHOOK_SECRET はこのプロセス内だけの値で上書きするため、
 * 本番の設定には影響しない。
 */

import "dotenv/config";
import { config } from "dotenv";
import firebaseConfig from "../firebase-applet-config.json" with { type: "json" };

config({ path: ".env.local", override: true });
process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_e2e_test";

const UID = "e2e_test_user_delete_me";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;

const { POST } = await import("../api/billing-webhook.js");
const { resolvePlan, PLAN_QUOTA } = await import("../api/_lib/plan.js");
const { getServiceAccessToken } = await import("../api/_lib/googleAuth.js");

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function signature(payload: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(process.env.STRIPE_WEBHOOK_SECRET!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${t},v1=${hex}`;
}

async function post(body: string, sig: string): Promise<number> {
  const res = await POST(
    new Request("http://local/api/billing-webhook", {
      method: "POST",
      headers: { "stripe-signature": sig },
      body,
    })
  );
  return res.status;
}

function subscriptionEvent(type: string, status: string, daysAhead: number, cancelAtPeriodEnd = false) {
  return JSON.stringify({
    type,
    data: {
      object: {
        id: "sub_e2e_test",
        status,
        customer: "cus_e2e_test",
        cancel_at_period_end: cancelAtPeriodEnd,
        current_period_end: Math.floor(Date.now() / 1000) + daysAhead * 86400,
        metadata: { uid: UID },
      },
    },
  });
}

/**
 * resolvePlan は本来ユーザーの ID トークンで読む。ここでは検証用に
 * サービスアカウントのトークンを渡す（書き込まれた内容の確認としては成立する）。
 */
const saToken = await getServiceAccessToken();

console.log("決済から解約までの一本道");

let body = subscriptionEvent("customer.subscription.updated", "active", 30);
check("決済完了の webhook を受理する", (await post(body, await signature(body))) === 200);
let plan = await resolvePlan(saToken, UID);
check("Pro になる", plan.plan === "pro", plan);
check("上限が Pro のものになる", PLAN_QUOTA[plan.plan].lookup.day === PLAN_QUOTA.pro.lookup.day);
check("有効期限が入る", typeof plan.currentPeriodEnd === "number" && plan.currentPeriodEnd > Date.now());

body = subscriptionEvent("customer.subscription.updated", "active", 10, true);
await post(body, await signature(body));
plan = await resolvePlan(saToken, UID);
check("解約を予約しても期末までは Pro のまま", plan.plan === "pro" && plan.cancelAtPeriodEnd === true, plan);

body = subscriptionEvent("customer.subscription.deleted", "canceled", 0);
await post(body, await signature(body));
plan = await resolvePlan(saToken, UID);
check("解約が成立すると free に戻る", plan.plan === "free", plan);

console.log("\n偽造への耐性");
const forged = subscriptionEvent("customer.subscription.updated", "active", 365);
const status = await post(forged, `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`);
check("署名が合わない webhook は 400 で拒否する", status === 400);
plan = await resolvePlan(saToken, UID);
check("偽造では Pro にならない", plan.plan === "free", plan);

// 後片付け
await fetch(`${BASE_URL}/subscriptions/${UID}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${saToken}` },
});
console.log("\nテスト用ドキュメントを削除しました。");

if (failures > 0) {
  console.log(`\n${failures} 件失敗しました。`);
  process.exit(1);
}
console.log("すべて通りました。");
