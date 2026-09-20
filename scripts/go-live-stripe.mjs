/**
 * Stripe の審査が通ったあと、本番モードの課金を一度で開通させる。
 *
 * テストモードで作った商品・価格・Webhook は本番モードには引き継がれない。
 * 審査が通った日に手作業で作り直すと、価格を間違えたり Webhook を
 * 登録し忘れたりする。そこを自動化しておく。
 *
 *   node scripts/go-live-stripe.mjs sk_live_xxxxx --dry-run
 *   node scripts/go-live-stripe.mjs sk_live_xxxxx
 *
 * やること:
 *   1. 本番モードで請求が有効になっているか確認（通っていなければ止まる）
 *   2. 商品「Cortex Dictionary Pro」と価格（月600円 / 年4,800円）を作成
 *      ※ 同名の商品が既にあればそれを使い、価格の二重作成を避ける
 *   3. Webhook を登録して署名シークレットを取得
 *   4. Vercel の本番環境変数を差し替え、再デプロイ
 *   5. /api/health で billingConfigured を確認
 *
 * 秘密鍵は引数で受け取り、画面には出さない（末尾4文字だけ照合用に出す）。
 */

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
// 本番キーが原則。ただし --dry-run のときだけテストキーも受け付ける。
// このスクリプトは審査が通った日に一度しか動かさない。ぶっつけ本番にしないため、
// 事前にテストキーで通しの予行演習ができるようにしておく。
const sk = args.find((a) => /^(sk|rk)_(live|test)_/.test(a));
const isTestKey = sk ? sk.includes("_test_") : false;

if (isTestKey && !DRY) {
  console.error(`
渡されたのはテストキーです。本番の開通には sk_live_ で始まる鍵が要ります。
予行演習なら --dry-run を付けてください（何も作成しません）。
`);
  process.exit(1);
}
if (isTestKey) {
  console.log("");
  console.log("※ テストキーでの予行演習です。実際には何も作成しません。");
}

if (!sk) {
  console.error(`
本番の秘密鍵を渡してください。

  node scripts/go-live-stripe.mjs sk_live_xxxxx --dry-run
  node scripts/go-live-stripe.mjs sk_live_xxxxx

鍵は Stripe ダッシュボード（本番モード）の「開発者 > APIキー」にあります。
`);
  process.exit(1);
}

const BASE = "https://lexi-log-puce.vercel.app";
const WEBHOOK_URL = `${BASE}/api/billing-webhook`;
const EVENTS = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted"];

async function stripe(method, path, form) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + sk,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${body.error?.message ?? ""}`);
  return body;
}

function vercel(a, input) {
  const r = spawnSync("npx", ["vercel", ...a], {
    input, encoding: "utf8", shell: process.platform === "win32",
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// --- 1. アカウントの状態 ---
const acct = await stripe("GET", "/account");
console.log(`\nアカウント: ${acct.country} / 請求受付: ${acct.charges_enabled ? "可" : "不可"} / 入金: ${acct.payouts_enabled ? "可" : "不可"}`);
if (!acct.charges_enabled && !isTestKey) {
  console.error(`
