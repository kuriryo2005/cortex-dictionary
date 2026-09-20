/**
 * OGP 画像（1200x630）を1枚の PNG として書き出す。
 *
 *   npx tsx scripts/build-og.ts
 *
 * 最初は @vercel/og でリクエストごとに生成していたが、Vercel 上で
 * FUNCTION_INVOCATION_FAILED になり、ローカルでは再現も調査もできなかった。
 * このアプリの OGP は全ページ共通の1枚で足りるので、ビルド時に作って
 * 静的ファイルとして置く。実行時の依存が1つ減り、落ちる余地が無くなる。
 *
 * 文言を変えたら scripts/_og-card.svg を直して再実行する。
 */

import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const svg = readFileSync(join(process.cwd(), "scripts", "_og-card.svg"));
const out = join(process.cwd(), "public", "og.png");

// density を指定すると SVG の指定サイズより大きく描かれるので、
// OGP の規定サイズ（1200x630）に揃えてから書き出す。
await sharp(svg, { density: 96 }).resize(1200, 630).png().toFile(out);
console.log(`public/og.png を書き出しました`);
