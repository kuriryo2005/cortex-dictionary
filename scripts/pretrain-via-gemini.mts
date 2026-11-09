/**
 * 実際の Gemini API（api/_lib/gemini.ts と同じロジック・スキーマ・キーのラウンド
 * ロビン）を通して単語を事前学習し、Firestore の dictionary_cache に書き込む。
 *
 * これまでの手作業バッチ（Claude が自分で内容を書く方式）とは違い、本番の
 * lookup.ts と全く同じ generateContent 呼び出しを行うため、生成される内容の
 * 質・形式は本番検索と完全に一致する。
 *
 * 単語リストは scripts/_wordlist-10k.txt（頻度順の英単語リスト、1行1語）を
 * 読み込む。既存キャッシュとの重複は Firestore 側の存在チェックで自動
 * スキップされるので、中断して再実行しても安全（重複投入されない）。
 *
 * 使い方: npx tsx scripts/pretrain-via-gemini.mts
 */
import dotenv from "dotenv";
import type { ThinkingConfig } from "@google/genai";
dotenv.config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import {
  withKeyFailover,
  WORD_SCHEMA,
  buildLookupPrompt,
  modeLabel,
  sanitizeEtymology,
  type ModeSlug,
} from "../api/_lib/gemini.js";
import { groqLookup, isGroqConfigured, groqKeyCount } from "../api/_lib/groq.js";
import { getServiceAccessToken } from "../api/_lib/googleAuth.js";

/**
 * このスクリプトは api/_lib/gemini.ts の MODEL/FAST_THINKING を使わず、
 * 独自に固定する。本番の検索モデルを切り替えても、このバッチが巻き込まれて
 * 意図せずモデルが変わらないようにするため。
 *
 * 2026-09: 本番検索を gemini-3.8-flash に統一したのに合わせ、事前キャッシュも
 * 同モデルに切り替え（生成内容が本番と完全に一致するようにする）。
 */
/**
 * 事前学習で使うモデル。既定は本番と同じ gemini-3.8-flash だが、
 * 大量に流すときは --model=gemini-2.5-flash のほうが安く、無料枠の
 * 上限にも当たりにくい。内容の作りは同じスキーマ・同じプロンプトなので
 * 中身の形は変わらない。
 */
const PRETRAIN_MODEL = arg("model", "gemini-3.8-flash");

/**
 * どちらの提供元で作るか。
 *
 *   --provider=groq    … Groq（openai/gpt-oss-120b）。無料枠で、語源も深い。
 *   --provider=gemini  … 従来どおり Gemini。有料。
 *
 * 2026-09-22: 同じ強さのプロンプトで比べたところ、語源・使い分けとも Groq が
 * 勝ち、速度も 3〜5 倍だった（api/lookup.ts の tryGroq のコメント参照）。
 * 事前学習は「原価ゼロで質が同等以上」の Groq を既定にする。
 */
const PROVIDER = arg("provider", "groq");
const GROQ_MODEL = arg("groq-model", "openai/gpt-oss-120b");

/**
 * 一括処理は本番と同じキーを使わない。
 *
 * 一度これをやってアプリを止めた。無料枠は1プロジェクト1日あたりの上限なので、
 * 2,000語のバッチを流すとライブの検索が使う分まで食い尽くし、実行後は全キーが
 * 429 になって誰も検索できなくなる。バッチ専用のキーを
 * PRETRAIN_GEMINI_API_KEY / PRETRAIN_GEMINI_API_KEY_2 … に用意すること。
 *
 * どうしても本番のキーで流す場合だけ --use-live-keys を付ける。サービスを
 * 止めてよい時間帯か、キーに十分な残高があるかを確かめてから使う。
 */
