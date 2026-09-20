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
/**
 * 主力モデル。
 *
 * 2026-09-20: gemini-3.8-flash から 3.6-flash に変更した。3.8 は 503
 * （high demand）を返し続けて実際に検索が止まったうえ、同じ単価で
 * 3.6 のほうが語源の説明が丁寧だった（turbulence で比較したところ、
 * 3.6 は turba まで遡るが lite 系は「動詞に由来する」で止まる）。
 * 語源がこのアプリの中心なので、そこが厚いほうを選ぶ。
 */
export const MODEL = "gemini-3.6-flash";

/**
 * MODEL が使えないときに順に試す代替モデル。
 *
 * 本番で gemini-3.8-flash が 503（This model is currently experiencing high
 * demand）を返し続け、検索が丸ごと止まった。キーの自動退避は作ってあったが、
 * モデル側が詰まったときの逃げ道が無く、1モデルに全面依存していた。
 *
 * 軽くて安い 3.5-flash-lite を先に置く（実測で 3.7秒 / 0.39円 と速く、
 * 構造は主力と同じ）。混雑が明けていれば 3.8-flash も試す。
 * 解説がやや簡素になっても、止まるよりははるかにいい。
 */
export const FALLBACK_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
] as const;

/**
 * モデルが一時的に使えないことを示すエラーか。
 * 503（混雑）と 404（提供終了・2.5系で実際に起きた）を対象にする。
 */
export function isModelUnavailable(error: unknown): boolean {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    m.includes("503") ||
    m.includes("high demand") ||
    m.includes("overloaded") ||
    m.includes("unavailable") ||
    m.includes("404") ||
    m.includes("no longer available") ||
    // 無料枠の上限はモデルごとに付く（通常 Flash は1日20回、Lite は500回）。
    // あるモデルを使い切っても別のモデルには枠が残っているので、429 も
    // 「このモデルは諦めて次へ」の合図として扱う。キーの切り替えは
    // withKeyFailover が先に済ませているため、ここに届いた429は
    // 「どのキーでもこのモデルは枠切れ」を意味する。
    m.includes("429") ||
    m.includes("resource_exhausted") ||
    m.includes("quota")
  );
}

/**
 * MODEL で試し、モデル側の都合で駄目なら代替モデルへ降りる。
 *
 * `run` はモデル名を受け取って呼び出しを行う。キーの切り替えは
 * withKeyFailover が内側で面倒を見るので、ここはモデルだけを変える。
 */
/**
 * 実際の検索で「どのモデルが通ったか / 詰まったか」を記録しておく台帳。
 *
 * /api/health は当初、確認のために自分で1トークン生成していた。しかし
 * 無料枠の上限はモデルごとに1日20回しかない。10分おきに全キー全モデルを
 * 叩けば、それだけで1日144回。**監視が枠を食い尽くして本番を止めていた。**
 * 観測行為が観測対象を壊す、最悪の形になっていた。
 *
 * 本番の検索はどのみち成否を知っているのだから、それを書き留めれば
 * 追加の消費はゼロで済む。health はこれを読むだけにする。
 *
 * サーバーレスなのでインスタンスごとの部分的な記録にしかならないが、
 * 「枠を食わずに、実際に起きたことだけを報告する」ほうが、正確に嘘をつく
 * よりはるかにいい。
 */
export interface ModelObservation {
  model: string;
  ok: boolean;
  at: number;
}
const observations = new Map<string, ModelObservation>();

function record(model: string, ok: boolean): void {
  observations.set(model, { model, ok, at: Date.now() });
}

/** 直近に生成が通ったモデル（新しい順）。 */
export function observedWorkingModels(): string[] {
  return [...observations.values()]
    .filter((o) => o.ok)
    .sort((a, b) => b.at - a.at)
    .map((o) => o.model);
}

/** 何か1件でも観測できているか（まだ誰も検索していなければ false）。 */
export function hasObservations(): boolean {
  return observations.size > 0;
}

