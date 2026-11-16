/**
 * 単語の共有画像（Instagram 用、1080x1350 = フィードの 4:5）。
 *
 * ブラウザの canvas で描くので、サーバーにも生成 API にも負荷をかけない。
 * 描く内容は辞書の結果だけ（ふつうの意味と、分野ごとの意味）。数字や声は足さない。
 */

export interface ShareCardInput {
  word: string;
  meaning: string;
  phonetic?: string;
  contexts: { field: string; context: string }[];
}

export const CARD_W = 1080;
export const CARD_H = 1350;

const PAPER = "#F4EFE6";
const INK = "#16181B";
const MUTED = "#6B6F75";
const ACCENT = "#E8472B";
const RULE = "#D9D1C3";

const SANS = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif';
const SERIF = 'Georgia, "Times New Roman", "Noto Serif JP", serif';

/** 1行に収まるよう文字単位で折り返す（日本語は単語の区切りが無いので文字単位）。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of Array.from(text)) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join("").length;
  if (used < Array.from(text).length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last + "…";
  }
  return lines;
}

/** 単語が横幅に収まる最大のフォントサイズ。 */
function fitWord(ctx: CanvasRenderingContext2D, word: string, maxW: number, start: number, min: number): number {
  let size = start;
  while (size > min) {
    ctx.font = `700 ${size}px ${SERIF}`;
    if (ctx.measureText(word).width <= maxW) break;
    size -= 4;
  }
  return size;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 「ふつうの意味」から最初の1〜2語だけを取る（長い説明文は画像では読まれない）。 */
function shortMeaning(meaning: string): string {
  const first = meaning.split(/[。\n]/)[0] ?? meaning;
  const parts = first.split(/[；;、,]/).map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 2).join("・") || first;
}

/** 文中の「」の二重化（「「…」」）を直す。 */
function tidy(s: string): string {
  let t = s.replace(/「「/g, "「").replace(/」」/g, "」").trim();
  if (t.startsWith("「") && t.endsWith("」")) t = t.slice(1, -1);
  return t;
}

export async function renderShareCard(input: ShareCardInput): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas が使えません");
  try {
    await document.fonts?.ready;
  } catch {
    // フォントの読み込みを待てなくても、手元のフォントで描く
  }

  const M = 88; // 左右の余白
  const W = CARD_W - M * 2;

  // 紙
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 上の帯: 問いかけ
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, CARD_W, 120);
  ctx.fillStyle = PAPER;
  ctx.font = `700 40px ${SANS}`;
  ctx.textBaseline = "middle";
  ctx.fillText("その単語、論文では意味が変わる。", M, 62);
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(CARD_W - M - 14, 62, 14, 0, Math.PI * 2);
  ctx.fill();

  // 単語
  ctx.textBaseline = "alphabetic";
  const size = fitWord(ctx, input.word, W, 176, 72);
  ctx.font = `700 ${size}px ${SERIF}`;
  ctx.fillStyle = INK;
  let y = 120 + 70 + size * 0.82;
  ctx.fillText(input.word, M - 4, y);

  // 発音
  if (input.phonetic) {
    y += 64;
    ctx.font = `400 38px ${SERIF}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(`/${input.phonetic}/`, M, y);
  }

  // ふつうの意味
  y += 92;
  ctx.font = `700 28px ${SANS}`;
  ctx.fillStyle = MUTED;
  ctx.fillText("ふつうの意味", M, y);
  y += 62;
  ctx.font = `700 50px ${SANS}`;
  ctx.fillStyle = INK;
  for (const line of wrap(ctx, shortMeaning(input.meaning), W, 1)) {
    ctx.fillText(line, M, y);
  }

  // 区切り
  y += 52;
  ctx.fillStyle = ACCENT;
  ctx.fillRect(M, y, 120, 8);
  ctx.fillStyle = RULE;
  ctx.fillRect(M + 132, y + 3, W - 132, 2);

  // 分野ごとの意味（最大3つ）
  y += 74;
  ctx.font = `700 28px ${SANS}`;
  ctx.fillStyle = ACCENT;
  ctx.fillText("論文・分野での意味", M, y);
  const footerTop = CARD_H - 170;
  const items = input.contexts.filter((c) => c.field && c.context).slice(0, 3);
  for (const c of items) {
    if (y > footerTop - 120) break;
    y += 66;
    ctx.font = `700 34px ${SANS}`;
    ctx.fillStyle = INK;
    ctx.fillText(c.field, M, y);
    ctx.font = `400 34px ${SANS}`;
    ctx.fillStyle = "#3A3D42";
    const room = Math.max(1, Math.min(2, Math.floor((footerTop - y - 20) / 50)));
    for (const line of wrap(ctx, tidy(c.context), W, room)) {
      y += 50;
      ctx.fillText(line, M, y);
    }
  }

  // 下: ブランド
  ctx.fillStyle = RULE;
  ctx.fillRect(M, footerTop, W, 2);
  const icon = await loadImage("/icons/icon-192.png");
  const fy = footerTop + 44;
  if (icon) ctx.drawImage(icon, M, fy, 84, 84);
  const tx = icon ? M + 108 : M;
  ctx.fillStyle = INK;
  ctx.font = `700 38px ${SANS}`;
  ctx.fillText("Cortex Dictionary", tx, fy + 38);
  ctx.font = `400 28px ${SANS}`;
  ctx.fillStyle = MUTED;
  ctx.fillText("論文の英単語を、その分野の意味で。", tx, fy + 80);
  ctx.textAlign = "right";
  ctx.font = `700 26px ${SANS}`;
  ctx.fillStyle = ACCENT;
  ctx.fillText("lexi-log-puce.vercel.app", CARD_W - M, fy + 38);
  ctx.textAlign = "left";

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした"))), "image/png"),
  );
}
