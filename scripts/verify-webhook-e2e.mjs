/**
 * 本番の Stripe Webhook が、実際に契約状態を書き込むかを確かめる。
 *
 * 決済が通っても Pro にならない、という失敗が一番痛い。お金だけ受け取って
 * 機能が開かない状態になる。ブラウザで実際に購入する前に、
 * 「Stripe が叩く経路」そのものを署名付きで叩いて確かめておく。
 *
 * 使い捨ての uid で書き、最後に必ず消す。実ユーザーには触れない。
 *
 *   node scripts/verify-webhook-e2e.mjs
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const BASE = "https://lexi-log-puce.vercel.app";
const WHSEC = env.STRIPE_WEBHOOK_SECRET;
// Firestore は __…__ という形の ID を予約語として拒否する（400）。
// 実ユーザーの uid（28文字の英数）と同じ形にしておく。
const UID = "e2eWebhookCheckDoNotUse0001";
if (!WHSEC) throw new Error("STRIPE_WEBHOOK_SECRET がありません。");

/** Stripe と同じ形式で署名する（t=…,v1=HMAC-SHA256(t.payload)）。 */
function sign(payload, secret, ts = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  return `t=${ts},v1=${mac}`;
}

async function post(payload, header) {
  const res = await fetch(`${BASE}/api/billing-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
  return { status: res.status, body: (await res.text()).slice(0, 160) };
}

function subEvent(type, status, periodEndSec) {
  return JSON.stringify({
    id: "evt_e2e_" + Date.now(),
    type,
    data: {
      object: {
        id: "sub_e2e_check",
        status,
        metadata: { uid: UID },
        customer: "cus_e2e_check",
        current_period_end: periodEndSec,
        items: { data: [{ price: { id: env.STRIPE_PRICE_MONTHLY } }] },
      },
    },
  });
}

// --- Firestore をサービスアカウントで読む（api/_lib と同じ手順） ---
const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
async function accessToken() {
  const key = await importPKCS8(sa.private_key.replace(/\n/g, "\n"), "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("トークン取得に失敗: " + JSON.stringify(d).slice(0, 200));
  return d.access_token;
}
// Firestore は既定 DB ではなく名前付き DB を使っている。
// ここを (default) にしていて、書けているのに読めない、という誤診をした。
const cfg = JSON.parse(fs.readFileSync("firebase-applet-config.json", "utf8"));
const DOC = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/subscriptions/${UID}`;

async function readDoc(tok) {
  const r = await fetch(DOC, { headers: { Authorization: "Bearer " + tok } });
  if (r.status === 404) return null;
  const d = await r.json();
  return Object.fromEntries(
    Object.entries(d.fields ?? {}).map(([k, v]) => [k, Object.values(v)[0]])
  );
}

const tok = await accessToken();
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "OK  " : "NG  "} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

console.log("\n1. 署名が正しくないイベントは拒否されるか");
{
  const p = subEvent("customer.subscription.updated", "active", Math.floor(Date.now() / 1000) + 2592000);
  const r = await post(p, sign(p, "whsec_wrong_secret_value"));
  check("不正な署名を 400 で弾く", r.status === 400, `status=${r.status}`);
}

console.log("\n2. 古いイベント（再送攻撃）は拒否されるか");
{
  const p = subEvent("customer.subscription.updated", "active", Math.floor(Date.now() / 1000) + 2592000);
  const old = Math.floor(Date.now() / 1000) - 60 * 60;
  const r = await post(p, sign(p, WHSEC, old));
  check("1時間前の署名を弾く", r.status === 400, `status=${r.status}`);
}

console.log("\n3. 契約が有効になったとき Pro になるか");
{
  const end = Math.floor(Date.now() / 1000) + 2592000;
  const p = subEvent("customer.subscription.updated", "active", end);
  const r = await post(p, sign(p, WHSEC));
  check("Webhook が 200 を返す", r.status === 200, `status=${r.status} ${r.body}`);
  const doc = await readDoc(tok);
  check("subscriptions に書き込まれた", doc !== null);
  check("status=active", doc?.status === "active", `status=${doc?.status}`);
}

console.log("\n4. 解約されたとき Pro が外れるか");
{
  const p = subEvent("customer.subscription.deleted", "canceled", Math.floor(Date.now() / 1000));
  const r = await post(p, sign(p, WHSEC));
  check("Webhook が 200 を返す", r.status === 200, `status=${r.status}`);
  const doc = await readDoc(tok);
  check("status=canceled", doc?.status === "canceled", `status=${doc?.status}`);
}

console.log("\n5. 後片付け");
{
  const r = await fetch(DOC, { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
  check("検証用のドキュメントを削除した", r.ok, `status=${r.status}`);
}

console.log(`\n${failures === 0 ? "すべて通りました。" : failures + " 件failed。"}`);
process.exit(failures === 0 ? 0 : 1);
