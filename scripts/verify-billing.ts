/**
 * 課金まわりの検証。ネットワークには出ない。
 *
 *   npx tsx scripts/verify-billing.ts
 *
 * 実際にお金を受け取る前に、少なくとも次の2つは壊れていないことを確かめたい。
 *
 * 1. **Webhook の署名検証** — ここが甘いと、誰でも偽の webhook を投げて
 *    自分を Pro にできる。改竄・別の鍵・古いタイムスタンプを確実に弾くこと。
 * 2. **プランの判定** — 読み取りに失敗したときや status が不正なときに
 *    free 側（＝厳しい側）に倒れること。緩む方向に倒れると無限に課金される。
 *
 * 併せて、上限値の整合（Pro ≥ Free、日 ≤ 週 ≤ 月）と Stripe のパラメータ
 * エンコードも確認する。
 */

import "dotenv/config";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Stripe と同じやり方で署名ヘッダを作る（テスト用）。 */
async function sign(payload: string, secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

// ── 上限値の整合 ───────────────────────────────────────────────

const { PLAN_QUOTA, PLAN_WORD_LIMIT } = await import("../api/_lib/plan.js");

section("プラン上限の整合");
for (const bucket of ["lookup", "extract", "story", "review"] as const) {
  const free = PLAN_QUOTA.free[bucket];
  const pro = PLAN_QUOTA.pro[bucket];
  check(`${bucket}: Pro が Free 以上`, pro.day >= free.day && pro.month >= free.month, { free, pro });
  for (const [plan, q] of [["free", free], ["pro", pro]] as const) {
    check(`${bucket}(${plan}): 日 ≤ 週 ≤ 月`, q.day <= q.week && q.week <= q.month, q);
  }
}
check("extract は無料プランでは使えない（LPの表記と一致）", PLAN_QUOTA.free.extract.day === 0);
check("Pro の保存語数は無制限", PLAN_WORD_LIMIT.pro === null);
check("Free の保存語数に上限がある", typeof PLAN_WORD_LIMIT.free === "number" && PLAN_WORD_LIMIT.free > 0);

// ── Webhook の署名検証 ─────────────────────────────────────────

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_verification";
const { verifyWebhook } = await import("../api/_lib/stripe.js");

section("Webhook の署名検証");
const payload = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
const now = Math.floor(Date.now() / 1000);
const good = await sign(payload, process.env.STRIPE_WEBHOOK_SECRET, now);

const parsed = await verifyWebhook(payload, good);
check("正しい署名は通る", parsed.type === "customer.subscription.updated");

check(
  "本文を書き換えた署名は弾く",
  await rejects(() => verifyWebhook(payload.replace("sub_1", "sub_evil"), good))
);
check(
  "別の鍵で作った署名は弾く",
  await rejects(async () => verifyWebhook(payload, await sign(payload, "whsec_wrong", now)))
);
check(
  "5分より古い署名は弾く（リプレイ対策）",
  await rejects(async () =>
    verifyWebhook(payload, await sign(payload, process.env.STRIPE_WEBHOOK_SECRET!, now - 600))
  )
);
check("署名ヘッダが壊れていれば弾く", await rejects(() => verifyWebhook(payload, "garbage")));
check("v1 が無ければ弾く", await rejects(() => verifyWebhook(payload, `t=${now}`)));

// ── プラン判定 ────────────────────────────────────────────────

const { resolvePlan } = await import("../api/_lib/plan.js");
const realFetch = globalThis.fetch;

/** Firestore の応答を差し替える。 */
function stubFirestore(response: { ok: boolean; fields?: Record<string, unknown> }): void {
  globalThis.fetch = (async () =>
    ({
      ok: response.ok,
      json: async () => ({ fields: response.fields }),
    }) as unknown as Response) as typeof fetch;
}

const DAY = 24 * 60 * 60 * 1000;
const future = { integerValue: String(Date.now() + 30 * DAY) };

section("プラン判定");

stubFirestore({ ok: true, fields: { status: { stringValue: "active" }, currentPeriodEnd: future } });
check("active は pro", (await resolvePlan("t", "u")).plan === "pro");

stubFirestore({ ok: true, fields: { status: { stringValue: "trialing" }, currentPeriodEnd: future } });
check("trialing は pro", (await resolvePlan("t", "u")).plan === "pro");

stubFirestore({ ok: true, fields: { status: { stringValue: "canceled" }, currentPeriodEnd: future } });
check("canceled は free", (await resolvePlan("t", "u")).plan === "free");

stubFirestore({ ok: true, fields: { status: { stringValue: "incomplete" }, currentPeriodEnd: future } });
check("incomplete（未決済）は free", (await resolvePlan("t", "u")).plan === "free");

stubFirestore({
  ok: true,
  fields: {
    status: { stringValue: "active" },
    currentPeriodEnd: { integerValue: String(Date.now() - 10 * DAY) },
  },
});
check("期限切れ（猶予3日超）は free", (await resolvePlan("t", "u")).plan === "free");

stubFirestore({
  ok: true,
  fields: {
    status: { stringValue: "past_due" },
    currentPeriodEnd: { integerValue: String(Date.now() - 1 * DAY) },
  },
});
check("支払い遅延でも猶予期間内は pro のまま", (await resolvePlan("t", "u")).plan === "pro");

stubFirestore({ ok: false });
check("契約ドキュメントが無ければ free", (await resolvePlan("t", "u")).plan === "free");

globalThis.fetch = (async () => {
  throw new Error("network down");
}) as typeof fetch;
check("Firestore が落ちていても free に倒れる（緩まない）", (await resolvePlan("t", "u")).plan === "free");

globalThis.fetch = realFetch;

// ── 結果 ──────────────────────────────────────────────────────

console.log("");
if (failures > 0) {
  console.log(`${failures} 件失敗しました。`);
  process.exit(1);
}
console.log("すべて通りました。");