export async function withModelFallback<T>(run: (model: string) => Promise<T>): Promise<T> {
  // 9モデルを順に試すと、全滅に近いときに何分も待たせてしまう。実測で138秒
  // かかったことがあるので、全体の締め切りを設けて打ち切る。
  const deadline = Date.now() + 20_000;

  let lastError: unknown;
  for (const model of [MODEL, ...FALLBACK_MODELS]) {
    if (Date.now() > deadline) {
      console.warn("[gemini] 締め切りに達したのでモデルの切り替えを打ち切ります");
      break;
    }
    try {
      const result = await run(model);
      record(model, true);
      return result;
    } catch (e) {
      lastError = e;
      if (!isModelUnavailable(e)) throw e; // モデルのせいでないならすぐ返す
      record(model, false);
      console.warn(`[gemini] ${model} が使えないので次のモデルを試します`);
    }
  }
  throw lastError;
}

/**
 * 複数の Gemini API キーをラウンドロビンで使い分ける。
 *
 * 無料枠は1プロジェクト（1キー）あたりのレート制限なので、検索が集中すると
 * 429 で失敗することがある。GEMINI_API_KEY に加えて GEMINI_API_KEY_2,
 * GEMINI_API_KEY_3, ... を環境変数に足すと、リクエストのたびに順番に
 * キーを切り替えて負荷を分散する（1キーだけの場合は従来どおり単一キーで動く）。
 */
/** GEMINI_API_KEY_2 .. _30 まで探す。これ以上は現実的に使わない。 */
const MAX_KEY_INDEX = 30;

interface KeySlot {
  client: GoogleGenAI;
  /** このミリ秒まではこのキーを使わない（0 は健全）。 */
  deadUntil: number;
}

let slots: KeySlot[] | null = null;
let roundRobinIndex = 0;

function loadSlots(): KeySlot[] {
  if (slots) return slots;

  const keys: string[] = [];
  const primary = process.env.GEMINI_API_KEY?.trim();
  if (primary) keys.push(primary);
  // 抜け番があっても止まらないように、決まった範囲を最後まで見る。
  // 以前は最初の空きで break していたため、本番に _2.._5 と _7.._12 が
  // 入っていたときに 5 本しか読めず、容量が半分以下になっていた。
  for (let i = 2; i <= MAX_KEY_INDEX; i++) {
    const extra = process.env[`GEMINI_API_KEY_${i}`]?.trim();
    if (extra) keys.push(extra);
  }

  if (keys.length === 0) {
    throw new Error("GEMINI_API_KEY が設定されていません（サーバー環境変数）。");
  }

  slots = keys.map((apiKey) => ({ client: new GoogleGenAI({ apiKey }), deadUntil: 0 }));
  return slots;
}

/** 現在使えるキーの本数（全滅していれば 0）。 */
export function healthyKeyCount(): number {
  const now = Date.now();
  return loadSlots().filter((s) => s.deadUntil <= now).length;
}

/** 呼び出すたびにラウンドロビンで次の「生きている」キーのクライアントを返す。 */
export function getClient(): GoogleGenAI {
  const pool = loadSlots();
  const now = Date.now();

  // 1周だけ回して健全なキーを探す
  for (let i = 0; i < pool.length; i++) {
    const slot = pool[roundRobinIndex % pool.length];
    roundRobinIndex = (roundRobinIndex + 1) % pool.length;
    if (slot.deadUntil <= now) return slot.client;
  }

  // 全部死んでいるときは、いちばん早く復帰するキーで一応試す
  return pool.reduce((a, b) => (a.deadUntil <= b.deadUntil ? a : b)).client;
}

