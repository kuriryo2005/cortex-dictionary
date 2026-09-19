/**
 * サーバー側の Gemini クライアントとプロンプト定義（実装仕様書 F1）。
 *
 * GEMINI_API_KEY はサーバーの環境変数からのみ読む。
 * このファイルはブラウザに配信されないため、キーがクライアントへ漏れない。
 */

import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";

/**
 * 使用モデル。
 *
 * 旧: gemini-3-flash-preview（プレビュー版）
 * 実測で最初のトークンまで 15〜20 秒かかり、合計 17〜23 秒。thinkingLevel を
 * MINIMAL にしてもスキーマを小さくしても改善しなかった（scripts/bench-latency.ts）。
 * gemini-2.5-flash は同じ内容を TTFT 1.0 秒 / 合計 4.2 秒で返すため、しばらくこちらを使っていた。
 *
 * 2026-09: gemini-3.8-flash（正式版、プレビューではない）を試験導入。品質を見て
 * 2.5-flash に戻すか判断する。thinkingBudget は Gemini 3 系では非推奨のため
 * thinkingLevel に切り替えている（下記 FAST_THINKING 参照。MINIMAL は 3.8-flash
 * では無効なので使えず、最速設定は LOW）。
 */
export const MODEL = "gemini-3.8-flash";

/**
 * 複数の Gemini API キーをラウンドロビンで使い分ける。
 *
 * 無料枠は1プロジェクト（1キー）あたりのレート制限なので、検索が集中すると
 * 429 で失敗することがある。GEMINI_API_KEY に加えて GEMINI_API_KEY_2,
 * GEMINI_API_KEY_3, ... を環境変数に足すと、リクエストのたびに順番に
 * キーを切り替えて負荷を分散する（1キーだけの場合は従来どおり単一キーで動く）。
 */
let clients: GoogleGenAI[] | null = null;
let roundRobinIndex = 0;

function loadClients(): GoogleGenAI[] {
  if (clients) return clients;

  const keys: string[] = [];
  const primary = process.env.GEMINI_API_KEY;
  if (primary) keys.push(primary);
  for (let i = 2; ; i++) {
    const extra = process.env[`GEMINI_API_KEY_${i}`];
    if (!extra) break;
    keys.push(extra);
  }

  if (keys.length === 0) {
    throw new Error("GEMINI_API_KEY が設定されていません（サーバー環境変数）。");
  }

  clients = keys.map((apiKey) => new GoogleGenAI({ apiKey }));
  return clients;
}

/** 呼び出すたびにラウンドロビンで次のキーのクライアントを返す。 */
export function getClient(): GoogleGenAI {
  const pool = loadClients();
  const c = pool[roundRobinIndex % pool.length];
  roundRobinIndex = (roundRobinIndex + 1) % pool.length;
  return c;
}

export type ModeSlug = "gen" | "aca";

export function modeLabel(mode: ModeSlug): string {
  return mode === "aca" ? "学術（Academic）" : "一般";
}

const wordRelation = {
  type: Type.OBJECT,
  properties: {
    word: { type: Type.STRING },
    translation: { type: Type.STRING },
  },
  required: ["word", "translation"],
} as const;

/** WordDetail の構造化出力スキーマ。プロパティの並び順が生成順になる。 */
export const WORD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    // 先に返ってほしい軽い項目を前に置く（ストリーミングで早く表示するため）
    word: { type: Type.STRING },
    meaning: { type: Type.STRING },
    grammar: { type: Type.STRING },
    phonetic: { type: Type.STRING },
    // 紙面（単語帳）で使う項目。左ページの中身なので早めに返してほしい
    senses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ja: { type: Type.STRING },
          pos: { type: Type.STRING },
        },
        required: ["ja"],
      },
    },
    targetPhrases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          en: { type: Type.STRING },
          ja: { type: Type.STRING },
        },
        required: ["en", "ja"],
      },
    },
    derivatives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          pos: { type: Type.STRING },
          meaning: { type: Type.STRING },
        },
        required: ["word", "pos", "meaning"],
      },
    },
    examLevel: { type: Type.STRING },
    category: { type: Type.STRING },
    nuance: { type: Type.STRING },
    etymology: { type: Type.STRING },
    importanceScore: { type: Type.NUMBER },
    // 和訳を必ず伴わせるため、"英文\n和訳" の1本の文字列ではなく組で返させる。
    // 文字列形式だと和訳が落ちることがあった（normalizeExamples は両形式に対応）。
    examples: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          en: { type: Type.STRING },
          ja: { type: Type.STRING },
        },
        required: ["en", "ja"],
      },
    },
    collocations: { type: Type.ARRAY, items: { type: Type.STRING } },
    synonyms: { type: Type.ARRAY, items: wordRelation },
    antonyms: { type: Type.ARRAY, items: wordRelation },
    specializedContexts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          field: { type: Type.STRING },
          context: { type: Type.STRING },
        },
        required: ["field", "context"],
      },
    },
    etymologyNodes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          meaning: { type: Type.STRING },
          root: { type: Type.STRING },
          relation: { type: Type.STRING },
          importance: { type: Type.NUMBER },
        },
        required: ["word", "meaning", "root", "relation", "importance"],
      },
    },
  },
  required: [
    "word", "meaning", "grammar", "phonetic", "senses", "targetPhrases", "derivatives",
    "examLevel", "category", "nuance", "etymology",
    "importanceScore", "examples", "collocations", "synonyms", "antonyms",
    "specializedContexts", "etymologyNodes",
  ],
} as const;

