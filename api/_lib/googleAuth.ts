/**
 * サービスアカウントで Google API のアクセストークンを取得する。
 *
 * Stripe の Webhook はユーザーの ID トークンを持たないため、契約状態を
 * `subscriptions/{uid}` に書き込むにはサーバー権限が要る。firebase-admin を
 * 足すとバンドルが重く Node 専用になるので、既に依存にある jose で
 * サービスアカウント JWT を自前署名し、OAuth2 のトークンエンドポイントで
 * アクセストークンに交換する（Firestore REST を叩くのは quota.ts と同じ）。
 *
 * 秘密情報を GEMINI_API_KEY 1本に抑える当初方針からは外れるが、課金の
 * 改ざん防止（ユーザーが自分を Pro にできないこと）はそれより優先される。
 * 鍵は課金 Webhook 以外からは読まない。
 */

import { SignJWT, importPKCS8 } from "jose";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cached: { token: string; expiresAt: number } | null = null;

function readServiceAccount(): ServiceAccount {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT が設定されていません。");
  // Vercel の環境変数に貼るとき改行が \n のままになることがあるので両対応にする
  const json = JSON.parse(raw) as ServiceAccount;
  return { ...json, private_key: json.private_key.replace(/\n/g, "\n") };
}

/** Firestore を読み書きできるアクセストークンを返す（有効期限まで使い回す）。 */
export async function getServiceAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const sa = readServiceAccount();
  const key = await importPKCS8(sa.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`アクセストークンの取得に失敗しました: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  // 期限の 60 秒手前で切れたことにして、境界での失敗を避ける
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}
