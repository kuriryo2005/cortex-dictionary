/**
 * 単語ごとの公開ページ（実験 E1）。
 *
 *   /w/<単語>  → GET /api/lookup?page=word&w=<単語>  （vercel.json の rewrites）
 *   /w/        → GET /api/lookup?page=index
 *
 * 論文で引っかかった人は X ではなく Google で「assay 論文 意味」と調べる。
 * 収録済みの解説を持っているのに、検索に載っていたのは語根の 21 ページだけだった。
 *
 * ## 作りの方針
 *
 * - **静的ファイルを 1 万枚作らない。** 作るには dictionary_cache を全件読む必要があり、
 *   本番と共有の無料枠を一度それで使い切って検索を止めた。ページは開かれたときに
 *   1 件だけ読み、CDN に 7 日持たせる。同じページで Firestore に来るのは週 1 回
 * - **一覧（リンク先・サイトマップ）は手元の台帳から作る**（wordIndex.json）。
 *   Firestore を読まずに「どの語にページがあるか」がわかる
 * - Hobby プランは関数 12 個までで枠が埋まっているので、lookup の GET に同居させる
 *
 * ## 量産ページの扱い（scripts/build-root-pages.ts の懸念）
 *
 * AI 生成の薄いページの大量公開は Google の scaled content abuse に当たりうる。
 * このサイトの差別化は「分野ごとの意味」なので、**分野別の用法が 2 つ以上ある語だけを
 * index させ**、それ以外は noindex にする（ページ自体は人が読めるよう残す）。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };
import wordIndex from "./wordIndex.json" with { type: "json" };
import featuredWords from "./featuredWords.json" with { type: "json" };
import ogCards from "./ogCards.json" with { type: "json" };
import { getServiceAccessToken } from "./googleAuth.js";

const SITE = "https://lexi-log-puce.vercel.app";
const DB_PATH = `projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}`;
const VALID_WORD = /^[a-z][a-z' -]{1,63}$/;
const INDEXED = new Set<string>(wordIndex as string[]);
/** 単語ごとの共有画像がある語（CortexAd/og_cards.mjs が public/og/w/ に作る）。無い語は汎用の og.png */
const OG_CARDS = new Set<string>(ogCards as string[]);

/** 1 インスタンスが 1 分間に Firestore を読む上限。クローラーの一斉巡回で枠を食わせない。 */
const READS_PER_MINUTE = 60;
let windowStart = 0;
let readsInWindow = 0;
function takeReadSlot(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    readsInWindow = 0;
  }
  if (readsInWindow >= READS_PER_MINUTE) return false;
  readsInWindow++;
  return true;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fromValue(v: Record<string, any> | undefined): unknown {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = fromValue(val as Record<string, any>);
    return out;
  }
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** 関連語は、ページがある語だけリンクにする（無いページへ誘導しない）。 */
function wordLink(w: string): string {
  const lw = w.trim().toLowerCase();
  return INDEXED.has(lw) ? `<a href="/w/${encodeURIComponent(lw)}">${esc(w)}</a>` : esc(w);
}

const STYLE = `
  :root { color-scheme: light; }
  body { margin:0; background:#fff; color:#1A1C1E;
         font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; line-height:1.8; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 56px 20px 96px; }
  .brand { font-size:12px; font-weight:700; letter-spacing:.1em; color:#2A5CFF; text-decoration:none; }
  h1 { font-size:34px; font-weight:900; margin:16px 0 0; letter-spacing:-0.01em; }
  .ph { color:#8A9199; font-size:15px; margin-left:8px; font-weight:400; }
  .meaning { font-size:17px; margin:8px 0 0; }
  h2 { font-size:12px; font-weight:700; letter-spacing:.1em; color:#8A9199; margin:44px 0 12px;
       border-top:1px solid #EDEFF1; padding-top:28px; }
  ul { margin:0; padding:0; list-style:none; }
  li { margin:0 0 12px; font-size:15px; }
  .field { font-weight:900; }
  p { font-size:15px; margin:0 0 10px; }
  .muted { color:#656E77; }
  a { color:#2A5CFF; }
  .cta { margin-top:48px; border-top:1px solid #EDEFF1; padding-top:28px; }
  .cta a.btn { display:inline-block; background:#1A1C1E; color:#fff; text-decoration:none; font-weight:700;
               font-size:14px; padding:12px 20px; }
  .cta p { color:#656E77; font-size:13px; margin-top:10px; }
  .foot { margin-top:56px; font-size:13px; color:#8A9199; }
  .foot a { color:#656E77; margin-right:14px; }
  .az a { display:inline-block; margin:0 10px 6px 0; }
  .share { margin-top:28px; font-size:13px; color:#656E77; }
  .share a { display:inline-block; margin:6px 8px 0 0; padding:7px 12px; border:1px solid #DDE1E5; color:#1A1C1E;
             text-decoration:none; font-weight:700; }
`;

