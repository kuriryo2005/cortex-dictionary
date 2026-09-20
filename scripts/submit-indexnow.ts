/**
 * IndexNow で公開ページのクロールを依頼する。
 *
 *   npx tsx scripts/submit-indexnow.ts
 *
 * Google Search Console はアカウント登録が要るが、IndexNow は
 * 「サイトに鍵ファイルを置く」だけで使える。Bing / Yandex / Naver /
 * Seznam が対応していて、1回の POST で複数 URL のクロールを依頼できる。
 *
 * 依頼するのは sitemap.xml に載っている、既に公開済みのページだけ。
 * robots.txt でクロールを許可しているものと同じ範囲で、新しく何かを
 * 公開するわけではない。
 *
 * 鍵は public/<key>.txt に置いてあり、中身が鍵そのものであることを
 * 検索エンジン側が確認する。鍵を変えたらこのファイルの KEY も変える。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SITE = process.env.APP_BASE_URL ?? "https://lexi-log-puce.vercel.app";
const host = new URL(SITE).host;

// public/ に置いた <32桁>.txt を鍵とみなす
const keyFile = readdirSync(join(process.cwd(), "public")).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) {
  console.error("public/ に IndexNow の鍵ファイル（<32桁の16進>.txt）がありません。");
  process.exit(1);
}
const key = keyFile.replace(/\.txt$/, "");

// sitemap.xml から URL を読む（公開済みのものだけが載っている）
const sitemap = readFileSync(join(process.cwd(), "public", "sitemap.xml"), "utf-8");
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

console.log(`ホスト: ${host}`);
console.log(`鍵: ${key}`);
console.log(`送信する URL: ${urlList.length} 件`);

const res = await fetch("https://api.indexnow.org/IndexNow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host,
    key,
    keyLocation: `${SITE}/${keyFile}`,
    urlList,
  }),
});

// 200/202 が受理。422 は鍵が確認できていない（デプロイ前など）
console.log(`結果: ${res.status} ${res.statusText}`);
const body = await res.text();
if (body) console.log(body.slice(0, 300));
