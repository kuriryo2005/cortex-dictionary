/**
 * Groq を入れるかどうかを決めるための計測。
 *
 *   npx tsx scripts/bench-groq.ts
 *
 * 見たいのは 2 つだけ。
 *
 *   1. 速いか — とくに「意味」が画面に出せる状態になるまでの時間。
 *      いまの詰まりはそこにあり、Gemini は初トークンまで 2〜6 秒かかる。
 *   2. 語源が書けるか — このアプリの核。ここが浅いなら、速くても主力にはできない。
 *      （Gemini でも 3.6 は turba まで遡るが lite 系は「動詞に由来する」で止まる）
 *
 * 判断材料を出すだけで、アプリ本体には手を入れない。
 */

import fs from "node:fs";

// .env.local はサーバー環境変数の代わり。スクリプトからは自分で読む。
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const KEY = process.env.GROQ_API_KEY;
if (!KEY) {
  console.error("GROQ_API_KEY が .env.local にありません。");
  process.exit(1);
}

const BASE = "https://api.groq.com/openai/v1";

/** 実在するモデルを API に聞く。一覧を思い込みで決めない。 */
async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`models: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id).sort();
}

/** 詳細ページで先に読まれる項目だけ。単語帳用の重い項目は入れない。 */
const SCHEMA = {
  type: "object",
  properties: {
    word: { type: "string" },
    meaning: { type: "string" },
    grammar: { type: "string" },
    nuance: { type: "string" },
    etymology: { type: "string" },
  },
  required: ["word", "meaning", "grammar", "nuance", "etymology"],
  additionalProperties: false,
};

function prompt(word: string): string {
  return `英単語 "${word}" を日本語で解説してください。

- meaning: 旺文社「英単語ターゲット」の書き方。他動詞は「を」「に」で始める（例: を変える）。
  語義は「；」区切りで最大3つ。説明文や「〜という意味」は書かない。
- grammar: 動詞 / 名詞 / 形容詞 など。
- nuance: 類義語との使い分け。
- etymology: 語源。**どの言語のどの語根までさかのぼるかを必ず書く**
  （例: ラテン語 turba「群衆・混乱」に由来し…）。「動詞に由来する」のような
  曖昧な書き方はしない。

JSON だけを返してください。`;
}

interface Result {
  model: string;
  ttft: number;
  toMeaning: number;
  total: number;
  meaning: string;
  etymology: string;
}

async function bench(model: string, word: string): Promise<Result> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt(word) }],
      stream: true,
      temperature: 0.3,
      response_format: {
        type: "json_schema",
        json_schema: { name: "word_detail", schema: SCHEMA, strict: true },
      },
    }),
  });

  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttft = 0;
  let toMeaning = 0;
  let text = "";
  let buffered = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    // SSE の行を取り出す
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (typeof delta !== "string" || !delta) continue;
        if (!ttft) ttft = Date.now() - t0;
        text += delta;
        if (!toMeaning && /"meaning"\s*:\s*"[^"]{3,}/.test(text)) toMeaning = Date.now() - t0;
      } catch {
        // 壊れた行は読み飛ばす
      }
    }
  }

  const total = Date.now() - t0;
  let parsed: { meaning?: string; etymology?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { meaning: "(JSON として読めませんでした)", etymology: text.slice(0, 120) };
  }

  return {
    model,
    ttft,
    toMeaning,
    total,
    meaning: parsed.meaning ?? "",
    etymology: parsed.etymology ?? "",
  };
}

// --- 実行 -----------------------------------------------------------------

const models = await listModels();
console.log(`利用できるモデル ${models.length} 件:\n  ${models.join("\n  ")}\n`);

// テキスト生成に使えそうなものだけに絞る（音声・画像・ガードは除く）
const candidates = models.filter(
  (m) => !/whisper|tts|guard|vision|embed|ocr/i.test(m)
);

console.log(`計測対象 ${candidates.length} 件\n`);

// turbulence は語源の深さを比べるのに使ってきた語（Gemini 3.6 は turba まで遡る）
const WORD = "turbulence";

for (const model of candidates) {
  try {
    const r = await bench(model, WORD);
    console.log(`── ${r.model}`);
    console.log(`   初トークン ${r.ttft}ms / 意味 ${r.toMeaning}ms / 完了 ${r.total}ms`);
    console.log(`   意味: ${r.meaning}`);
    console.log(`   語源: ${r.etymology}`);
    console.log(`   turba に言及: ${/turba/i.test(r.etymology) ? "あり" : "なし"}\n`);
  } catch (e) {
    console.log(`── ${model}\n   失敗: ${String(e instanceof Error ? e.message : e).slice(0, 140)}\n`);
  }
}
