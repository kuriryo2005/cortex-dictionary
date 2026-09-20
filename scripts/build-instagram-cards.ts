/**
 * Instagram 用の正方形カード（1080x1080）を語源ごとに書き出す。
 *
 *   npx tsx scripts/build-instagram-cards.ts
 *
 * Instagram は文章では読まれない。画像1枚で完結している必要がある。
 * このアプリは「語源でつながる単語の束」という、1枚に収まって、かつ
 * 保存したくなる形の資産をすでに持っている。それをそのままカードにする。
 *
 * 出力は out/instagram/ に置く（リポジトリには入れない。投稿したら用済み）。
 * 中身は dictionary_cache から取るので、事前学習が進むほどカードも増える。
 *
 * 1日1枚投稿するなら、これ1回の実行で3週間分になる。
 */

import "dotenv/config";
import { config } from "dotenv";
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getServiceAccessToken } from "../api/_lib/googleAuth.js";
import { ROOTS } from "./_roots.js";
import firebaseConfig from "../firebase-applet-config.json" with { type: "json" };

config({ path: ".env.local", override: true });

const OUT_DIR = join(process.cwd(), "out", "instagram");
/** 1枚に載せる語数。これ以上入れると字が小さくて読めない。 */
const WORDS_PER_CARD = 7;

const BASE_URL = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;

interface Word {
  word: string;
  meaning: string;
  etymology: string;
}

function fromValue(v: any): any {
  if (v == null) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = fromValue(val);
    return out;
  }
  return undefined;
}

async function fetchWords(token: string): Promise<Word[]> {
  const words = new Map<string, Word>();
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BASE_URL}/dictionary_cache`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`取得に失敗: ${res.status}`);
    const data = (await res.json()) as { documents?: any[]; nextPageToken?: string };

    for (const doc of data.documents ?? []) {
      const f = doc.fields ?? {};
      const word = fromValue(f.word);
      const meaning = fromValue(f.meaning);
      if (!word || !meaning) continue;
      const key = String(word).toLowerCase();
      const etymology = fromValue(f.etymology) ?? "";
      const prev = words.get(key);
      if (!prev || etymology.length > prev.etymology.length) {
        words.set(key, { word, meaning, etymology });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return [...words.values()];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 意味は1行に収まる長さで切る。日本語は全角なので文字数で判断してよい。 */
function trim(s: string, max: number): string {
  const one = s.split(/[，,、；;]/)[0].trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function renderCard(root: string, meaning: string, words: Word[]): string {
  const rows = words
    .map((w, i) => {
      const y = 430 + i * 82;
      return `  <text x="90" y="${y}" font-family="Yu Gothic UI, Meiryo, sans-serif" font-size="40" font-weight="700" fill="#ffffff">${esc(w.word)}</text>
  <text x="90" y="${y + 34}" font-family="Yu Gothic UI, Meiryo, sans-serif" font-size="25" fill="#8A9199">${esc(trim(w.meaning, 22))}</text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <rect width="1080" height="1080" fill="#1A1C1E"/>

  <text x="90" y="150" font-family="Yu Gothic UI, Meiryo, sans-serif" font-size="26" font-weight="700" letter-spacing="8" fill="#2A5CFF">ETYMOLOGY</text>
  <text x="90" y="268" font-family="Yu Gothic UI, Meiryo, sans-serif" font-size="104" font-weight="700" fill="#ffffff">${esc(root)}</text>
  <text x="90" y="336" font-family="Yu Gothic UI, Meiryo, sans-serif" font-size="38" fill="#2A5CFF">${esc(meaning)}</text>
  <rect x="90" y="376" width="900" height="1" fill="#33373B"/>

${rows}

  <rect x="90" y="990" width="900" height="1" fill="#33373B"/>
  <text x="90" y="1034" font-family="Yu Gothic UI, Meiryo, sans-serif" font-size="24" fill="#8A9199">この ${words.length} 語は同じ語源でつながっています</text>
  <text x="990" y="1034" text-anchor="end" font-family="Yu Gothic UI, Meiryo, sans-serif" font-size="24" font-weight="700" fill="#ffffff">Cortex Dictionary</text>
</svg>`;
}

/** 投稿文。画像だけでは検索に引っかからないので、キャプションも一緒に出す。 */
function caption(root: string, meaning: string, words: Word[]): string {
  return `語源 ${root}（${meaning}）から広がる英単語。

${words.map((w) => `${w.word}　${trim(w.meaning, 16)}`).join("\n")}

単語を1個ずつ覚えるより、この束ごと覚えたほうが速いです。
覚えた単語が語源でつながっていくアプリを作っています。プロフィールのリンクから。

#英語学習 #英単語 #語源 #TOEIC #英検 #大学受験 #院試 #個人開発
`;
}

// ── 実行 ────────────────────────────────────────────────────────

const token = await getServiceAccessToken();
const all = await fetchWords(token);
console.log(`キャッシュ済み: ${all.length} 語`);

mkdirSync(OUT_DIR, { recursive: true });

let made = 0;
for (const entry of ROOTS) {
  const matched = all.filter((w) => {
    const spelled = entry.forms.some((f) => w.word.toLowerCase().includes(f));
    if (!spelled) return false;
    const ety = w.etymology.toLowerCase();
    return ety && entry.sources.some((src) => ety.includes(src.toLowerCase()));
  });
  if (matched.length < WORDS_PER_CARD) continue;

  // 短い語から並べる。カードは一目で読めることが最優先
  const picked = matched.sort((a, b) => a.word.length - b.word.length).slice(0, WORDS_PER_CARD);

  const svg = renderCard(entry.root, entry.meaning, picked);
  await sharp(Buffer.from(svg), { density: 96 }).resize(1080, 1080).png()
    .toFile(join(OUT_DIR, `${entry.root}.png`));
  writeFileSync(join(OUT_DIR, `${entry.root}.txt`), caption(entry.root, entry.meaning, picked), "utf-8");
  made++;
}

console.log(`out/instagram/ に ${made} 枚（画像 + キャプション）を書き出しました。`);
console.log("1日1枚なら約" + Math.round(made / 7) + "週間分です。");