function page(opts: { title: string; description: string; canonical: string; body: string; noindex?: boolean; image?: string }): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}" />
<link rel="canonical" href="${esc(opts.canonical)}" />
${opts.noindex ? '<meta name="robots" content="noindex, follow" />' : ""}
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:url" content="${esc(opts.canonical)}" />
<meta property="og:image" content="${esc(opts.image ?? `${SITE}/og.png`)}" />
<meta name="twitter:card" content="summary_large_image" />
<style>${STYLE}</style>
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body><div class="wrap">
<a class="brand" href="/">CORTEX DICTIONARY</a>
${opts.body}
<div class="foot"><a href="/">トップ</a><a href="/w/">単語一覧</a><a href="/root/">語源の索引</a></div>
</div></body></html>`;
}

function html(body: string, status: number, cache: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache },
  });
}

const HIT_CACHE = "public, s-maxage=604800, stale-while-revalidate=86400";

/** /w/ — ページがある語の一覧（頭文字ごと）。クローラーが全ページへ辿れる入口。 */
function renderIndex(): Response {
  const groups = new Map<string, string[]>();
  for (const w of wordIndex as string[]) {
    const k = w[0];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(w);
  }
  const letters = [...groups.keys()].sort();
  // サイトマップに載せている語（E8）を先頭にまとめ、内部リンクもここへ集める
  const body = `
<h1>論文で出会う英単語 ${wordIndex.length.toLocaleString()} 語</h1>
<p class="meaning muted">分野ごとの意味（統計・工学・医学・生物など）がわかる英単語の一覧です。</p>
<h2 id="featured">論文で意味が変わる英単語 ${featuredWords.length} 語</h2>
<ul>${(featuredWords as { w: string; fields: string[] }[])
    .map((x) => `<li><a href="/w/${encodeURIComponent(x.w)}">${esc(x.w)}</a> <span class="muted">${esc(x.fields.join("・"))}</span></li>`)
    .join("")}</ul>
<h2>すべての単語</h2>
<p class="az">${letters.map((l) => `<a href="#${l}">${l.toUpperCase()}</a>`).join("")}</p>
${letters
  .map(
    (l) => `<h2 id="${l}">${l.toUpperCase()}</h2><p>${groups
      .get(l)!
      .map((w) => `<a href="/w/${encodeURIComponent(w)}">${esc(w)}</a>`)
      .join(" / ")}</p>`
  )
  .join("\n")}`;
  return html(
    page({
      title: "論文で出会う英単語の一覧（分野別の意味つき） | Cortex Dictionary",
      description: `統計・工学・医学などの分野ごとの意味がわかる英単語 ${wordIndex.length} 語の一覧。論文で辞書の意味では読めない単語を調べられます。`,
      canonical: `${SITE}/w/`,
      body,
    }),
    200,
    HIT_CACHE
  );
}

function notFound(word: string): Response {
  return html(
    page({
      title: `${word} | Cortex Dictionary`,
      description: "この単語のページはまだありません。",
      canonical: `${SITE}/w/`,
      noindex: true,
      body: `<h1>${esc(word)}</h1>
