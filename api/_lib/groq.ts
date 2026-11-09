/**
 * Groq のクライアント（単語検索の「速い車線」）。
 *
 * なぜ足したか。実測でこうだった。
 *
 *   Groq  gpt-oss-120b (reasoning_effort=low)  3.3 秒 / 3,220 トークン
 *   Groq  gpt-oss-20b  (reasoning_effort=low)  1.3 秒 / 2,385 トークン
 *   Gemini gemini-3.6-flash                    約 9.8 秒
 *
 * 3〜7 倍速い。ただし 1 本あたりは**細い**。TPM 8,000 に対して 1 回の検索が
 * 2,400〜3,200 トークンなので、**1 本では 1 分に 3 回**で頭打ちになる
 * （実測で 3 回目に 429）。
 *
 * 429 の本文が "in organization org_..." と言うとおり、**上限は organization
 * 単位**。同じアカウントで鍵を何本作っても枠は共有されるので増えない。
 * 増やすには**アカウントごと分ける**必要がある。
 *
 * 現在はそのやり方で 4 アカウント分の鍵を入れてある。1 本目を 429 まで
 * 使い切った直後に他の 3 本を叩くと、いずれも 200 が返ることを実測で確認した。
 *
 * **ただし主力ではなく保険。** 語源の深さで Gemini に明確に負けるため。
 * 5 語で比べたところ Gemini は 5/5 で最深部まで遡ったが、Groq は 0/5 だった。
 *
 *   turbulence  Groq: turbulentus 止まり   Gemini: turba まで
 *   deliberate  Groq: deliberare 止まり    Gemini: libra「秤」まで
 *   precarious  Groq: 「Latin precarious」と誤記（プロンプトで禁じた形）
 *
 * 語源はこのアプリの核なので、ここを削ってまで速さを取らない。
 * しかも共有キャッシュ（dictionary_cache）があるため、**生成が走るのは
 * まだ誰も引いていない語だけ**で、2 回目以降は誰が引いても約 1.2 秒。
 * つまり生成経路では速度より質を優先するのが正しい。
 *
 * よって Groq は **Gemini が全滅したときの保険**として最後に置く。
 * 今日それが実際に起きた（全モデル 503 で 1 件も返せない時間帯があり、
 * その間も Groq は 3 秒で返していた）。
 *
 * 語源の深さは Gemini にわずかに劣る（turbulence で turbare 止まり。
 * Gemini は turba まで遡る）。プロンプト側の指示は両者で共有している。
 */

import { WORD_SCHEMA, buildLookupPrompt, type ModeSlug } from "./gemini.js";

const BASE = "https://api.groq.com/openai/v1";

/**
 * 使うモデル。速い順ではなく、**質の高い順**に並べる。
 * 120b のほうが語源の記述が丁寧で、それでも Gemini より速い。
 */
export const GROQ_LOOKUP_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;

/** 最初のトークンが来るまでの上限。Groq は速いので短くてよい。 */
const TTFT_TIMEOUT_MS = 4_000;
/**
 * 1 回の呼び出し全体の上限。
 *
 * 実測の中央値は 3.9〜4.4 秒。保険だった頃は 12 秒にしていたが、主力に変えた後で
 * 一度 12 秒を超えて落ちた（語源の指示を厚くしてプロンプトが 5,577 文字に伸びた分、
 * 生成が長くなっている）。余裕を持たせる。ここを越えるようなら Gemini に回す。
 */
const TOTAL_TIMEOUT_MS = 15_000;

// --- 鍵 --------------------------------------------------------------------

/**
 * GROQ_API_KEY と GROQ_API_KEY_1.. を読む。
 *
 * **1 つの鍵 = 1 つのアカウント**として運用すること。同じアカウントで
 * 発行した鍵を並べても、organization 単位の上限を共有するだけで容量は増えない。
 */
const MAX_KEY_INDEX = 10;

let keys: string[] | null = null;

function loadKeys(): string[] {
  if (keys) return keys;
  const found: string[] = [];
  const primary = process.env.GROQ_API_KEY?.trim();
  if (primary) found.push(primary);
  // _1 から探す。_2 から始めていたら、実際に用意された GROQ_API_KEY_1 を
  // 取りこぼしていた（4 本あるのに 3 本しか読めていなかった）。
  for (let i = 1; i <= MAX_KEY_INDEX; i++) {
    const extra = process.env[`GROQ_API_KEY_${i}`]?.trim();
    if (extra && !found.includes(extra)) found.push(extra);
  }
  keys = found;
  return keys;
}

let rotation = 0;

/**
 * 「鍵 + モデル」ごとの休み。TPM で弾かれた組み合わせを、しばらく避ける。
 *
 * Gemini 側と同じ考え方。鍵が別アカウントなら枠も別なので、1 本が詰まっても
 * 残りは使える。ここを持たないと、詰まった鍵を何度も引いてしまう。
 */