function selectKeys(): void {
  if (process.argv.includes("--use-live-keys")) {
    console.warn("警告: 本番と同じキーで実行します。");
    console.warn("クォータを使い切るとアプリの検索が止まります。");
    return;
  }

  const dedicated: string[] = [];
  if (process.env.PRETRAIN_GEMINI_API_KEY) dedicated.push(process.env.PRETRAIN_GEMINI_API_KEY);
  for (let i = 2; ; i++) {
    const k = process.env[`PRETRAIN_GEMINI_API_KEY_${i}`];
    if (!k) break;
    dedicated.push(k);
  }

  if (dedicated.length === 0) {
    console.error("バッチ専用のキーがありません。");
    console.error("  PRETRAIN_GEMINI_API_KEY（必要なら _2, _3 …）を .env.local に設定してください。");
    console.error("  本番と同じキーを使うと、無料枠を食い尽くしてアプリの検索が止まります。");
    console.error("  承知のうえで流す場合は --use-live-keys を付けてください。");
    process.exit(1);
  }

  // api/_lib/gemini.ts は GEMINI_API_KEY* を読むので、専用キーで置き換える
  for (let i = 2; ; i++) {
    if (process.env[`GEMINI_API_KEY_${i}`] === undefined) break;
    delete process.env[`GEMINI_API_KEY_${i}`];
  }
  process.env.GEMINI_API_KEY = dedicated[0];
  dedicated.slice(1).forEach((k, i) => (process.env[`GEMINI_API_KEY_${i + 2}`] = k));
  console.log(`バッチ専用キー ${dedicated.length} 本で実行します。`);
}

if (PROVIDER === "gemini") selectKeys();
// SDK の型は ThinkingLevel の列挙を要求するが、API には文字列で通る。
const PRETRAIN_THINKING = { thinkingLevel: "LOW" } as unknown as ThinkingConfig;

