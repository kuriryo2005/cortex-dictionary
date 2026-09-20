/**
 * いま何人が使っていて、何語引かれたかを数える。
 *
 * 集客を始めたので、効いたかどうかを数字で見られるようにする。
 * 「まず上限3で出してデータを見る」と決めた以上、そのデータを取る手段が要る。
 *
 *   node scripts/metrics.mjs
 *
 * 読むだけで何も書き換えない。サービスアカウントで Firestore を集計する。
 */

import fs from "node:fs";
import { SignJWT, importPKCS8 } from "jose";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const cfg = JSON.parse(fs.readFileSync("firebase-applet-config.json", "utf8"));
const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
const DB = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}`;

async function token() {
  const key = await importPKCS8(sa.private_key.replace(/\n/g, "\n"), "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  return (await r.json()).access_token;
}

/** コレクションの件数。where を渡せば絞り込める。 */
async function count(tok, collectionId, where) {
  const q = { from: [{ collectionId }] };
  if (where) q.where = where;
  const r = await fetch(`https://firestore.googleapis.com/v1/${DB}/documents:runAggregationQuery`, {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: q, aggregations: [{ alias: "n", count: {} }] } }),
  });
  const d = await r.json();
  const v = d?.[0]?.result?.aggregateFields?.n?.integerValue;
  return v === undefined ? "?" : Number(v);
}

const since = (days) => ({
  fieldFilter: {
    field: { fieldPath: "timestamp" },
    op: "GREATER_THAN",
    value: { integerValue: String(Date.now() - days * 86400000) },
  },
});

const tok = await token();
const [users, words, words1d, words7d, cache, subs] = await Promise.all([
  count(tok, "users"),
  count(tok, "words"),
  count(tok, "words", since(1)),
  count(tok, "words", since(7)),
  count(tok, "dictionary_cache"),
  count(tok, "subscriptions"),
]);

const pad = (s) => String(s).padStart(6);
console.log(`
  登録ユーザー        ${pad(users)}
  保存された単語      ${pad(words)}   （24時間 ${words1d} / 7日 ${words7d}）
  収録済みの語（累計） ${pad(cache)}
  契約レコード        ${pad(subs)}
`);
if (users === 0 || users === "?") {
  console.log("  まだ誰も登録していません。集客の結果が出るまで数日かかります。");
} else if (subs === 0) {
  console.log("  登録はあるが契約ゼロ。無料枠で足りているか、Pro の価値が伝わっていない。");
}
