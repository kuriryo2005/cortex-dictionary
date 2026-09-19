/**
 * 語源ルートごとの静的ページを生成する（検索流入の本命）。
 *
 *   npx tsx scripts/build-root-pages.ts
 *
 * `dictionary_cache` を全件読み、`etymologyNodes[].root` で単語をまとめて
 * `public/root/<slug>/index.html` を吐く。Vite が dist にコピーし、Vercel が
 * 静的ファイルとして配信する（SPA とは別の実体のあるページになる）。
 *
 * ## なぜ「1単語1ページ」ではなく「語源ルート1ページ」なのか
 *
 * 単語ごとに1万ページ作るのが programmatic SEO の定番だが、中身が AI 生成の
 * 薄いページの大量生産は Google の scaled content abuse ポリシーに真正面から
 * 当たる。加えて "serendipity 意味" のような単語クエリは辞書サイトが独占して
 * いて、個人サイトが勝てる余地がほとんどない。
 *
 * 対して「語源 spect 英単語」のようなクエリは、
 *   - 検索する人が明確に存在する（受験生・語彙を体系で覚えたい人）
 *   - まとまった一覧を出しているサイトが少ない
 *   - このアプリの語彙ナレッジマップという独自資産がそのまま中身になる
 * という三拍子が揃う。ページ数は数百に収まり、1ページあたりの情報量も厚い。
 *
 * そのため、**6語以上が集まったルートだけ**をページ化する。数合わせで
 * 薄いページを作らないこと。
 *
 * 認証は Stripe Webhook と同じサービスアカウントを使う（FIREBASE_SERVICE_ACCOUNT）。
 */

import "dotenv/config";
import { config } from "dotenv";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getServiceAccessToken } from "../api/_lib/googleAuth.js";
import firebaseConfig from "../firebase-applet-config.json" with { type: "json" };

config({ path: ".env.local", override: true });

const SITE = process.env.APP_BASE_URL ?? "https://lexi-log-puce.vercel.app";
const OUT_DIR = join(process.cwd(), "public", "root");
/** これ未満の語しか集まらないルートはページにしない（薄いページを作らない）。 */
const MIN_WORDS = 6;
/** 1ページに載せる語数の上限。多すぎると読めない。 */
const MAX_WORDS_PER_PAGE = 40;

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

interface CachedWord {
  word: string;
  meaning: string;
  etymology: string;
  roots: { root: string; relation: string }[];
}

/** Firestore REST の値表現からプレーンな JS 値に戻す。 */
function fromValue(v: any): any {
  if (v == null) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = fromValue(val);
    return out;
  }
  return undefined;
}

