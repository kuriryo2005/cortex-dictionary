/**
 * 本番と同じ 18 項目スキーマで Groq を測る。
 *
 *   npx tsx scripts/bench-groq-full.ts
 *
 * 5 項目の簡略版では速くて質も良かったが、それで決めるのは早い。
 * 実際のアプリが投げるのは 18 項目の大きなスキーマで、例文・類義語・
 * 専門分野まで作らせる。見たいのは 3 つ。
 *
 *   1. 大きなスキーマでも速さを保てるか（簡略版は 1.8 秒だった）
 *   2. 1 回に何トークン使うか — Groq は TPM 8,000 なので、ここが先に詰まる恐れがある
 *   3. 語義が「ターゲット」形式（「を変える」等）で書けるか
 */

import fs from "node:fs";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const KEY = process.env.GROQ_API_KEY;
if (!KEY) {
  console.error("GROQ_API_KEY がありません。");
  process.exit(1);
}

const g = await import("../api/_lib/gemini.js");

/**
 * Gemini の Type 列挙で書かれたスキーマを、素の JSON Schema に直す。
 * 同じ形を二重に持つと必ずずれるので、本番のスキーマから機械的に作る。
 */
function toJsonSchema(node: any): any {
  if (!node || typeof node !== "object") return node;
  const type = String(node.type ?? "").toLowerCase();

  if (type === "object") {
    const properties: Record<string, any> = {};
    for (const [k, v] of Object.entries(node.properties ?? {})) properties[k] = toJsonSchema(v);
    return {
      type: "object",
      properties,
      // Groq の strict モードは required に全キーを並べることを要求する
      // （Gemini は一部だけでよい）。ここが両者の仕様差。
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (type === "array") return { type: "array", items: toJsonSchema(node.items) };
  if (type === "number" || type === "integer") return { type: "number" };
  return { type: "string" };
}

const SCHEMA = toJsonSchema(g.WORD_SCHEMA);
const fieldCount = Object.keys(SCHEMA.properties).length;

async function bench(model: string, word: string) {
  const t0 = Date.now();
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: g.buildLookupPrompt(word, "gen") }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.3,
      response_format: {
        type: "json_schema",
        json_schema: { name: "word_detail", schema: SCHEMA, strict: true },
      },
    }),
  });

  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text()).slice(0, 220)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttft = 0;
  let toMeaning = 0;
  let toEtymology = 0;
  let text = "";
  let rest = "";
  let usage: any = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.usage) usage = parsed.usage;
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta !== "string" || !delta) continue;
      if (!ttft) ttft = Date.now() - t0;
      text += delta;
      if (!toMeaning && /"meaning"\s*:\s*"[^"]{3,}/.test(text)) toMeaning = Date.now() - t0;
      if (!toEtymology && /"etymology"\s*:\s*"[^"]{3,}/.test(text)) toEtymology = Date.now() - t0;
    }
  }

  const total = Date.now() - t0;
  let obj: any = {};
  let parseOk = true;
  try {
    obj = JSON.parse(text);
  } catch {
    parseOk = false;
  }

  return { model, ttft, toMeaning, toEtymology, total, usage, obj, parseOk, raw: text };
}

const WORDS = ["turbulence", "change", "deliberate"];
const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

console.log(`本番スキーマの項目数: ${fieldCount}\n`);

for (const model of MODELS) {
  console.log(`\n================ ${model} ================`);
  for (const word of WORDS) {
    try {
      const r = await bench(model, word);
      const u = r.usage ?? {};
      console.log(`\n【${word}】`);
      console.log(
        `  初トークン ${r.ttft}ms / 意味 ${r.toMeaning}ms / 語源 ${r.toEtymology}ms / 完了 ${r.total}ms`
      );
      console.log(
        `  トークン: 入力 ${u.prompt_tokens ?? "?"} + 出力 ${u.completion_tokens ?? "?"} = ${u.total_tokens ?? "?"}`
      );
      console.log(`  JSON として読めた: ${r.parseOk ? "はい" : "いいえ"}`);
      if (r.parseOk) {
        console.log(`  意味: ${r.obj.meaning}`);
        console.log(`  語源: ${String(r.obj.etymology ?? "").slice(0, 160)}`);
        const senses = (r.obj.senses ?? []).map((s: any) => s.ja).join(" / ");
        console.log(`  語義: ${senses.slice(0, 120)}`);
        const tp = (r.obj.targetPhrases ?? []).map((p: any) => `${p.en}「${p.ja}」`).join(" ");
        console.log(`  フレーズ: ${tp.slice(0, 120)}`);
        console.log(`  例文数 ${(r.obj.examples ?? []).length} / 類義語 ${(r.obj.synonyms ?? []).length} / 語源ノード ${(r.obj.etymologyNodes ?? []).length}`);
      } else {
        console.log(`  先頭: ${r.raw.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`\n【${word}】 失敗: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  }
}
