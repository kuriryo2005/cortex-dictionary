/**
 * 事前学習（pretrain）の残りを洗い出す。
 *
 *   npx tsx scripts/pretrain-plan.ts
 *
 * このサービスの採算は、ほぼ dictionary_cache のヒット率で決まる。
 * キャッシュに当たった検索は原価ゼロで上限も消費しないので、事前学習を
 * 進めるほど「無料プランの体験が良くなる」「原価が下がる」が同時に起きる。
 * つまり pretrain は機能追加ではなく、収益構造そのものへの投資にあたる。
 *
 * このスクリプトは Firestore の現状を読み、頻度順の単語リストのうち
 * まだ埋まっていないものを出力する。Gemini のクレジットが復活したら、
 * ここで出た `_wordlist-remaining.txt` を上から順に流せばよい。
 *
 * 学術モード（aca）は専門語を引く層＝課金が当たる層に効くので、
 * 一般モード（gen）とは別に進捗を出す。
 */

import "dotenv/config";
import { config } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getServiceAccessToken } from "../api/_lib/googleAuth.js";
import firebaseConfig from "../firebase-applet-config.json" with { type: "json" };

config({ path: ".env.local", override: true });

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

/** キャッシュキーは `${wordLower}__${gen|aca}`（src/services/geminiService.ts と同じ規則）。 */
function parseKey(name: string): { word: string; mode: string } | null {
  const id = name.slice(name.lastIndexOf("/") + 1);
  const at = id.lastIndexOf("__");
  if (at < 0) return null;
  return { word: id.slice(0, at), mode: id.slice(at + 2) };
}

async function fetchCachedKeys(token: string): Promise<{ gen: Set<string>; aca: Set<string> }> {
  const gen = new Set<string>();
  const aca = new Set<string>();
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BASE_URL}/dictionary_cache`);
    url.searchParams.set("pageSize", "300");
    // 本文は要らないのでフィールドを1つだけ要求して転送量を抑える
    url.searchParams.append("mask.fieldPaths", "word");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`dictionary_cache の取得に失敗: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { documents?: { name: string }[]; nextPageToken?: string };

    for (const doc of data.documents ?? []) {
      const parsed = parseKey(doc.name);
      if (!parsed) continue;
      (parsed.mode === "aca" ? aca : gen).add(parsed.word);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return { gen, aca };
}

function pct(n: number, d: number): string {
  return d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`;
}

const words = readFileSync(join(process.cwd(), "scripts", "_wordlist-10k.txt"), "utf-8")
  .split("\n")
  .map((w) => w.trim().toLowerCase())
  .filter((w) => w.length >= 2 && /^[a-z'-]+$/.test(w));

const token = await getServiceAccessToken();
const { gen, aca } = await fetchCachedKeys(token);

console.log(`頻度順リスト: ${words.length} 語`);
console.log(`キャッシュ済み: 一般 ${gen.size} 語 / 学術 ${aca.size} 語`);

// 頻度帯ごとの充足率。上位ほど検索される確率が高いので、ここが埋まるほど効く。
console.log("\n頻度帯ごとの充足率（一般モード）");
const bands = [
  [0, 1000],
  [1000, 3000],
  [3000, 5000],
  [5000, 10000],
] as const;
for (const [from, to] of bands) {
  const slice = words.slice(from, to);
  if (!slice.length) continue;
  const have = slice.filter((w) => gen.has(w)).length;
  console.log(`  ${String(from + 1).padStart(5)}〜${String(Math.min(to, words.length)).padStart(5)} 位: ${String(have).padStart(5)} / ${String(slice.length).padStart(5)}  ${pct(have, slice.length)}`);
}

const remainingGen = words.filter((w) => !gen.has(w));
const remainingAca = words.filter((w) => !aca.has(w));

writeFileSync(join(process.cwd(), "scripts", "_wordlist-remaining.txt"), remainingGen.join("\n") + "\n", "utf-8");

console.log(`\n未生成: 一般 ${remainingGen.length} 語 / 学術 ${remainingAca.length} 語`);
console.log("scripts/_wordlist-remaining.txt に一般モードの残りを頻度順で書き出しました。");

// 原価の目安。1回あたり約1.8円（api/_lib/costLog.ts の単価と同じ前提）
const JPY_PER_CALL = 1.8;
console.log("\n全部埋めた場合の概算原価（1回1.8円で計算）");
console.log(`  一般のみ: 約 ${Math.round((remainingGen.length * JPY_PER_CALL) / 100) * 100} 円`);
console.log(`  一般＋学術: 約 ${Math.round(((remainingGen.length + remainingAca.length) * JPY_PER_CALL) / 100) * 100} 円`);
console.log("\n上位3,000語だけでも埋めれば、日常的な検索のほとんどはキャッシュに当たる。");
console.log(`  上位3,000語の残り(一般): ${words.slice(0, 3000).filter((w) => !gen.has(w)).length} 語 ` +
  `≒ ${Math.round((words.slice(0, 3000).filter((w) => !gen.has(w)).length * JPY_PER_CALL) / 100) * 100} 円`);
