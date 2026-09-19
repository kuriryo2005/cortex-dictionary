/**
 * GET /api/og — SNS 共有時に出る OGP 画像（1200x630）を動的に生成する。
 *
 * 画像ファイルを別途作って置く方式だと、文言を変えるたびに作り直しになり
 * 実際には更新されなくなる。コードで描いておけばアプリ本体と一緒に育つ。
 *
 * Satori（@vercel/og の描画エンジン）は日本語フォントを内蔵していないため、
 * 何もしないと全て豆腐になる。Google Fonts の `text=` サブセット機能で、
 * この画像に出てくる文字だけを含む極小のフォントを取得して渡している。
 *
 * 注: 開発サーバー（scripts/devApiPlugin.ts）は api/*.ts しか読まないため、
 * ローカルでは 404 になる。確認は Vercel のプレビューデプロイで行う。
 */

import { ImageResponse } from "@vercel/og";

export const config = { runtime: "edge" };

const EYEBROW = "CORTEX DICTIONARY";
const TITLE_1 = "英単語を、";
const TITLE_2 = "バラバラに覚えるのをやめる。";
const LEAD = "意味・語源・専門分野ごとの用法を AI が一度に解説し、語源でつながるマップに描く";

/**
 * Google Fonts から、指定した文字だけを含むサブセットフォントを取ってくる。
 * CSS を取得 → 中の woff2/ttf の URL を抜き出す、という2段構え。
 */
async function loadFont(text: string, weight: number): Promise<ArrayBuffer | null> {
  try {
    const cssUrl =
      `https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@${weight}` +
      `&text=${encodeURIComponent(text)}`;
    // Google Fonts は User-Agent を見て形式を出し分ける。現代的な UA だと
    // woff2 が返ってきて Satori が読めないので、woff2 非対応の古い UA を名乗って
    // TTF を受け取る。
    const css = await fetch(cssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko",
      },
    }).then((r) => r.text());

    const url = /src:\s*url\((https:[^)]+)\)/.exec(css)?.[1];
    if (!url) return null;
    return await fetch(url).then((r) => r.arrayBuffer());
  } catch {
    // フォントが取れなくても画像自体は返す（英字だけは正しく出る）
    return null;
  }
}

export default async function handler(): Promise<ImageResponse> {
  const [bold, regular] = await Promise.all([
    loadFont(EYEBROW + TITLE_1 + TITLE_2, 900),
    loadFont(LEAD, 400),
  ]);

  const fonts = [
    ...(bold ? [{ name: "NotoJP", data: bold, weight: 900 as const, style: "normal" as const }] : []),
    ...(regular
      ? [{ name: "NotoJP", data: regular, weight: 400 as const, style: "normal" as const }]
      : []),
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#ffffff",
          padding: "72px 80px",
          fontFamily: "NotoJP, sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 22,
              letterSpacing: 6,
              color: "#2A5CFF",
              fontWeight: 700,
            }}
          >
            {EYEBROW}
          </div>
          <div
            style={{
              marginTop: 36,
              fontSize: 76,
              lineHeight: 1.15,
              color: "#1A1C1E",
              fontWeight: 900,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <span>{TITLE_1}</span>
            <span>{TITLE_2}</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ height: 1, backgroundColor: "#EDEFF1", display: "flex" }} />
          <div
            style={{
              marginTop: 28,
              fontSize: 28,
              color: "#656E77",
              lineHeight: 1.5,
              display: "flex",
            }}
          >
            {LEAD}
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts.length ? { fonts } : {}) }
  );
}
