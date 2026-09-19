/**
 * POST /api/story — 語源のショートストーリー生成（実装仕様書 F1）。
 * 語彙ナレッジマップから呼ばれる。
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { getClient, MODEL, FAST_THINKING } from "./_lib/gemini.js";

export const config = { runtime: "nodejs" };

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "story", async (_user, body) => {
    const word = String(body.word ?? "").trim().slice(0, 64);
    const meaning = String(body.meaning ?? "").trim().slice(0, 200);
    const etymology = String(body.etymology ?? "").trim().slice(0, 1000);

    if (!word) return errorResponse(400, "単語が指定されていません。");

    const ai = getClient();
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `英語の単語「${word}」（意味: ${meaning}）について、その語源や歴史的な背景を、学習者がワクワクするような「30秒で読めるショートストーリー」として日本語で語ってください。
背景情報: ${etymology}`,
      config: { thinkingConfig: FAST_THINKING },
    });

    return jsonResponse({ story: response.text || "語源のストーリーは現在準備中です。" });
  }, "story");
}
