/**
 * 検索ログ（search_log）の直近7日の集計。読むだけ。
 * 使い方: node scripts/searches.mjs [日数]
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

async function token(scope = "https://www.googleapis.com/auth/datastore") {
  const key = await importPKCS8(sa.private_key.replace(/\n/g, "\n"), "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  return (await r.json()).access_token;
}

const DAYS = Number(process.argv[2] || 7);
const tok = await token();
const since = new Date(Date.now() - DAYS * 86400000).toISOString();
const res = await fetch(`https://firestore.googleapis.com/v1/${DB}/documents:runQuery`, {
  method: "POST", headers: { Authorization: "Bearer " + tok, "content-type": "application/json" },
  body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: "search_log" }],
    where: { fieldFilter: { field: { fieldPath: "at" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: since } } },
    limit: 2000,
  } }),
}).then((r) => r.json());
const rows = res.filter((x) => x.document).map((x) => Object.fromEntries(Object.entries(x.document.fields).map(([k, v]) => [k, Object.values(v)[0]])));
const tally = (key) => Object.entries(rows.reduce((m, r) => ((m[r[key] ?? "-"] = (m[r[key] ?? "-"] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
console.log(`\n  検索ログ（直近${DAYS}日）: ${rows.length} 件`);
console.log(`  ゲスト ${rows.filter((r) => r.guest).length} / ログイン ${rows.filter((r) => !r.guest).length}`);
console.log(`  日別: ${tally("day").sort().map(([d, n]) => `${d.slice(5)} ${n}`).join(" / ") || "-"}`);
console.log(`  解決先: ${tally("source").map(([k, n]) => `${k} ${n}`).join(" / ") || "-"}`);
console.log(`  流入元: ${tally("ref").map(([k, n]) => `${k} ${n}`).join(" / ") || "-"}`);
console.log(`  よく引かれた語: ${tally("word").slice(0, 20).map(([k, n]) => `${k}(${n})`).join(" ") || "-"}\n`);
