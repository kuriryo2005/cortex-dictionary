/**
 * Stripe の審査が通ったかを確認する。
 *
 * 通過のメールを見落とすと、その間ずっと受け取れない。定期タスクから毎日見る。
 * テストキーでもアカウント自体の状態（提出済みか・請求を受け付けられるか）は
 * 読めるので、本番キーが手元に無くても判定できる。
 *
 *   node scripts/check-stripe-live.mjs
 *
 * 終了コード 0 = 通過済み / 1 = 審査中 or 追加対応が必要
 */

import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);

const r = await fetch("https://api.stripe.com/v1/account", {
  headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY },
});
const a = await r.json();
if (!r.ok) {
  console.error("Stripe に問い合わせできませんでした:", a.error?.message);
  process.exitCode = 1;
}

const req = a.requirements ?? {};
const due = [...(req.currently_due ?? []), ...(req.past_due ?? [])];

console.log(`
  事業形態    ${a.business_type ?? "(未設定)"}
  詳細の提出  ${a.details_submitted}
  請求受付    ${a.charges_enabled}
  入金        ${a.payouts_enabled}`);

let handled = false;
if (due.length) {
  handled = true;
  console.log("\n  Stripe が追加で求めている項目:");
  due.forEach((x) => console.log("   -", x));
  console.log("\n  → ダッシュボードで対応が必要です。**栗田さんに伝えること。**");
  process.exitCode = 1;
}
if (!handled && req.disabled_reason) {
  handled = true;
  console.log(`\n  保留の理由: ${req.disabled_reason}`);
  console.log("  → ダッシュボードの通知を確認してください。**栗田さんに伝えること。**");
  process.exitCode = 1;
}

if (!handled && a.charges_enabled) {
  handled = true;
  console.log(`
  審査を通過しています。本番課金を開通できます。

  栗田さんに次を伝えること:
    Stripe ダッシュボードを「本番モード」に切り替え、
    開発者 > APIキー から sk_live_ で始まる秘密鍵をコピーして、
    以下を実行してください。

      cd C:\Users\kurir\Downloads\LexiLog
      node scripts/go-live-stripe.mjs sk_live_（本番の秘密鍵）
`);
  process.exitCode = 0;
}

console.log("\n  まだ審査中です。不足項目はありません。数日〜1週間かかります。");
process.exitCode = 1;