export function buildLookupPrompt(
  word: string,
  mode: ModeSlug,
  options: { forceExactSpelling?: boolean } = {}
): string {
  const context = mode === "gen" ? "general everyday usage" : "academic and research contexts";

  const correctionRule = options.forceExactSpelling
    ? `Treat "${word}" as already correctly spelled. Do NOT change, "correct", or
substitute a different word for it under any circumstances, even if a longer or
more advanced word seems related or comes to mind. The "word" field in your
response must be exactly "${word}" (only case may be normalized).`
    : `"${word}" is very likely already a correct, valid English word — assume that
first. Only silently correct it if it is CLEARLY unusable as-is: a keyboard-adjacent
typo (e.g. "recieve" -> "receive", "beleive" -> "believe", "runing" -> "run") or an
inflected form you should lemmatize. A correction must stay close to the original
letters — never replace the input with an unrelated or much longer word just
because it seems more "advanced" or common in your training data. If "${word}" is
short (2-5 letters) and forms a real English word as typed (e.g. "map", "run",
"set", "bat"), you MUST look it up exactly as given and must NOT substitute any
other word. When genuinely uncertain whether a correction is warranted, do NOT
correct — look up the input exactly as typed. If you do correct it, the "word"
field in your response must contain the corrected spelling, not the original input.`;

  return `Look up the English word "${word}" specifically for ${context}.
Prioritize meanings in ${context}.

${correctionRule}

Write the Japanese exactly in the style of a Japanese university-entrance vocabulary
book (旺文社「英単語ターゲット」). This style is strict — follow it precisely:

* Transitive verbs start with the object particle: "を変える", "を学ぶ", "に尋ねる".
* Show the kind of object in parentheses: "(人)を手伝う", "(物)を与える".
* Separate near-synonymous wordings inside one sense with "，": "(人)を手伝う，助ける".
* Do NOT write a full sentence, a definition, or "〜という意味" — write only the gloss.

Provide:
- senses: the numbered meanings (①②③), most frequent first, 1-4 entries.
  Each { ja: the gloss in the style above, pos: 1-char part of speech such as
  動/名/形/副 only when it differs from the headword's main part of speech }.
  Example for "help": [{ja:"(人)を手伝う，助ける"},{ja:"(人)に役立つ"}]
- meaning: the same senses joined with "；" (kept for compatibility).
  Example for "change": "を変える；変わる；を替える"
- targetPhrases: 2-4 grammar patterns / collocations the word actually appears in,
  in the book's frame notation. Use A, B for noun slots, "do" for a bare infinitive,
  "doing" for a gerund, "~" for a free element.
  { en: the frame, ja: its Japanese reading WITHOUT 「」 }
  Examples:
    help  -> [{en:"help A with B", ja:"AのBを手伝う"},{en:"help ~ (to) do", ja:"〜するのを手伝う"}]
    learn -> [{en:"learn A from B", ja:"BからAを学ぶ"},{en:"learn about ~", ja:"〜について学ぶ"}]
    change-> [{en:"change one's life", ja:"〜の人生を変える"},{en:"change trains", ja:"乗り換える"}]
- derivatives: related forms of the SAME root (noun/adjective/adverb forms), 0-3 entries.
  { word, pos: one of 名/形/副/動, meaning: gloss in the same style }
  Example for "help": [{word:"help", pos:"名", meaning:"助け，手伝い"}]
- examLevel: one of 基礎 / 標準 / 難関 — how advanced this word is for entrance exams.
- grammar: part of speech in Japanese (動詞 / 名詞 / 形容詞 ...)
- phonetic: IPA pronunciation WITHOUT surrounding slashes (e.g. ˈtɜːbjələns)
- category: professional field (e.g. Mechanical Engineering, Finance, etc.)
- nuance: semantic difference from synonyms, in Japanese
- etymology: origin, in Japanese
- examples: 3 entries of { en: an English sentence, ja: its Japanese translation }.
  Both fields are required — never leave ja empty.
  The FIRST example must use the first sense, must contain "${word}" (any inflected
  form is fine), and must be a natural full sentence of 6-14 words.
  Its ja must translate the sense using the same wording as senses[0] so that the
  corresponding part of the Japanese sentence is recognisable.
- collocations: 5 common English verb/noun pairings
- synonyms/antonyms: 3 pairs each with Japanese translations
- specializedContexts: 3 fields with concise Japanese usage explanations
- etymologyNodes: words sharing the same root, each with an 'importance' score (0.0-1.0)
- importanceScore: 0.0 to 1.0 overall importance for English/IELTS/Engineering learners.`;
}

/**
 * gemini-3.8-flash では thinkingBudget が非推奨のため thinkingLevel を使う。
 * MINIMAL は 3.8-flash では無効な値なので、最速設定は LOW。
 */
export const FAST_THINKING = { thinkingLevel: ThinkingLevel.LOW };
