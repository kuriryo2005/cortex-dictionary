/**
 * Firebase ID トークンの検証（実装仕様書 F1）。
 *
 * firebase-admin を使わず Google の公開鍵で検証する。
 * サービスアカウントの秘密鍵を増やさずに済むのが狙い（管理する秘密情報を
 * GEMINI_API_KEY 1本に抑える）。
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };

const PROJECT_ID = firebaseConfig.projectId;
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

/**
 * Firebase の ID トークンは securetoken 用の x509 証明書で署名されるが、
 * 同じ鍵は JWKS 形式でも配布されている。jose の remote JWKS はレスポンスの
 * Cache-Control に従ってキャッシュするので、毎リクエスト取りに行くことはない。
 */
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

export interface AuthedUser {
  uid: string;
  email?: string;
  /**
   * Google などの発行元がメールアドレスを確認済みか。
   * 運営者の判定（plan.ts の isOwner）で使うので、無いときは信用しない。
   */
  emailVerified?: boolean;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Authorization: Bearer <ID token> を検証してユーザーを返す。
 * 検証に失敗した場合は AuthError を投げる。
 */
export async function requireUser(request: Request): Promise<AuthedUser> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new AuthError("認証トークンがありません。");

  const token = match[1];

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: PROJECT_ID,
      algorithms: ["RS256"],
    });
    payload = result.payload as Record<string, unknown>;
  } catch (e) {
    throw new AuthError(`トークンの検証に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }

  // sub が Firebase の uid。jwtVerify が exp / iat / iss / aud は検証済み。
  const uid = typeof payload.sub === "string" ? payload.sub : "";
  if (!uid) throw new AuthError("トークンに uid が含まれていません。");

  // auth_time が未来のトークンは受け付けない（時計ずれの許容は 5 分）
  const authTime = typeof payload.auth_time === "number" ? payload.auth_time : 0;
  if (authTime && authTime > Date.now() / 1000 + 300) {
    throw new AuthError("トークンの auth_time が不正です。");
  }

  return {
    uid,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
  };
}