const PROJECT = "gen-lang-client-0163841095";
const DB = "ai-studio-f55ff9db-e50f-4a01-bdbe-7636a1265750";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}/documents`;

/**
 * 実行時オプション。原価が直接かかる作業なので、範囲を指定して
 * 少しずつ進められるようにしてある。
 *
 *   --list=scripts/_wordlist-remaining.txt   … 単語リストを差し替える
 *   --limit=2000                             … 先頭から N 語だけ処理する
 *   --modes=gen                              … gen だけ（既定は gen,aca の両方）
 */
function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const WORDLIST_PATH = arg("list", "scripts/_wordlist-10k.txt");
const WORD_LIMIT = Number(arg("limit", "0")) || Infinity;
const MODES = arg("modes", "gen,aca")
  .split(",")
  .map((m) => m.trim())
  .filter((m): m is "gen" | "aca" => m === "gen" || m === "aca");
const VALID_WORD_PATTERN = /^[a-z][a-z'-]*$/;
const MIN_WORD_LENGTH = 2;

const CONCURRENCY = 5;
const MAX_RETRIES = 3;

function loadWords(): string[] {
  const raw = readFileSync(WORDLIST_PATH, "utf-8");
  const seen = new Set<string>();
  const words: string[] = [];
  for (const line of raw.split("\n")) {
    const w = line.trim().toLowerCase();
    if (!w || w.length < MIN_WORD_LENGTH || !VALID_WORD_PATTERN.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  return words;
}

function toFirestoreValue(v: any): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") {
    const fields: Record<string, any> = {};
    for (const k of Object.keys(v)) fields[k] = toFirestoreValue(v[k]);
    return { mapValue: { fields } };
  }
  throw new Error("unsupported type");
}

// gcloud のアクセストークンは短命（約1時間）。長時間走らせるため、古くなったら
// 自動で取り直す。
let cachedToken = "";
let tokenFetchedAt = 0;
const TOKEN_TTL_MS = 45 * 60 * 1000;

/**
 * 以前は `gcloud auth print-access-token` を叩いていたが、gcloud が入っていない
 * 環境では動かず、実行するたびに人の手が要った。本番の API と同じ
 * FIREBASE_SERVICE_ACCOUNT から取るようにして、放っておいても走るようにする。
 */
async function getToken(): Promise<string> {
  const now = Date.now();
  if (!cachedToken || now - tokenFetchedAt > TOKEN_TTL_MS) {
    cachedToken = await getServiceAccessToken();
    tokenFetchedAt = now;
  }
  return cachedToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Task = { word: string; mode: ModeSlug };

/**
 * 出来上がりが使い物になるかを確かめる。
 *
 * 事前学習で入れたものは **キャッシュが書き換え禁止**（dictionary_cache は
 * allow update: if false）なので、質の悪いものを入れると直せない。
 * 書く前にここで弾く。弾かれた語は次回の実行でまた試される。
 */
function isGoodEnough(entry: Record<string, any>, word: string): string | null {
  const str = (k: string) => (typeof entry[k] === "string" ? entry[k].trim() : "");
  if (!str("word")) return "word が空";
  if (str("word").toLowerCase() !== word.toLowerCase()) return `別の語になった (${str("word")})`;
  if (str("meaning").length < 2) return "meaning が空";
  if (str("etymology").length < 15) return "etymology が短すぎる";
  if (str("nuance").length < 10) return "nuance が短すぎる";

  const ex = Array.isArray(entry.examples) ? entry.examples : [];
  if (ex.length < 2) return "examples が 2 つ未満";
  for (const e of ex) {
    if (!e?.en?.trim() || !e?.ja?.trim()) return "examples に空の en/ja がある";
  }
  if (!Array.isArray(entry.senses) || entry.senses.length === 0) return "senses が空";
  return null;
}

async function generate(word: string, mode: ModeSlug): Promise<Record<string, unknown>> {
  if (PROVIDER === "groq") {
    const res = await groqLookup(GROQ_MODEL, word, mode);
    return res.detail;
  }
  const res = await withKeyFailover((ai) => ai.models.generateContent({
    model: PRETRAIN_MODEL,
    contents: buildLookupPrompt(word, mode),
    config: {
      responseMimeType: "application/json",
      responseSchema: WORD_SCHEMA,
      thinkingConfig: PRETRAIN_THINKING,
    },
  }));
  if (!res.text) throw new Error("empty response");
  return JSON.parse(res.text) as Record<string, unknown>;
}

async function processTask(task: Task): Promise<"success" | "skip" | "fail"> {
  const { word, mode } = task;
  const cacheKey = `${word}__${mode}`;
  const url = `${BASE_URL}/dictionary_cache/${encodeURIComponent(cacheKey)}`;

  const checkRes = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (checkRes.status === 200) return "skip";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const entry = await generate(word, mode);

      // 本番の検索と同じ後始末を通す（「ラテン語 precarious」のような段を落とす）
      if (typeof entry.etymology === "string") {
        entry.etymology = sanitizeEtymology(word, entry.etymology);
      }

      const bad = isGoodEnough(entry as Record<string, any>, word);
      if (bad) throw new Error(`品質不足: ${bad}`);

      const data = { ...entry, mode: modeLabel(mode) };
      const fields: Record<string, any> = {};
      for (const k of Object.keys(data)) fields[k] = toFirestoreValue(data[k]);

      const putRes = await fetch(url, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      if (!putRes.ok) throw new Error(`firestore write failed: ${await putRes.text()}`);
      return "success";
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`
${cacheKey} failed after ${MAX_RETRIES} attempts:`, e instanceof Error ? e.message : e);
        return "fail";
      }
      // 別のキーに切り替わるまで少し待ってからリトライ
      await sleep(1500 * attempt);
    }
  }
  return "fail";
}

async function main() {
  const words = loadWords().slice(0, WORD_LIMIT);
  const tasks: Task[] = [];
  for (const word of words) {
    for (const mode of MODES) tasks.push({ word, mode });
  }
  console.log(`リスト: ${WORDLIST_PATH}`);
  console.log(`単語数: ${words.length} / モード: ${MODES.join(",")}（${tasks.length} 件のタスク）`);
  if (PROVIDER === "groq") {
    if (!isGroqConfigured()) {
      console.error("GROQ_API_KEY がありません。--provider=gemini を使うか、キーを設定してください。");
      process.exit(1);
    }
    console.log(`提供元: Groq ${GROQ_MODEL}（鍵 ${groqKeyCount()} 本）/ 原価 0 円`);
  } else {
    // 1回あたり約1.8円（api/_lib/costLog.ts と同じ前提）
    console.log(`提供元: Gemini ${PRETRAIN_MODEL} / 概算原価 約 ${Math.round(tasks.length * 1.8).toLocaleString()} 円`);
  }
  console.log("");

  let success = 0, skip = 0, fail = 0, done = 0;
  let idx = 0;
  const startedAt = Date.now();

  async function worker() {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      const result = await processTask(task);
      if (result === "success") success++;
      else if (result === "skip") skip++;
      else fail++;
      done++;
      if (done % 10 === 0 || done === tasks.length) {
        const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
        process.stdout.write(
          `\r進捗: ${done}/${tasks.length} (成功${success} / スキップ${skip} / 失敗${fail}) 経過${elapsedMin}分`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n完了: 成功 ${success} / スキップ ${skip} / 失敗 ${fail}`);
}

main();
