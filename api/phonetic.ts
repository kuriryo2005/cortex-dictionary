/**
 * POST /api/phonetic — 発音記号（IPA）だけを取りに行く軽量版（実装仕様書 F4）。
 *
 * 既存の保存済み単語には phonetic が無い。鉄則 R2 により一括更新はしないので、
 * 単語詳細を開いたときに1件ずつ遅延補完する。full lookup を投げると
 * 例文や語源まで再生成することになり、費用も時間も無駄なので専用に分けた。
 *
 * リクエスト: { word: string, mode?: "gen" | "aca" }
 * レスポンス: { phonetic: string }
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { withKeyFailover, MODEL, FAST_THINKING } from "./_lib/gemini.js";
import { Type } from "@google/genai";

export const config = { runtime: "nodejs" };

const MAX_WORD_LENGTH = 64;

const SCHEMA = {
  type: Type.OBJECT,
  properties: { phonetic: { type: Type.STRING } },
  required: ["phonetic"],
} as const;

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "phonetic", async (_user, body) => {
    const word = String(body.word ?? "").trim();
    if (!word) return errorResponse(400, "単語が指定されていません。");
    if (word.length > MAX_WORD_LENGTH) {
      return errorResponse(400, `単語が長すぎます（${MAX_WORD_LENGTH}文字まで）。`);
    }

    const response = await withKeyFailover((ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents:
          `Give the IPA pronunciation of the English word "${word}".\n` +
          `Return the IPA WITHOUT surrounding slashes (e.g. ˈtɜːbjələns for "turbulence").`,
        config: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          thinkingConfig: FAST_THINKING,
        },
      })
    );

    const text = response.text ?? "";
    let phonetic = "";
    try {
      phonetic = String((JSON.parse(text) as { phonetic?: unknown }).phonetic ?? "");
    } catch {
      return errorResponse(502, "AI の応答を解釈できませんでした。");
    }

    // 前後のスラッシュはモデルが付けてくることがあるので保存前に落とす
    phonetic = phonetic.trim().replace(/^\/+|\/+$/g, "").slice(0, 100);
    if (!phonetic) return errorResponse(502, "発音記号を取得できませんでした。");

    return jsonResponse({ phonetic });
  }, "review");
}