const pausedUntil = new Map<string, number>();

const pauseKey = (key: string, model: string) => `${key.slice(-8)}|${model}`;

/** Groq を使える状態か。鍵が無ければ黙って使わない（Gemini だけで動く）。 */
export function isGroqConfigured(): boolean {
  return loadKeys().length > 0;
}

/**
 * 読み込めた鍵の本数。/api/health から状態を見るためだけに使う。
 * **値そのものは決して外へ出さない。本数だけ。**
 */
export function groqKeyCount(): number {
  return loadKeys().length;
}

/** いま使える鍵を、ラウンドロビンで順に返す。 */
function usableKeys(model: string): string[] {
  const pool = loadKeys();
  if (pool.length === 0) return [];
  const now = Date.now();

  const ordered: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    ordered.push(pool[(rotation + i) % pool.length]);
  }
  rotation = (rotation + 1) % pool.length;

  return ordered.filter((k) => (pausedUntil.get(pauseKey(k, model)) ?? 0) <= now);
}

/**
 * TPM で弾かれた鍵を休ませる。
 * Groq の 429 は本文に待ち時間を書かないことがあるので、既定は 1 分。
 * TPM は 1 分窓なので、それだけ空ければ戻る。
 */
function pause(key: string, model: string, message: string): void {
  const told = message.match(/try again in ([\d.]+)s/i);
  const sec = told ? Number(told[1]) : 60;
  const wait = Math.min(5 * 60_000, Math.max(20_000, Math.round(sec * 1000)));
  pausedUntil.set(pauseKey(key, model), Date.now() + wait);
}

/** テスト・観測用。その鍵とモデルの休みが明ける時刻（0 なら休んでいない）。 */
export function groqPausedUntil(key: string, model: string): number {
  return pausedUntil.get(pauseKey(key, model)) ?? 0;
}

// --- スキーマ ---------------------------------------------------------------

/**
 * Gemini の Type 列挙で書かれたスキーマを、素の JSON Schema に直す。
 *
 * 同じ形を二重に持つと必ずずれるので、本番のスキーマから機械的に作る。
 * Groq 側の作法が Gemini と違う点が 2 つある。
 *
 *   - required に**全キー**を並べる必要がある（Gemini は一部でよい）
 *   - それでも strict: true だと出力の検証に落ちることがある
 *     （実測で「Generated JSON does not match the expected schema」）。
 *     strict: false にすると通り、構造も揃った出力が返る。
 */
function toJsonSchema(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  const type = String(n.type ?? "").toLowerCase();

  if (type === "object") {
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((n.properties ?? {}) as Record<string, unknown>)) {
      properties[k] = toJsonSchema(v);
    }
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (type === "array") return { type: "array", items: toJsonSchema(n.items) };
  if (type === "number" || type === "integer") return { type: "number" };
  return { type: "string" };
}

let cachedSchema: unknown = null;

function lookupSchema(): unknown {
  if (!cachedSchema) cachedSchema = toJsonSchema(WORD_SCHEMA);
  return cachedSchema;
}

// --- 呼び出し ---------------------------------------------------------------

/** 待てば直る類の失敗か（429・5xx・時間切れ）。Gemini 側と同じ考え方。 */
export function isGroqRecoverable(error: unknown): boolean {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    m.includes("429") ||
    m.includes("rate limit") ||
    m.includes("timeout") ||
    m.includes("500") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("over capacity") ||
    m.includes("fetch failed")
  );
}

export interface GroqLookupResult {
  /** 生成された JSON（正規化前） */
  detail: Record<string, unknown>;
  model: string;
  elapsedMs: number;
}

/**
 * 1 モデルで引く。途中経過は onPartial に渡す（JSON になった時点のもの）。
 *
 * 失敗したら投げる。呼び出し側が次のモデル、最終的に Gemini へ回す。
 */
export async function groqLookup(
  model: string,
  word: string,
  mode: ModeSlug,
  onText?: (accumulated: string) => void,
  /** 呼び出し全体に使ってよい時間。呼び出し側の残り時間を渡す。 */
  budgetMs?: number
): Promise<GroqLookupResult> {
  const candidates = usableKeys(model);
  if (candidates.length === 0) {
    // 鍵が無いのか、全部休み中なのかで意味が違う
    throw new Error(
      loadKeys().length === 0
        ? "GROQ_API_KEY が設定されていません。"
        : `429 ${model} は手持ちの鍵すべてで上限に達しています`
    );
  }

  // 上限は鍵ごとに別なので、429 を受けたら次の鍵で引き直す。
  // 待つより持ち替えるほうが速い（実測: 詰まった直後の別鍵は 200 が返る）。
  let lastError: unknown;
  for (const key of candidates) {
    try {
      return await callOnce(key, model, word, mode, onText, budgetMs);
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      if (/429|rate limit/i.test(message)) {
        pause(key, model, message);
        continue; // 次の鍵へ
      }
      throw e; // 429 以外は持ち替えても直らない
    }
  }
  throw lastError;
}

