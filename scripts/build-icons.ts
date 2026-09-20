/**
 * scripts/_icon.svg から PWA 用の PNG アイコンを書き出す。
 *
 *   npx tsx scripts/build-icons.ts
 *
 * マニフェストの icons に SVG を指定しても Chrome は受け付けるが、iOS の
 * apple-touch-icon と Android のスプラッシュは PNG を要求するため、
 * ラスタライズしたものを置いておく。アイコンを描き直したら再実行する。
 */

import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const svg = readFileSync(join(process.cwd(), "scripts", "_icon.svg"));
const outDir = join(process.cwd(), "public", "icons");
mkdirSync(outDir, { recursive: true });

// 192/512 は Android、180 は iOS の apple-touch-icon、32 はファビコン
for (const size of [32, 180, 192, 512]) {
  await sharp(svg).resize(size, size).png().toFile(join(outDir, `icon-${size}.png`));
  console.log(`icons/icon-${size}.png`);
}

/**
 * Android のアダプティブアイコンは外周を切り落とすので、安全域（中央8割）に
 * 収まるよう縮小して余白を足したものを別に用意する。
 */
const inner = await sharp(svg).resize(410, 410).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: "#1A1C1E" },
})
  .composite([{ input: inner, top: 51, left: 51 }])
  .png()
  .toFile(join(outDir, "icon-maskable-512.png"));
console.log("icons/icon-maskable-512.png");
