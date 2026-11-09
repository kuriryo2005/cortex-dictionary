/**
 * 語根ページ（public/root/）から、サイトマップに載せている単語ページ（/w/）へ内部リンクを張る（実験 E8）。
 *
 *   npx tsx scripts/link-featured-from-roots.mts
 *
 * build-word-index.mts が作る api/_lib/featuredWords.json の語を、語根ページごとに 15 語ずつ
 * ずらして割り当てる（どの語にもどこかの語根ページから 1 本はリンクが来るように）。
 * 語根ページに載っている語とは重ならないので、ページ末尾に「論文で意味が変わる英単語」として足す。
 *
 * **Firestore は読まない。** 既存の HTML を書き換えるだけで、何度流しても同じ結果になる
 * （印のコメントの間を置き換える）。build-root-pages.ts で作り直したら、もう一度流すこと。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PER_PAGE = 15;
const START = "<!-- featured:start -->";
const END = "<!-- featured:end -->";

const featured = JSON.parse(readFileSync("api/_lib/featuredWords.json", "utf8")) as { w: string; fields: string[] }[];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function block(words: { w: string; fields: string[] }[]): string {
  const links = words
    .map((x) => `<a href="/w/${encodeURIComponent(x.w)}">${esc(x.w)}</a>`)
    .join(" ");
  return `${START}
    <nav class="siblings">
      <h2>論文で意味が変わる英単語</h2>
      <p>${links}</p>
      <p><a href="/w/#featured">${featured.length} 語をすべて見る</a></p>
    </nav>
    ${END}`;
}

function inject(html: string, b: string, before: string): string {
  const s = html.indexOf(START);
  if (s >= 0) {
    const e = html.indexOf(END, s);
    return html.slice(0, s) + b + html.slice(e + END.length);
  }
  const at = html.lastIndexOf(before);
  if (at < 0) throw new Error(`挿入位置 ${before} が見つからない`);
  return html.slice(0, at) + b + "\n    " + html.slice(at);
}

const slugs = readdirSync("public/root")
  .filter((s) => existsSync(join("public/root", s, "index.html")))
  .sort();

let i = 0;
for (const slug of slugs) {
  const file = join("public/root", slug, "index.html");
  const html = readFileSync(file, "utf8");
  const words = Array.from({ length: PER_PAGE }, (_, k) => featured[(i * PER_PAGE + k) % featured.length]);
  i++;
  writeFileSync(file, inject(html, block(words), "<footer>"));
}

// 索引ページ（public/root/index.html）には一覧への入口だけ
const indexFile = "public/root/index.html";
const indexHtml = readFileSync(indexFile, "utf8");
const hub = `${START}
    <p style="margin-top:48px"><a href="/w/#featured">論文で意味が変わる英単語 ${featured.length} 語 →</a></p>
    ${END}`;
writeFileSync(indexFile, inject(indexHtml, hub, "</div>\n</body>"));

console.log(`語根ページ ${slugs.length} 枚に ${PER_PAGE} 語ずつ、索引に入口を足した`);
