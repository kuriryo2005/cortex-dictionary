/**
 * 本番の Stripe が「本番モード」で動いているかを確かめる。
 *
 * 環境変数が本番キーに替わったかは Vercel からは読み出せない（秘匿値）。
 * 実際に決済セッションを作らせて、返ってきた URL が cs_live_ かどうかで判定する。
 * セッションを作るだけなので請求は一切発生しない。
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
const BASE = "https://lexi-log-puce.vercel.app";
const UID = "e2eLiveCheckoutDoNotUse001";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "OK  " : "NG  "} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const key = await importPKCS8(sa.private_key, "RS256");
const now = Math.floor(Date.now() / 1000);
const custom = await new SignJWT({ uid: UID })
  .setProtectedHeader({ alg: "RS256" })
  .setIssuer(sa.client_email).setSubject(sa.client_email)
  .setAudience("https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit")
  .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
const d = await (await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${cfg.apiKey}`,
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: custom, returnSecureToken: true }) }
)).json();
if (!d.idToken) throw new Error("ログインに失敗: " + JSON.stringify(d).slice(0, 300));

console.log("\n  本番モードの確認\n");
for (const interval of ["month", "year"]) {
  const r = await fetch(`${BASE}/api/billing-checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + d.idToken },
    body: JSON.stringify({ interval }),
  });
  const b = await r.json().catch(() => ({}));
  const url = b.url ?? "";
  const live = /\/pay\/cs_live_/.test(url);
  const test = /\/pay\/cs_test_/.test(url);
  check(
    `${interval === "month" ? "月額" : "年額"}の決済ページ`,
    r.status === 200 && live,
    r.status !== 200 ? `HTTP ${r.status} ${JSON.stringify(b).slice(0, 160)}`
      : test ? "まだテストモードです（cs_test_）" : url.slice(0, 48) + "…"
  );
}

console.log(failures ? `\n  ${failures} 件だめでした。\n` : "\n  本番モードで動いています。\n");
process.exitCode = failures ? 1 : 0;