async function callOnce(
  key: string,
  model: string,
  word: string,
  mode: ModeSlug,
  onText?: (accumulated: string) => void,
  budgetMs?: number
): Promise<GroqLookupResult> {
  const startedAt = Date.now();
  const abort = new AbortController();
  // 呼び出し側の残り時間と、こちらの上限の短いほうで切る。
  // 保険として後ろに回った以上、全体の締め切りを食い破ってはいけない。
  const total = Math.max(2_000, Math.min(TOTAL_TIMEOUT_MS, budgetMs ?? TOTAL_TIMEOUT_MS));
  const hardStop = setTimeout(() => abort.abort(), total);

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: abort.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildLookupPrompt(word, mode) }],
        stream: true,
        temperature: 0.3,
        // gpt-oss は推論モデル。既定のままだと考える時間が長く、
        // 18 項目のスキーマでは 5.7 秒かかった。low で 2.5〜3.3 秒に落ちる。
        reasoning_effort: "low",
        response_format: {
          type: "json_schema",
          // strict: true は出力の検証に落ちることがある（上のコメント参照）
          json_schema: { name: "word_detail", strict: false, schema: lookupSchema() },
        },
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let rest = "";
    let sawFirst = false;

    // 最初の 1 文字が来るまでの見張り。来ないモデルは待たずに次へ渡す。
    const ttftTimer = setTimeout(() => {
      if (!sawFirst) abort.abort();
    }, TTFT_TIMEOUT_MS);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });

        const lines = rest.split("\n");
        rest = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;

          let parsed: { choices?: { delta?: { content?: unknown } }[] };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue; // 壊れた行は読み飛ばす
          }

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta !== "string" || !delta) continue;

          if (!sawFirst) {
            sawFirst = true;
            clearTimeout(ttftTimer);
          }
          text += delta;
          onText?.(text);
        }
      }
    } finally {
      clearTimeout(ttftTimer);
    }

    if (!sawFirst) throw new Error(`503 timeout: ${model} が返事を始めませんでした`);

    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`502 ${model} の応答を JSON として読めませんでした`);
    }

    return { detail, model, elapsedMs: Date.now() - startedAt };
  } catch (e) {
    // AbortError は時間切れ。分類できる文言に直してから投げる
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`503 timeout: ${model} が時間内に応答しませんでした`);
    }
    throw e;
  } finally {
    clearTimeout(hardStop);
  }
}

// --- 汎用の JSON 生成 -------------------------------------------------------

/**
 * 他のエンドポイント用。プロンプトとスキーマを受け取って JSON を返す。
 *
 * 保険としてだけ使う。語源の知識が要る用途（/api/story, /api/expand-root）には
 * 向かないので呼ばない。向くのは
 *
 *   - /api/extract  英文から未知語を拾う。利用者が待つうえ、語源の深さは関係ない
 *   - /api/phonetic 発音記号。小さく、質の差が出ない
 *
 * Gemini の Type 列挙で書かれたスキーマをそのまま渡してよい（内部で変換する）。
 */
export async function groqJson<T>(
  prompt: string,
  schema: unknown,
  options: { budgetMs?: number; models?: readonly string[] } = {}
): Promise<T> {
  const models = options.models ?? GROQ_LOOKUP_MODELS;
  const converted = toJsonSchema(schema);
  let lastError: unknown;

  for (const model of models) {
    const candidates = usableKeys(model);
    for (const key of candidates) {
      const abort = new AbortController();
      const total = Math.max(2_000, Math.min(TOTAL_TIMEOUT_MS, options.budgetMs ?? TOTAL_TIMEOUT_MS));
      const stop = setTimeout(() => abort.abort(), total);
      try {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: "POST",
          signal: abort.signal,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            reasoning_effort: "low",
            response_format: {
              type: "json_schema",
              json_schema: { name: "result", strict: false, schema: converted },
            },
          }),
        });

        const body = await res.text();
        if (!res.ok) {
          const err = new Error(`${res.status} ${body.slice(0, 200)}`);
          if (/429|rate limit/i.test(body)) {
            pause(key, model, body);
            lastError = err;
            continue; // 次の鍵へ
          }
          throw err;
        }

        const parsed = JSON.parse(body) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = parsed.choices?.[0]?.message?.content ?? "";
        return JSON.parse(content) as T;
      } catch (e) {
        lastError = e;
        if (e instanceof Error && e.name === "AbortError") {
          lastError = new Error(`503 timeout: ${model} が時間内に応答しませんでした`);
          continue;
        }
        if (!isGroqRecoverable(e)) throw e;
      } finally {
        clearTimeout(stop);
      }
    }
  }

  throw lastError ?? new Error("503 groq のどの鍵でも応答を得られませんでした");
}
