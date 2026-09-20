/**
 * .env.local の Gemini API キーを Vercel の Production 環境変数に反映する。
 *
 * 本番は12本のうち5本しか入っておらず、しかもその5本は全モデルで枯渇して
 * いた（/api/health が healthy 0/5）。手作業で12本を貼り直すのは事故のもとな
 * ので、手元で「実際に生成できた」キーだけを選んで送り込む。
 *
 * 使い方:
 *   npx vercel login          … 一度だけ
 *   node scripts/push-keys-to-vercel.mjs --dry-run
 *   node scripts/push-keys-to-vercel.mjs
 *
 * キーの値は標準出力に一切出さない（末尾4文字だけ照合用に出す）。
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const DRY = process.argv.includes("--dry-run");

const CHAIN = [
  "gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.7-flash",
  "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash",
  "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite",
];

function readKeys() {
  const out = [];
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = /^(GEMINI_API_KEY(?:_\d+)?)\s*=\s*(.+)$/.exec(line.trim());
    if (m) out.push([m[1], m[2].trim().replace(/^["']|["']$/g, "")]);
  }
  return out;
}

async function canGenerate(key, model) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      }
    );
    return r.ok;
  } catch {
    return false;
  }
}

/** 枯れたキーを本番に送っても意味がないので、1本ずつ生きているか確かめる。 */
async function isAlive(key) {
  for (const model of CHAIN) if (await canGenerate(key, model)) return true;
  return false;
}

function vercel(args, input) {
  const r = spawnSync("npx", ["vercel", ...args], {
    input,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const all = readKeys();
if (all.length === 0) {
  console.error(".env.local に GEMINI_API_KEY が見つかりません。");
  process.exit(1);
}

console.log(`.env.local から ${all.length} 本のキーを読みました。生死を確認します…\n`);

const alive = [];
for (const [name, key] of all) {
  const ok = await isAlive(key);
  console.log(`  ${name.padEnd(20)} …${key.slice(-4)}  ${ok ? "使える" : "枯渇（送らない）"}`);
  if (ok) alive.push(key);
}

console.log(`\n使えるキー: ${alive.length} 本 / ${all.length} 本`);
if (alive.length === 0) {
  console.error("\n送れるキーがありません。枠の回復を待つか、従量課金を有効にしてください。");
  process.exit(1);
}

// 本番側は番号を詰めて 1..N で入れ直す。抜け番があっても読めるようには
// してあるが、詰めておいたほうが見て分かりやすい。
const plan = alive.map((key, i) => [i === 0 ? "GEMINI_API_KEY" : `GEMINI_API_KEY_${i + 1}`, key]);

console.log("\n本番（Production）に設定する変数:");
for (const [name, key] of plan) console.log(`  ${name.padEnd(20)} …${key.slice(-4)}`);

if (DRY) {
  console.log("\n--dry-run なので、ここで終了します。");
  process.exit(0);
}

console.log("");
for (const [name, key] of plan) {
  // 既にあると add は失敗するので、先に消してから入れる
  vercel(["env", "rm", name, "production", "--yes"]);
  const r = vercel(["env", "add", name, "production"], key + "\n");
  console.log(`  ${name.padEnd(20)} ${r.code === 0 ? "設定しました" : "失敗:\n" + r.out}`);
}

// 環境変数はデプロイ時に焼き込まれるので、入れ直しただけでは反映されない
console.log("\n環境変数は再デプロイで初めて反映されます。続けてデプロイします…");
const d = vercel(["--prod"]);
console.log(d.out.split("\n").slice(-6).join("\n"));
