/**
 * 単語ページ（/w/<単語>）の一覧とサイトマップを作る（実験 E1）。
 *
 *   npx tsx scripts/build-word-index.mts
 *
 * **Firestore は読まない。** 収録済みの語は手元の台帳からわかる:
 *   - scripts/_batch/ingested.txt … 事前学習で一般モードに書き込んだ語（1 行 1 語）
 *   - public/root/<slug>/index.html … 語根ページに載っている語（収録済みの語から作られている）
 * 以前、存在確認のためだけに dictionary_cache を大量に読み、本番と共有の無料枠を使い切った。
 *
 * 出力:
 *   - api/_lib/wordIndex.json … ページがある語の一覧（関連語のリンク判定と /w/ の一覧に使う）
 *   - public/sitemap-words.xml … 検索エンジン向け
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://lexi-log-puce.vercel.app";
const VALID = /^[a-z][a-z'-]{1,63}$/; // URL に空白を入れないため熟語は除く

const words = new Set<string>();

for (const line of readFileSync("scripts/_batch/ingested.txt", "utf8").split(/\r?\n/)) {
  const w = line.trim().toLowerCase();
  if (VALID.test(w)) words.add(w);
}

const rootDir = "public/root";
for (const slug of readdirSync(rootDir)) {
  const file = join(rootDir, slug, "index.html");
  if (!existsSync(file)) continue;
  for (const m of readFileSync(file, "utf8").matchAll(/\?w=([a-z'-]+)"/g)) {
    const w = m[1].toLowerCase();
    if (VALID.test(w)) words.add(w);
  }
}

const sorted = [...words].sort();
writeFileSync("api/_lib/wordIndex.json", JSON.stringify(sorted));

/*
 * サイトマップに載せる語を上位 FEATURED_COUNT 語に絞る（実験 E8）。
 * 4,155 URL を出しても Google は「検出 - インデックス未登録」のまま 1 ページしか登録しなかった。
 * 量を減らして、このサイトの差別化（論文の分野での意味）が濃い語だけを出す。
 * ページ自体は全語残し、/w/ の一覧と関連語のリンクからは今までどおり辿れる。
 *
 * 順位は事前学習の台帳（scripts/_batch/*.jsonl、f = 分野別の用法）から決める。Firestore は読まない。
 * 台帳の用法はどの語も 2 つまでなので数では差がつかない。代わりに「論文を読む人が出会う分野か」で重み付けする。
 */
const FEATURED_COUNT = 300;
const FIELD_WEIGHT: Record<string, number> = Object.fromEntries([
  ...["Science", "Medicine", "Biology", "Chemistry", "Physics", "Mathematics", "Statistics", "Engineering",
    "Psychology", "Economics", "Computer Science", "Geology", "Ecology", "Astronomy", "Botany", "Sociology",
    "Linguistics", "Academia", "Environment"].map((f) => [f, 2]),
  ...["Law", "Technology", "Finance", "Agriculture", "History", "Philosophy", "Geography", "Politics"].map((f) => [f, 1]),
]);
const LEVEL_BONUS: Record<string, number> = { 難関: 1, 標準: 0.5 };

type Entry = { w: string; m?: string; l?: string; i?: number; f?: [string, string][] };
const latest = new Map<string, Entry>(); // 書き直し（b/r）の版が後に来るので、後勝ち
for (const name of readdirSync("scripts/_batch").filter((n) => n.endsWith(".jsonl")).sort()) {
  for (const line of readFileSync(join("scripts/_batch", name), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      const w = String(e.w ?? "").toLowerCase();
      if (words.has(w)) latest.set(w, e);
    } catch {
      // 書きかけの行は飛ばす
    }
  }
}

/*
 * 看板語（実験 E12）。リール・X・Threads・プレスリリースで例に出す語は、事前学習の台帳に
 * 無かったり点数が低かったりして上位 300 から漏れていた。検索で来た人が宣伝と同じ語に着けるよう先頭に置く。
 * どれも本番の収録で分野別の用法が 2 つ以上あることを 2026-10-31 に確かめた（stress は学術モードの項目）。
 */
const FLAGSHIP: { w: string; fields: string[] }[] = [
  { w: "significant", fields: ["Statistics", "Medicine"] },
  { w: "stress", fields: ["Engineering", "Psychology"] },
  { w: "power", fields: ["Physics", "Politics"] },
  { w: "robust", fields: ["Statistics", "Economics"] },
  { w: "confound", fields: ["Science", "Medicine"] },
  { w: "solution", fields: ["Chemistry", "Mathematics"] },
  { w: "culture", fields: ["Biology", "Sociology"] },
  { w: "medium", fields: ["Biology", "Media"] },
  { w: "strain", fields: ["Medicine", "Psychology"] },
  { w: "yield", fields: ["Agriculture", "Finance"] },
  { w: "suggest", fields: ["Science", "Business"] },
  { w: "indicate", fields: ["Science", "Economics"] },
  { w: "vehicle", fields: ["Environment", "Law"] },
];
for (const f of FLAGSHIP) words.add(f.w);
writeFileSync("api/_lib/wordIndex.json", JSON.stringify([...words].sort()));
const flagshipSet = new Set(FLAGSHIP.map((f) => f.w));

const ranked = [...latest.entries()]
  .map(([w, e]) => {
    const fields = [...new Set((e.f ?? []).map((x) => x?.[0]).filter(Boolean))];
    const score =
      fields.reduce((s, f) => s + (FIELD_WEIGHT[f] ?? 0), 0) + (LEVEL_BONUS[e.l ?? ""] ?? 0) + (e.i ?? 0);
    return { w, fields, score, ok: fields.length >= 2 && !!e.m };
  })
  .filter((x) => x.ok && !flagshipSet.has(x.w))
  .sort((a, b) => b.score - a.score || a.w.localeCompare(b.w))
  .map(({ w, fields }) => ({ w, fields }));
const featured = [...FLAGSHIP, ...ranked].slice(0, FEATURED_COUNT);
writeFileSync("api/_lib/featuredWords.json", JSON.stringify(featured));

const today = new Date().toISOString().slice(0, 10);
const urls = [`${SITE}/w/`, ...featured.map((x) => `${SITE}/w/${encodeURIComponent(x.w)}`)];
writeFileSync(
  "public/sitemap-words.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`
);

console.log(
  `単語ページ ${sorted.length} 語 → api/_lib/wordIndex.json／サイトマップ ${featured.length} 語 → api/_lib/featuredWords.json / public/sitemap-words.xml`
);
