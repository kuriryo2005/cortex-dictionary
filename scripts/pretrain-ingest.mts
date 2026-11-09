/**
 * Claude が自分で書いた辞書項目を Firestore の dictionary_cache に入れる。
 *
 *   npx tsx scripts/pretrain-ingest.mts scripts/_claude-batch.jsonl
 *
 * なぜ自前で書くのか:
 *   生成モデル（Groq / Gemini）に作らせる経路は別にある（pretrain-via-gemini.mts）。
 *   こちらは「Claude 自身の精度で作りたい」ときのための口。
 *
 * 入力は 1 行 1 語の JSONL。**キーは 1 文字に縮めてある**。
 * 何千語も書く前提なので、キー名だけで無視できない量のトークンを食うため。
 *
 *   w 見出し語        m 意味（；区切り）      g 品詞      p IPA（スラッシュ無し）
 *   c 分野            n 使い分け              y 語源      l 入試レベル(基礎/標準/難関)
 *   i 重要度(0-1)
 *   e 語義     [[ja, pos?], ...]
 *   x 例文     [[en, ja], ...]            t 型      [[en, ja], ...]
 *   s 類義語   [[word, ja], ...]          a 対義語  [[word, ja], ...]
 *   k コロケーション [str, ...]
 *   v 派生語   [[word, pos, meaning], ...]
 *   f 分野別   [[field, context], ...]
 *   d 語源ノード [[word, meaning, root, relation, importance], ...]
 *
 * 既に入っている語は飛ばす（キャッシュは上書き禁止なので、そもそも書けない）。
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { appendFileSync, readFileSync } from "node:fs";
import { modeLabel, sanitizeEtymology, type ModeSlug } from "../api/_lib/gemini.js";
import { getServiceAccessToken } from "../api/_lib/googleAuth.js";

const PROJECT = "gen-lang-client-0163841095";
const DB = "ai-studio-f55ff9db-e50f-4a01-bdbe-7636a1265750";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}/documents`;

const FILE = process.argv[2];
const MODE = ((process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=gen").slice(7)) as ModeSlug;
if (!FILE) {
  console.error("使い方: npx tsx scripts/pretrain-ingest.mts <jsonl> [--mode=gen|aca]");
  process.exit(1);
}

type Row = Record<string, any>;

function expand(r: Row): Record<string, unknown> {
  const pair = (a: any[], k1: string, k2: string) =>
    (a ?? []).map((v: any[]) => ({ [k1]: v[0], [k2]: v[1] }));
  return {
    word: r.w,
    meaning: r.m,
    grammar: r.g,
    phonetic: r.p,
    category: r.c,
    nuance: r.n,
    etymology: sanitizeEtymology(r.w, r.y),
    specializedContexts: pair(r.f, "field", "context"),
    examples: pair(r.x, "en", "ja"),
    collocations: r.k ?? [],
    synonyms: pair(r.s, "word", "translation"),
    antonyms: pair(r.a, "word", "translation"),
    importanceScore: typeof r.i === "number" ? r.i : 0.5,
    etymologyNodes: (r.d ?? []).map((v: any[]) => ({
      word: v[0], meaning: v[1], root: v[2], relation: v[3], importance: v[4],
    })),
    senses: (r.e ?? []).map((v: any[]) => (v[1] ? { ja: v[0], pos: v[1] } : { ja: v[0] })),
    targetPhrases: pair(r.t, "en", "ja"),
    derivatives: (r.v ?? []).map((v: any[]) => ({ word: v[0], pos: v[1], meaning: v[2] })),
    examLevel: r.l,
    mode: modeLabel(MODE),
  };
}

/** 入れたら直せないので、書く前に見る。 */
function check(e: Record<string, any>): string | null {
  const s = (k: string) => (typeof e[k] === "string" ? e[k].trim() : "");
  if (!s("word")) return "word が空";
  if (!/^[a-z][a-z'-]*$/.test(s("word"))) return `word が不正 (${s("word")})`;
  // 「夏」のように 1 字で足りる語があるので、長さは最低限だけ見る
  if (s("meaning").length < 1) return "meaning が空";
  if (s("grammar").length < 1) return "grammar が空";
  if (s("phonetic").length < 1) return "phonetic が空";
  if (s("phonetic").includes("/")) return "phonetic にスラッシュが入っている";
  if (s("etymology").length < 20) return "etymology が短い";
  // 「〜を意味する」「〜という意味になった」「〜を指す」など、今の意味への
  // 着地で終わっているかを見る。言い回しは一つに縛らない。
  if (!/意味|指す|表す/.test(s("etymology").slice(-40)))
    return "etymology が意味への着地で終わっていない";
  if (s("nuance").length < 30) return "nuance が薄い";
  if (!["基礎", "標準", "難関"].includes(s("examLevel"))) return "examLevel が不正";
  if (!Array.isArray(e.senses) || e.senses.length === 0) return "senses が空";
  if (!Array.isArray(e.examples) || e.examples.length < 3) return "examples が 3 未満";
  for (const x of e.examples) if (!x.en?.trim() || !x.ja?.trim()) return "examples に空がある";
  // 不規則変化（hold → held）があるので、3 文のどれかに語幹が出ていればよい
  const stem = s("word").slice(0, Math.max(3, s("word").length - 2));
  if (!e.examples.some((x: any) => x.en.toLowerCase().includes(stem)))
    return "例文のどれにも見出し語が入っていない";
  if (!Array.isArray(e.collocations) || e.collocations.length < 3) return "collocations が 3 未満";
  if (!Array.isArray(e.synonyms) || e.synonyms.length === 0) return "synonyms が空";
  if (!Array.isArray(e.etymologyNodes) || e.etymologyNodes.length === 0) return "etymologyNodes が空";
  return null;
}

function toValue(v: any): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  const fields: Record<string, any> = {};
  for (const k of Object.keys(v)) fields[k] = toValue(v[k]);
  return { mapValue: { fields } };
}

const token = await getServiceAccessToken();
const lines = readFileSync(FILE, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);

let ok = 0, skip = 0, bad = 0;
for (const line of lines) {
  let row: Row;
  try {
    row = JSON.parse(line);
  } catch {
    console.error(`JSON が壊れている: ${line.slice(0, 60)}`);
    bad++;
    continue;
  }
  const entry = expand(row);
  const why = check(entry as Record<string, any>);
  if (why) {
    console.error(`NG ${row.w}: ${why}`);
    bad++;
    continue;
  }
  const url = `${BASE_URL}/dictionary_cache/${encodeURIComponent(`${row.w}__${MODE}`)}`;
  // 存在確認の GET はしない。無料枠の「1日の読み取り」は本番の検索と共有で、
  // 数千語ぶん確認しただけで枠を使い切り、本番のキャッシュ読みが全部落ちた（2026-09-24）。
  // 「無いときだけ作る」前提条件付きの書き込み 1 回で、確認と作成を兼ねる。
  const fields: Record<string, any> = {};
  for (const k of Object.keys(entry)) fields[k] = toValue((entry as any)[k]);
  const put = await fetch(`${url}?currentDocument.exists=false`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (put.status === 400 || put.status === 409) {
    const body = await put.text();
    if (/FAILED_PRECONDITION|ALREADY_EXISTS|exists/i.test(body)) { skip++; continue; }
    console.error(`書込失敗 ${row.w}: ${body.slice(0, 120)}`);
    bad++;
    continue;
  }
  if (!put.ok) {
    console.error(`書込失敗 ${row.w}: ${(await put.text()).slice(0, 120)}`);
    bad++;
    continue;
  }
  ok++;
  appendFileSync("scripts/_batch/ingested.txt", `${row.w}\n`);
}
console.log(`投入 ${ok} / 既存 ${skip} / 却下 ${bad}`);
