/**
 * API ハンドラの共通処理（実装仕様書 F1）。
 *
 * Web 標準の Request / Response で書いてあるため、Vercel Functions でも
 * Vite の開発サーバー（scripts/devApiPlugin.ts）でも同じコードが動く。
 */

import { AuthError, requireUser, type AuthedUser } from "./auth.js";
import { consume, RateLimitError, type RateLimitName } from "./ratelimit.js";
import { checkAndConsumeQuota } from "./quota.js";
import type { QuotaBucket } from "./plan.js";

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function errorResponse(status: number, message: string, extra: Record<string, unknown> = {}) {
  return jsonResponse({ error: message, ...extra }, status);
}

/**
 * POST + 認証 + レート制限 + プラン別の利用上限をまとめて処理する。
 * 認証に通ればハンドラを呼び、失敗すれば適切なステータスを返す。
 *
 * `quotaBucket` を渡すと、Gemini の実費に対するプラン別の日/週/月の上限を
 * 消費する（api/_lib/quota.ts）。実費の出ないエンドポイントでは省略する。
 * レート制限（インメモリ・1時間単位）は乱打を防ぐためのもので、
 * サーバーレスではインスタンスごとにリセットされるため上限の役には立たない。
 * 課金に関わる歯止めは必ず quotaBucket 側で行うこと。
 */
export async function withAuth(
  request: Request,
  limit: RateLimitName,
  handler: (user: AuthedUser, body: Record<string, unknown>) => Promise<Response>,
  quotaBucket?: QuotaBucket
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "POST を使ってください。");
  }

  let user: AuthedUser;
  try {
    user = await requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(401, "ログインが必要です。");
    throw e;
  }

  try {
    consume(limit, user.uid);
  } catch (e) {
    if (e instanceof RateLimitError) {
      return errorResponse(429, "リクエストが多すぎます。しばらく待ってから試してください。", {
        retryAfterSec: e.retryAfterSec,
      });
    }
    throw e;
  }

  if (quotaBucket) {
    const idToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const quota = await checkAndConsumeQuota(idToken, user.uid, quotaBucket, user);
    if (quota.ok === false) {
      // upgradable のときクライアントはアップグレード導線を出す
      return errorResponse(429, quota.message, { plan: quota.plan, upgradable: quota.upgradable });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "リクエストの形式が正しくありません。");
  }

  try {
    return await handler(user, body);
  } catch (e) {
    console.error(`[api:${limit}] handler error`, e);
    return aiErrorResponse(e);
  }
}

/**
 * AI 呼び出しの失敗を、利用者に意味の通る応答へ変える。
 *
 * これまで全部まとめて「AI の応答に失敗しました」を返していた。実際には
 * 原因によって利用者が取るべき行動が違う。特に、こちら側の枠が尽きている
 * ときに「失敗しました」とだけ出すのは不誠実で、しかも収録済みの単語なら
 * 問題なく引けることが伝わらない。
 */
export type AiFailure = { status: number; message: string; reason?: "capacity" | "busy" };

export function classifyAiError(e: unknown): AiFailure {
  const message = (e instanceof Error ? e.message : String(e)).toLowerCase();

  if (message.includes("gemini_api_key")) {
    return { status: 500, message: "サーバーの設定が不足しています。" };
  }

  // こちら側の利用枠が尽きている。利用者の操作では直らないので、
  // 何が使えて何が使えないのかまで伝える。
  if (
    message.includes("credits are depleted") ||
    message.includes("spending cap") ||
    message.includes("402") ||
    message.includes("429") ||
    message.includes("resource_exhausted") ||
    message.includes("quota")
  ) {
    return {
      status: 503,
      reason: "capacity",
      message:
        "ただいま新しい単語の解説を生成できません（提供側の利用枠が上限に達しています）。" +
        "復旧まで少しお時間をいただきます。すでに辞書に収録されている単語の検索、" +
        "保存した単語の閲覧と復習はこれまで通りご利用いただけます。",
    };
  }

  // モデルの混雑。時間を置けば直るので、そう伝える。
  if (message.includes("503") || message.includes("unavailable") || message.includes("overloaded")) {
    return { status: 503, reason: "busy", message: "AI が混み合っています。少し時間をおいてお試しください。" };
  }

  if (e instanceof SyntaxError) {
    return { status: 502, message: "AI の応答を解釈できませんでした。もう一度お試しください。" };
  }

  return { status: 502, message: "AI の応答に失敗しました。時間をおいてお試しください。" };
}

export function aiErrorResponse(e: unknown): Response {
  const f = classifyAiError(e);
  return errorResponse(f.status, f.message, f.reason ? { reason: f.reason } : {});
}

/** Server-Sent Events の1行を組み立てる。 */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};