async function fetchAllCached(token: string): Promise<CachedWord[]> {
  const words: CachedWord[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BASE_URL}/dictionary_cache`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`dictionary_cache の取得に失敗: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { documents?: any[]; nextPageToken?: string };

    for (const doc of data.documents ?? []) {
      const f = doc.fields ?? {};
      const word = fromValue(f.word);
      const meaning = fromValue(f.meaning);
      if (!word || !meaning) continue;

      const nodes = (fromValue(f.etymologyNodes) ?? []) as { root?: string; relation?: string }[];
      const roots = nodes
        .map((n) => ({ root: String(n?.root ?? "").trim().toLowerCase(), relation: String(n?.relation ?? "") }))
        .filter((r) => r.root.length >= 2 && /^[a-z-]+$/.test(r.root));

      words.push({ word, meaning, etymology: fromValue(f.etymology) ?? "", roots });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return words;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(root: string): string {
  return root.replace(/[^a-z-]/g, "");
}

/**
 * ルートの意味は relation 文字列（例: "shares same root 'spect' (to look)"）の
 * 括弧から拾う。拾えなければ空にする（もっともらしい嘘を書かない）。
 */
function guessRootMeaning(relations: string[]): string {
  for (const r of relations) {
    const m = /\(([^)]{2,40})\)/.exec(r);
    if (m) return m[1].trim();
  }
  return "";
}

function renderPage(root: string, meaning: string, words: CachedWord[]): string {
  const title = meaning
    ? `語源 ${root}（${escapeHtml(meaning)}）から広がる英単語 ${words.length}語`
    : `語源 ${root} を共有する英単語 ${words.length}語`;
  const description = `語源 ${root} を共有する英単語を${words.length}語まとめました。${words
    .slice(0, 5)
    .map((w) => w.word)
    .join(" / ")} など。意味と語源の説明つき。`;
  const url = `${SITE}/root/${slugify(root)}/`;

  const items = words
    .map(
      (w) => `      <li class="word">
        <h2>${escapeHtml(w.word)}</h2>
        <p class="meaning">${escapeHtml(w.meaning)}</p>
        ${w.etymology ? `<p class="etym">${escapeHtml(w.etymology)}</p>` : ""}
      </li>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} | Cortex Dictionary</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${url}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${SITE}/api/og" />
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#fff; color:#1A1C1E;
         font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
         line-height:1.7; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 64px 24px 96px; }
  h1 { font-size: 28px; font-weight: 900; letter-spacing:-0.01em; margin:0 0 12px; }
  .lead { color:#656E77; font-size:14px; margin:0 0 40px; }
  ul { list-style:none; margin:0; padding:0; }
  .word { border-top:1px solid #EDEFF1; padding:20px 0; }
  .word h2 { font-size:18px; font-weight:900; margin:0 0 4px; }
  .meaning { margin:0; font-size:14px; }
  .etym { margin:6px 0 0; font-size:13px; color:#656E77; }
  .cta { margin-top:56px; border-top:1px solid #EDEFF1; padding-top:28px; }
  .cta a { display:inline-block; background:#1A1C1E; color:#fff; text-decoration:none;
           font-weight:700; font-size:14px; padding:12px 20px; }
  .cta p { color:#656E77; font-size:13px; }
  footer { margin-top:64px; font-size:11px; color:#8A9199; }
  footer a { color:#8A9199; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(title)}</h1>
    <p class="lead">${escapeHtml(description)}</p>
    <ul>
${items}
    </ul>
    <div class="cta">
      <p>この ${words.length} 語のつながりを、力学グラフのマップで見ることができます。まだ知らない語は
         シルエットで表示されるので、次に覚えるべき単語が一目でわかります。</p>
      <a href="${SITE}/">Cortex Dictionary を無料で使う</a>
    </div>
    <footer><a href="${SITE}/">Cortex Dictionary</a></footer>
  </div>
</body>
</html>
`;
}

// ── 実行 ────────────────────────────────────────────────────────

const token = await getServiceAccessToken();
const cached = await fetchAllCached(token);
console.log(`dictionary_cache: ${cached.length} 語`);

const byRoot = new Map<string, { words: Map<string, CachedWord>; relations: string[] }>();
for (const w of cached) {
  for (const { root, relation } of w.roots) {
    let entry = byRoot.get(root);
    if (!entry) {
      entry = { words: new Map(), relations: [] };
      byRoot.set(root, entry);
    }
    entry.words.set(w.word.toLowerCase(), w);
    if (relation) entry.relations.push(relation);
  }
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const generated: { root: string; count: number }[] = [];

for (const [root, entry] of byRoot) {
  if (entry.words.size < MIN_WORDS) continue;
  const slug = slugify(root);
  if (!slug) continue;

  const words = [...entry.words.values()]
    .sort((a, b) => a.word.localeCompare(b.word))
    .slice(0, MAX_WORDS_PER_PAGE);

  const dir = join(OUT_DIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), renderPage(root, guessRootMeaning(entry.relations), words), "utf-8");
  generated.push({ root, count: words.length });
}

generated.sort((a, b) => b.count - a.count);
console.log(`生成: ${generated.length} ページ（${MIN_WORDS}語以上のルートのみ）`);
console.log(generated.slice(0, 10).map((g) => `  ${g.root} (${g.count})`).join("\n"));

// 一覧ページ（内部リンクのハブ。孤立ページはクロールされにくい）
const indexItems = generated
  .map((g) => `      <li><a href="/root/${slugify(g.root)}/">${escapeHtml(g.root)}</a> <span>${g.count}語</span></li>`)
  .join("\n");
writeFileSync(
  join(OUT_DIR, "index.html"),
  `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>語源から覚える英単語の索引 | Cortex Dictionary</title>
<meta name="description" content="語源（ラテン語・ギリシャ語の語根）ごとに英単語をまとめた索引。${generated.length}個の語源から、つながりで英単語を覚えられます。" />
<link rel="canonical" href="${SITE}/root/" />
<style>
  body { margin:0; background:#fff; color:#1A1C1E;
         font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; line-height:1.7; }
  .wrap { max-width:720px; margin:0 auto; padding:64px 24px 96px; }
  h1 { font-size:28px; font-weight:900; margin:0 0 12px; }
  .lead { color:#656E77; font-size:14px; margin:0 0 40px; }
  ul { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:8px 20px; }
  li a { color:#1A1C1E; font-weight:700; text-decoration:none; }
  li span { color:#8A9199; font-size:12px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>語源から覚える英単語の索引</h1>
    <p class="lead">語根ごとに英単語をまとめました。${generated.length} 個の語源が並んでいます。</p>
    <ul>
${indexItems}
    </ul>
  </div>
</body>
</html>
`,
  "utf-8"
);

// sitemap と robots
const urls = [`${SITE}/`, `${SITE}/root/`, ...generated.map((g) => `${SITE}/root/${slugify(g.root)}/`)];
writeFileSync(
  join(process.cwd(), "public", "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`,
  "utf-8"
);
writeFileSync(
  join(process.cwd(), "public", "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
  "utf-8"
);

console.log("sitemap.xml と robots.txt も書き出しました。");
