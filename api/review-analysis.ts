/**
 * POST /api/review-analysis — 苦手分析の生成（実装仕様書 F1）。
 *
 * NOTE: 復習間隔の決定はこのエンドポイントから外れた。いまは
 * src/lib/srs.ts がローカルで決める（同期・無課金・決定的）。
 * クライアントがここを呼ぶのは「何度やっても抜けない語」（AGAIN 6 回以上）に
 * 限られ、使うのは aiAnalysis だけ。nextReviewAt は後方互換のために
 * 返し続けているが、呼び出し側は読んでいない。
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { withKeyFailover, MODEL, FAST_THINKING } from "./_lib/gemini.js";
import { Type } from "@google/genai";

export const config = { runtime: "nodejs" };

const MAX_HISTORY = 200;

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "review", async (_user, body) => {
    const word = String(body.word ?? "").trim();
    const meaning = String(body.meaning ?? "").trim();
    if (!word) return errorResponse(400, "単語が指定されていません。");

    const history = Array.isArray(body.reviewHistory) ? body.reviewHistory.slice(-MAX_HISTORY) : [];
    const synonyms = Array.isArray(body.synonyms) ? body.synonyms.slice(0, 10) : [];

    const historyStr = history
      .map((h) => {
        const rec = h as { rating?: unknown; timestamp?: unknown };
        const ts = typeof rec.timestamp === "number" ? new Date(rec.timestamp).toISOString() : "unknown";
        return `Rating: ${String(rec.rating ?? "?")} at ${ts}`;
      })
      .join("\n");

    const synonymsStr = synonyms
      .map((s) => (s && typeof s === "object" ? String((s as { word?: unknown }).word ?? "") : String(s)))
      .filter(Boolean)
      .join(", ");

    const response = await withKeyFailover((ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents: `Analyze the learning progress for the English word "${word}" (Meaning: ${meaning}).
  Review History:
  ${historyStr || "First time being reviewed."}

  Based on the retention patterns, linguistic similarity to other words (like ${synonymsStr || "none"}), and common pitfalls for this type of word, determine the optimal "Next Review Date".
  Also provide a short "AI Analysis" in Japanese explaining why this word might be difficult for the user (e.g., confusion with similar roots, structural complexity).

  Current time (Unix ms): ${Date.now()}

  Return JSON with:
  - nextReviewAt: number (Unix timestamp in milliseconds, must be in the future)
  - aiAnalysis: string (In Japanese)`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              nextReviewAt: { type: Type.NUMBER },
              aiAnalysis: { type: Type.STRING },
            },
            required: ["nextReviewAt", "aiAnalysis"],
          },
          thinkingConfig: FAST_THINKING,
        },
      })
    );

    const text = response.text;
    if (!text) return errorResponse(502, "AI の応答が空でした。");

    const parsed = JSON.parse(text) as { nextReviewAt?: unknown; aiAnalysis?: unknown };

    // AI が過去の日時を返すことがあるため、最低でも10分後に矯正する
    const floor = Date.now() + 10 * 60 * 1000;
    const nextReviewAt =
      typeof parsed.nextReviewAt === "number" && parsed.nextReviewAt > floor
        ? parsed.nextReviewAt
        : floor;

    return jsonResponse({
      nextReviewAt,
      aiAnalysis: typeof parsed.aiAnalysis === "string" ? parsed.aiAnalysis : "",
    });
  }, "review");
}
