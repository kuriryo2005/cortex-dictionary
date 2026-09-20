/**
 * 本番で、実際にログインして単語を保存できるかを確かめる。
 *
 * 「アプリで単語を1つ保存してみてください」と何度もお願いしていたが、
 * サービスアカウントでカスタムトークンを作れば、こちらで確かめられる。
 * 実際、サービスアカウントが壊れていた間は保存が全部失敗していたので、
 * 人に頼んでいる限り気付くのが遅れる。
 *
 * 確かめること:
 *   1. 保存できる
 *   2. 無料プランの 30 語の上限が本当に効く
 *   3. 上限に当たったときの応答が正しい（403 / upgradable）
 *   4. JSON 復元が Pro 限定になっている
 *
 * 使い捨ての uid で行い、最後に必ず全部消す。
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
const UID = "e2eSaveCheckDoNotUse000001";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "OK  " : "NG  "} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/** サービスアカウントでカスタムトークンを作り、ID トークンに交換する。 */
async function signIn() {
  const key = await importPKCS8(sa.private_key.replace(/\n/g, "\n"), "RS256");
  const now = Math.floor(Date.now() / 1000);
  const aud = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
  const custom = await new SignJWT({ uid: UID })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email).setSubject(sa.client_email).setAudience(aud)
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);

  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${cfg.apiKey}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }) }
  );
  const d = await r.json();
  if (!d.idToken) throw new Error("ログインに失敗: " + JSON.stringify(d).slice(0, 300));
  return d.idToken;
}

async function saveWords(idToken, words, source = "search") {
  const r = await fetch(`${BASE}/api/save-words`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + idToken },
    body: JSON.stringify({ words, source }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const word = (n) => ({ word: `e2eword${n}`, meaning: `検証用${n}` });

// --- Firestore の後片付け（サービスアカウント権限） ---
async function serviceToken() {
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
const DOCS = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents`;

/**
 * 単語はサブコレクションではなく、トップレベルの words に userId を持たせて
 * 入っている（api/_lib/wordStore.ts）。ここを users/{uid}/words だと思い込んで
 * いて、検証データを消せていなかった。消し残しは本番を汚すので必ず確かめる。
 */
async function cleanup(tok) {
  let removed = 0;
  for (;;) {
    const r = await fetch(`${DOCS}:runQuery`, {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "words" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "userId" },
              op: "EQUAL",
              value: { stringValue: UID },
            },
          },
          limit: 300,
        },
      }),
    });
    const rows = (await r.json()).filter?.((x) => x.document) ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      await fetch(`https://firestore.googleapis.com/v1/${row.document.name}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + tok },
      });
      removed++;
    }
    if (rows.length < 300) break;
  }
  await fetch(`${DOCS}/usage_counters/${UID}`, { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
  return removed;
}

const tok = await serviceToken();
console.log("\n0. 前回の残りを掃除");
check("掃除できた", true, `${await cleanup(tok)} 件`);

console.log("\n1. ログインできるか");
const idToken = await signIn();
check("カスタムトークンでログインできた", Boolean(idToken));

console.log("\n2. 単語を保存できるか");
{
  const r = await saveWords(idToken, [word(1)]);
  check("1語保存できる", r.status === 200 && r.body.written === 1, `status=${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  check("プランは free", r.body.plan === "free", `plan=${r.body.plan}`);
  check("上限は 30", r.body.limit === 30, `limit=${r.body.limit}`);
}

console.log("\n3. 30語の上限が本当に効くか");
{
  const r = await saveWords(idToken, Array.from({ length: 29 }, (_, i) => word(i + 2)));
  check("あと29語で満杯にできる", r.status === 200, `status=${r.status}`);
  const over = await saveWords(idToken, [word(99)]);
  check("31語目は拒否される", over.status === 403, `status=${over.status}`);
  check("upgradable が返る", over.body.upgradable === true, JSON.stringify(over.body).slice(0, 140));
}

console.log("\n4. JSON 復元が Pro 限定か");
{
  const r = await saveWords(idToken, [word(1000)], "restore");
  check("無料プランでは復元できない", r.status === 403, `status=${r.status}`);
}

console.log("\n5. 後片付け");
check("検証データを削除した", (await cleanup(tok)) >= 30);

console.log(`\n${failures === 0 ? "すべて通りました。" : failures + " 件 failed。"}`);
process.exit(failures === 0 ? 0 : 1);