/**
 * 呼び出しが失敗したキーを一時的に外す。
 *
 * クレジット切れ（402）や課金上限超過は日をまたぐまで直らないことが多いので
 * 長めに、レート制限（429）は短めに休ませる。キーを増やしていても、死んだ
 * キーがローテーションに残っていると一定割合のリクエストが失敗し続けるため、
 * これが無いと「12本挿したのに時々失敗する」状態になる。
 */
export function reportKeyFailure(client: GoogleGenAI, error: unknown): void {
  const slot = loadSlots().find((s) => s.client === client);
  if (!slot) return;

  const message = describeError(error);
  if (isDepleted(message)) {
    slot.deadUntil = Date.now() + 6 * 60 * 60 * 1000;
  } else if (isRateLimited(message)) {
    slot.deadUntil = Date.now() + 60 * 1000;
  }
  // 503（モデルの混雑）はキーの問題ではないので、キーは殺さない
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function isDepleted(message: string): boolean {
  return (
    message.includes("credits are depleted") ||
    message.includes("spending cap") ||
    message.includes("billing") ||
    message.includes("402")
  );
}

function isRateLimited(message: string): boolean {
  return message.includes("429") || message.includes("resource_exhausted");
}

/**
 * モデル側が混んでいるだけで、キーを替えても直らない類のエラーか。
 * 503 UNAVAILABLE は数秒待てば通ることが多い。
 */
function isTransient(message: string): boolean {
  return (
    message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("overloaded")
  );
}

/**
 * 生きているキーを順に試して、最初に成功した結果を返す。
 *
 * 失敗の種類で対応を分ける。
 *  - キーの問題（402 / 429）… そのキーを一時的に外し、次のキーで引き直す
 *  - モデルの混雑（503）… キーを替えても無駄なので、少し待って再試行する
 *  - それ以外（入力不正など）… 即座に投げ返す。粘っても直らない
 *
 * 503 をそのまま失敗させると、一時的な混雑でユーザーに「AI の応答に
 * 失敗しました」が出る。有料で使ってもらう以上ここは粘る。ただし待ちすぎても
 * 体験が悪いので、混雑での再試行は合計3秒程度までにとどめる。
 */
export async function withKeyFailover<T>(fn: (ai: GoogleGenAI) => Promise<T>): Promise<T> {
  const keyAttempts = Math.max(1, Math.min(loadSlots().length, 3));
  let lastError: unknown;

  for (let i = 0; i < keyAttempts; i++) {
    const ai = getClient();
    try {
      return await fn(ai);
    } catch (e) {
      lastError = e;
      const message = describeError(e);

      // 混雑（503）はキーを替えても直らない。待つよりモデルを替えるほうが
      // 速いので、ここでは粘らずに投げ返して withModelFallback に任せる。
      if (isTransient(message)) throw e;

      if (isDepleted(message) || isRateLimited(message)) {
        reportKeyFailure(ai, e);
        continue;
      }
      throw e; // 入力不正などは粘っても直らない
    }
  }
  throw lastError;
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

  // 学術モードの差が「たまたま専門語義が混ざる」程度でしか出ていなかった。
  // 実測すると stress には「応力」が出るのに resolution では分野名が付かず、
  // 利用者から「一般と学術で同じでは？」と言われた。偶然に頼らず、
  // 分野の語義を必ず入れて、分野名を明示させる。
  const fieldRule =
    mode === "aca"
      ? `This word may carry a DISTINCT technical meaning in a specific academic
field (engineering, physics, medicine, statistics, linguistics, economics, ...).
If it does, you MUST include that sense, and prefix it with the field in
parentheses, e.g. "(工学) 応力，負荷" / "(統計) 有意な" / "(光学) 分解能".
Put the technical sense first when the word is most often encountered in papers
with that meaning. If the word genuinely has no field-specific sense, do not
invent one.`
      : `Prefer the meanings a learner meets in everyday text, conversation, and news.
Do NOT lead with a narrow technical sense.`;

  return `Look up the English word "${word}" specifically for ${context}.
Prioritize meanings in ${context}.

${fieldRule}

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
