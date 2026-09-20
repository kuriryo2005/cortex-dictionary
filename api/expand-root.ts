/**
 * POST /api/expand-root — 語根を共有する単語を追加で探す（実装仕様書 F1）。
 * 語源グラフでノードをクリックしたときに呼ばれる。
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { withKeyFailover, withModelFallback, MODEL, FAST_THINKING } from "./_lib/gemini.js";
import { Type } from "@google/genai";

export const config = { runtime: "nodejs" };

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "story", async (_user, body) => {
    const root = String(body.root ?? "").trim().slice(0, 64);
    if (!root) return errorResponse(400, "語根が指定されていません。");

    const response = await withModelFallback((model) =>
      withKeyFailover((ai) =>
        ai.models.generateContent({
          model,
          contents: `Find 3 more English words that share the same etymological root "${root}".
    Return a JSON array of objects with fields: word, meaning (in Japanese), and root (the string "${root}").`,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  word: { type: Type.STRING },
                  meaning: { type: Type.STRING },
                  root: { type: Type.STRING },
                },
                required: ["word", "meaning", "root"],
              },
            },
            thinkingConfig: FAST_THINKING,
          },
        })
      )
    );

    const text = response.text;
    if (!text) return errorResponse(502, "AI の応答が空でした。");

    const parsed = JSON.parse(text);
    return jsonResponse({ words: Array.isArray(parsed) ? parsed.slice(0, 5) : [] });
  }, "story");
}