<p class="meaning muted">この単語のページはまだありません。アプリでは、その場で AI が解説を作ります。</p>
<div class="cta"><a class="btn" href="/?w=${encodeURIComponent(word)}&utm_source=seo&utm_medium=wordpage">アプリで ${esc(word)} を引く</a></div>`,
    }),
    404,
    "public, s-maxage=3600"
  );
}

export async function renderWordPage(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("page") === "index") return renderIndex();

  const word = decodeURIComponent(url.searchParams.get("w") ?? "").trim().toLowerCase();
  if (!VALID_WORD.test(word)) return notFound(word.slice(0, 64));

  if (!takeReadSlot()) {
    return new Response("混み合っています。少し待ってから再読み込みしてください。", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "120", "cache-control": "no-store" },
    });
  }

  let res: Response;
  let read: (mode: string) => Promise<Response>;
  try {
    const token = await getServiceAccessToken();
    read = (mode) =>
      fetch(`https://firestore.googleapis.com/v1/${DB_PATH}/documents/dictionary_cache/${encodeURIComponent(`${word}__${mode}`)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    res = await read("gen");
  } catch (e) {
    console.error("[wordPage] firestore fetch failed", e);
    return new Response("いまは表示できません。", { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } });
  }
  if (res.status === 404) return notFound(word);
  if (!res.ok) {
    // 429/5xx は「無い」ではなく「わからない」。404 を返すとクローラーにページが消えたと伝わる
    console.warn(`[wordPage] firestore ${res.status} for ${word}`);
    return new Response("いまは表示できません。", { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } });
  }

  const parse = async (r: Response) => {
    const doc = (await r.json()) as { fields?: Record<string, Record<string, any>> };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc.fields ?? {})) out[k] = fromValue(v);
    return out;
  };
  const contextsOf = (x: Record<string, unknown>) =>
    list(x.specializedContexts)
      .map((c: any) => ({ field: str(c?.field), context: str(c?.context) }))
      .filter((c) => c.field && c.context);

  let d = await parse(res);
  let contexts = contextsOf(d);
  // 一般モードの項目は分野の用法が 1 つしかないことがある（stress は Medicine だけ）。
  // 学術モードの項目があり用法が多ければ、そちらでページを作る（読むのは薄いときだけ）
  if (contexts.length < 2 && takeReadSlot()) {
    try {
      const aca = await read("aca");
      if (aca.ok) {
        const a = await parse(aca);
        const ac = contextsOf(a);
        if (ac.length > contexts.length && str(a.meaning)) {
          d = a;
          contexts = ac;
        }
      }
    } catch (e) {
      console.warn("[wordPage] aca fallback failed", e);
    }
  }

  const title = str(d.word) || word;
  const meaning = str(d.meaning);
  const phonetic = str(d.phonetic);
  const nuance = str(d.nuance);
  const etymology = str(d.etymology);
  const examples = list(d.examples).map(str).filter(Boolean).slice(0, 4);
  const synonyms = list(d.synonyms).map((s: any) => ({ w: str(s?.word), t: str(s?.translation) })).filter((s) => s.w);
  const antonyms = list(d.antonyms).map((s: any) => ({ w: str(s?.word), t: str(s?.translation) })).filter((s) => s.w);
  const collocations = list(d.collocations).map(str).filter(Boolean).slice(0, 8);

  // 差別化の中身（分野ごとの意味）が薄いページは検索に出さない
  const thin = contexts.length < 2 || !meaning;

  const fields = contexts.map((c) => c.field).slice(0, 3).join("・");
  const pageTitle = fields
    ? `${title} の意味｜論文での使い方（${fields}） | Cortex Dictionary`
    : `${title} の意味と使い方 | Cortex Dictionary`;
  const description = `${title}：${meaning}${
    contexts[0] ? `。${contexts[0].field}では「${contexts[0].context.slice(0, 60)}」` : ""
  }`.slice(0, 150);

  // 共有（E11）。流入は utm_source=share、どこから共有されたかを utm_medium で分ける
  const shareUrl = (medium: string) =>
    `${SITE}/w/${encodeURIComponent(word)}?utm_source=share&utm_medium=${medium}`;
  const shareText = contexts.length
    ? `${title} は論文だと意味が変わる：${contexts
        .slice(0, 2)
        .map((c) => `${c.field}「${c.context.slice(0, 24)}${c.context.length > 24 ? "…" : ""}」`)
        .join(" / ")}`
    : `${title} の意味：${meaning}`;
  const share = `<div class="share">この単語を共有：
<a href="https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl("x"))}" target="_blank" rel="noopener">X</a><a href="https://www.threads.net/intent/post?text=${encodeURIComponent(`${shareText} ${shareUrl("threads")}`)}" target="_blank" rel="noopener">Threads</a><a href="https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(shareUrl("line"))}" target="_blank" rel="noopener">LINE</a>
</div>`;

  const rel = (items: { w: string; t: string }[]) =>
    items
      .slice(0, 8)
      .map((s) => `<li>${wordLink(s.w)}${s.t ? ` <span class="muted">${esc(s.t)}</span>` : ""}</li>`)
      .join("");

  const body = `
<h1>${esc(title)}${phonetic ? `<span class="ph">/${esc(phonetic)}/</span>` : ""}</h1>
<p class="meaning">${esc(meaning)}</p>
${contexts.length ? `<h2>分野ごとの意味</h2><ul>${contexts
    .map((c) => `<li><span class="field">(${esc(c.field)})</span> ${esc(c.context)}</li>`)
    .join("")}</ul>` : ""}
${nuance ? `<h2>ニュアンスと使い分け</h2><p>${esc(nuance)}</p>` : ""}
${examples.length ? `<h2>例文</h2><ul>${examples.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
${collocations.length ? `<h2>よく一緒に使う語</h2><p>${collocations.map(esc).join(" / ")}</p>` : ""}
${synonyms.length ? `<h2>類義語</h2><ul>${rel(synonyms)}</ul>` : ""}
${antonyms.length ? `<h2>対義語</h2><ul>${rel(antonyms)}</ul>` : ""}
${etymology ? `<h2>語源</h2><p class="muted">${esc(etymology)}</p>` : ""}
${share}
<div class="cta">
<a class="btn" href="/?w=${encodeURIComponent(word)}&utm_source=seo&utm_medium=wordpage">${esc(title)} を単語帳に保存する</a>
<p>Cortex Dictionary は、論文の英単語を分野ごとの意味で引ける英単語アプリです。Google アカウントで無料ではじめられます。</p>
</div>`;

  const image = OG_CARDS.has(word) ? `${SITE}/og/w/${encodeURIComponent(word)}.png` : undefined;
  return html(page({ title: pageTitle, description, canonical: `${SITE}/w/${encodeURIComponent(word)}`, body, noindex: thin, image }), 200, HIT_CACHE);
}
