/**
 * POST /api/extract — 英文から学習価値のある未知語を抽出する（実装仕様書 F5）。
 *
 * リクエスト:
 *   { text: string, known?: string[] }
 *     known … 既に保存済みの wordLower。プロンプトに含めて除外させる。
 *             ただしモデルの取りこぼしがあるので、サーバー側でも機械的に落とす。
 *
 * レスポンス:
 *   { candidates: { word, meaningShort, level, sentence }[] }
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { getClient, MODEL, FAST_THINKING } from "./_lib/gemini.js";
import { Type } from "@google/genai";

export const config = { runtime: "nodejs" };

const MAX_TEXT_LENGTH = 8000;
/** プロンプトに載せる既知語の上限。全部送るとトークンを食うだけで精度は上がらない。 */
const MAX_KNOWN = 2000;
const MAX_CANDIDATES = 60;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          meaningShort: { type: Type.STRING },
          level: { type: Type.STRING },
          sentence: { type: Type.STRING },
        },
        required: ["word", "meaningShort", "level", "sentence"],
      },
    },
  },
  required: ["candidates"],
} as const;

const LEVELS = new Set(["B2", "C1", "C2", "technical"]);

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "extract", async (_user, body) => {
    const text = String(body.text ?? "").trim();
    if (!text) return errorResponse(400, "英文が入力されていません。");
    if (text.length > MAX_TEXT_LENGTH) {
      return errorResponse(400, `英文が長すぎます（${MAX_TEXT_LENGTH}文字まで）。`);
    }

    const known = Array.isArray(body.known)
      ? body.known.map((w) => String(w).toLowerCase()).slice(0, MAX_KNOWN)
      : [];
    const knownSet = new Set(known);

    const ai = getClient();
    const response = await ai.models.generateContent({
      model: MODEL,
      contents:
        `Extract vocabulary worth learning from the English text below.\n\n` +
        `Rules:\n` +
        `- Target an advanced learner (CEFR B2 and above). Skip basic words.\n` +
        `- Return the dictionary form (lemma): "running" → "run", "studies" → "study".\n` +
        `- No proper nouns, numbers, or duplicates.\n` +
        `- At most ${MAX_CANDIDATES} entries, ordered by usefulness.\n` +
        `- meaningShort: a short Japanese gloss (under 30 characters).\n` +
        `- level: one of B2, C1, C2, technical.\n` +
        `- sentence: the sentence from the text where the word appears, verbatim.\n` +
        (known.length
          ? `- The learner already knows these words, exclude them:\n${known.join(", ")}\n`
          : "") +
        `\n--- TEXT ---\n${text}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        thinkingConfig: FAST_THINKING,
      },
    });

    let parsed: { candidates?: unknown };
    try {
      parsed = JSON.parse(response.text ?? "");
    } catch {
      return errorResponse(502, "AI の応答を解釈できませんでした。");
    }

    const seen = new Set<string>();
    const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
      .map((raw: any) => ({
        word: String(raw?.word ?? "").trim(),
        meaningShort: String(raw?.meaningShort ?? "").trim().slice(0, 100),
        level: LEVELS.has(raw?.level) ? raw.level : "C1",
        sentence: String(raw?.sentence ?? "").trim().slice(0, 300),
      }))
      // 意味が空だと軽量ドキュメントがルールの isValidWord を通らないので落とす
      .filter((c) => c.word && c.meaningShort && /^[a-zA-Z][a-zA-Z\-' ]*$/.test(c.word))
      .filter((c) => {
        const lower = c.word.toLowerCase();
        if (knownSet.has(lower) || seen.has(lower)) return false;
        seen.add(lower);
        return true;
      })
      .slice(0, MAX_CANDIDATES);

    return jsonResponse({ candidates });
  }, "extract");
}
