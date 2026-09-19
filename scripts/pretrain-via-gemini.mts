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
dotenv.config({ path: ".env.local" });

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  getClient,
  WORD_SCHEMA,
  buildLookupPrompt,
  modeLabel,
  type ModeSlug,
} from "../api/_lib/gemini.js";

/**
 * このスクリプトは api/_lib/gemini.ts の MODEL/FAST_THINKING を使わず、
 * 独自に固定する。本番の検索モデルを切り替えても、このバッチが巻き込まれて
 * 意図せずモデルが変わらないようにするため。
 *
 * 2026-09: 本番検索を gemini-3.8-flash に統一したのに合わせ、事前キャッシュも
 * 同モデルに切り替え（生成内容が本番と完全に一致するようにする）。
 */
const PRETRAIN_MODEL = "gemini-3.8-flash";
const PRETRAIN_THINKING = { thinkingLevel: "LOW" };

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

function getToken(): string {
  const now = Date.now();
  if (!cachedToken || now - tokenFetchedAt > TOKEN_TTL_MS) {
    cachedToken = execSync("gcloud auth print-access-token").toString().trim();
    tokenFetchedAt = now;
  }
  return cachedToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Task = { word: string; mode: ModeSlug };

async function processTask(task: Task): Promise<"success" | "skip" | "fail"> {
  const { word, mode } = task;
  const cacheKey = `${word}__${mode}`;
  const url = `${BASE_URL}/dictionary_cache/${encodeURIComponent(cacheKey)}`;

  const checkRes = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (checkRes.status === 200) return "skip";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ai = getClient();
      const res = await ai.models.generateContent({
        model: PRETRAIN_MODEL,
        contents: buildLookupPrompt(word, mode),
        config: {
          responseMimeType: "application/json",
          responseSchema: WORD_SCHEMA,
          thinkingConfig: PRETRAIN_THINKING,
        },
      });
      const text = res.text;
      if (!text) throw new Error("empty response");
      const entry = JSON.parse(text) as Record<string, unknown>;

      const data = { ...entry, mode: modeLabel(mode) };
      const fields: Record<string, any> = {};
      for (const k of Object.keys(data)) fields[k] = toFirestoreValue(data[k]);

      const putRes = await fetch(url, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      if (!putRes.ok) throw new Error(`firestore write failed: ${await putRes.text()}`);
      return "success";
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`\n${cacheKey} failed after ${MAX_RETRIES} attempts:`, e instanceof Error ? e.message : e);
        return "fail";
      }
      // 別のキー（ラウンドロビン）に切り替わるまで少し待ってからリトライ
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
  // 1回あたり約1.8円（api/_lib/costLog.ts と同じ前提）。実行前に総額の目安を出す。
  const estimatedJpy = Math.round(tasks.length * 1.8);
  console.log(`リスト: ${WORDLIST_PATH}`);
  console.log(`単語数: ${words.length} / モード: ${MODES.join(",")}（${tasks.length} 件のタスク）`);
  console.log(`概算原価: 約 ${estimatedJpy.toLocaleString()} 円（既にキャッシュ済みの分はスキップされるので実際はこれより少ない）
`);

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