まだ請求を受け付けられません。審査が完了していないか、追加の情報を求められています。
Stripe ダッシュボードの通知を確認してください。ここで止めます。
`);
  process.exit(1);
}
if (!acct.charges_enabled && isTestKey) {
  console.log("（テストモードなので請求受付が不可でも先へ進みます）");
}

// --- 2. 商品と価格 ---
const PRODUCT_NAME = "Cortex Dictionary Pro";
const products = await stripe("GET", "/products?active=true&limit=100");
let product = (products.data ?? []).find((p) => p.name === PRODUCT_NAME);

const plan = [];
if (product) {
  console.log(`商品: 既存を使います (${product.id})`);
} else {
  plan.push(`商品「${PRODUCT_NAME}」を作成`);
}

const wanted = [
  { key: "STRIPE_PRICE_MONTHLY", amount: 600, interval: "month", label: "月額600円" },
  { key: "STRIPE_PRICE_YEARLY", amount: 4800, interval: "year", label: "年額4,800円" },
];
const existingPrices = product
  ? (await stripe("GET", `/prices?product=${product.id}&active=true&limit=100`)).data ?? []
  : [];

for (const w of wanted) {
  const hit = existingPrices.find(
    (p) => p.unit_amount === w.amount && p.currency === "jpy" && p.recurring?.interval === w.interval
  );
  w.existing = hit?.id ?? null;
  if (!hit) plan.push(`価格「${w.label}」を作成`);
  else console.log(`価格: ${w.label} は既存を使います (${hit.id})`);
}

// --- 3. Webhook ---
const hooks = await stripe("GET", "/webhook_endpoints?limit=100");
let hook = (hooks.data ?? []).find((h) => h.url === WEBHOOK_URL);
if (hook) console.log(`Webhook: 既に登録済み (${hook.id})  ※署名シークレットは再取得できません`);
else plan.push("Webhook を登録");

console.log("\nこれから行うこと:");
if (plan.length === 0) console.log("  （作成するものはありません）");
plan.forEach((p) => console.log("  -", p));
console.log("  - Vercel の本番環境変数を更新して再デプロイ");

if (DRY) {
  console.log("\n--dry-run なのでここで終了します。");
  process.exit(0);
}

// --- 実行 ---
if (!product) {
  const f = new URLSearchParams({ name: PRODUCT_NAME, description: "英単語の意味・語源・分野ごとの用法をAIが生成する学習サービスの有料プラン" });
  product = await stripe("POST", "/products", f);
  console.log(`\n商品を作成しました: ${product.id}`);
}

for (const w of wanted) {
  if (w.existing) { w.id = w.existing; continue; }
  const f = new URLSearchParams({
    product: product.id, currency: "jpy",
    unit_amount: String(w.amount), "recurring[interval]": w.interval,
  });
  const price = await stripe("POST", "/prices", f);
  w.id = price.id;
  console.log(`価格を作成しました: ${w.label} → ${price.id}`);
}

let whsec = null;
if (!hook) {
  const f = new URLSearchParams({ url: WEBHOOK_URL, description: "Cortex Dictionary - 契約状態を Firestore に反映する" });
  EVENTS.forEach((e, i) => f.set(`enabled_events[${i}]`, e));
  hook = await stripe("POST", "/webhook_endpoints", f);
  whsec = hook.secret;
  console.log(`Webhook を登録しました: ${hook.id} (署名 ${whsec.slice(0, 9)}…)`);
} else {
  console.log(`
⚠️ Webhook は既に登録されていますが、署名シークレットは作成時にしか取得できません。
   分からない場合は Stripe ダッシュボードで該当の Webhook を削除してから、
   このスクリプトをもう一度実行してください。
`);
}

// --- 4. Vercel ---
const envs = [
  ["STRIPE_SECRET_KEY", sk],
  ["STRIPE_PRICE_MONTHLY", wanted[0].id],
  ["STRIPE_PRICE_YEARLY", wanted[1].id],
  ...(whsec ? [["STRIPE_WEBHOOK_SECRET", whsec]] : []),
];
console.log("");
for (const [k, v] of envs) {
  vercel(["env", "rm", k, "production", "--yes"]);
  const r = vercel(["env", "add", k, "production"], v + "\n");
  console.log(`  ${k.padEnd(22)} ${r.code === 0 ? "設定しました" : "失敗:\n" + r.out}`);
}

console.log("\n環境変数は再デプロイで反映されます。デプロイします…");
const d = vercel(["--prod"]);
console.log(d.out.split("\n").filter((l) => /Production|Error/.test(l)).join("\n"));

// --- 5. 確認 ---
await new Promise((r) => setTimeout(r, 30000));
const h = await (await fetch(`${BASE}/api/health`)).json();
console.log("\n本番の状態:", JSON.stringify(h));
console.log(h.billingConfigured ? "\n課金が開通しました。" : "\nまだ billingConfigured が false です。署名シークレットを確認してください。");
