/**
 * 新しい Gemini API キーを .env.local に反映する。
 *
 * AI Studio でキーを作り直したとき、値はブラウザの中にしか無い。
 * 12行を手で書き換えるのは事故のもとなので、貼り付けたものを
 * こちらで割り当てる。
 *
 *   node scripts/apply-new-keys.mjs           … 対話（メモ帳が開く）
 *   node scripts/apply-new-keys.mjs <file>    … 貼り付け済みのファイルを読む
 *
 * 残したいキーは --keep で指定する（既定は 2,3,4,5,6）。
 * 新しいキーは、残した枠以外に上から順に入る。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const keepArg = args.find((a) => a.startsWith("--keep="));
const KEEP = new Set(
  (keepArg ? keepArg.slice(7) : "2,3,4,5,6").split(",").map((s) => Number(s.trim()))
);
const fileArg = args.find((a) => !a.startsWith("--"));

const SLOTS = 12;
const slotName = (i) => (i === 1 ? "GEMINI_API_KEY" : `GEMINI_API_KEY_${i}`);

function readEnv() {
  return fs.readFileSync(".env.local", "utf8").split(/\r?\n/);
}

// 貼り付け先を用意する
let pastePath = fileArg;
if (!pastePath) {
  pastePath = path.join(os.tmpdir(), "cortex-new-keys.txt");
  fs.writeFileSync(
    pastePath,
    [
      "# ここに新しい Gemini API キーを 1行に1つ貼り付けて、保存して閉じてください。",
      "# AIza... で始まる行だけを読みます。この説明行は消さなくて大丈夫です。",
      `# 残す枠: ${[...KEEP].join(", ")} 番（ここは書き換えません）`,
      "",
    ].join("\r\n"),
    "utf8"
  );
  console.log("メモ帳が開きます。キーを貼り付けて保存し、閉じてください…\n");
  spawnSync("notepad.exe", [pastePath], { stdio: "inherit" });
}

const pasted = [
  ...new Set(
    fs
      .readFileSync(pastePath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^AIza[\w-]{20,}$/.test(l))
  ),
];

if (pasted.length === 0) {
  console.error("キーが1つも見つかりませんでした（AIza… で始まる行が必要です）。");
  process.exit(1);
}
console.log(`新しいキー: ${pasted.length} 本`);

// 埋める枠を決める
const targets = [];
for (let i = 1; i <= SLOTS; i++) if (!KEEP.has(i)) targets.push(i);

if (pasted.length < targets.length) {
  console.log(`※ 枠は ${targets.length} 個ありますが、キーは ${pasted.length} 本です。`);
  console.log("  余った枠は .env.local から削除します（抜け番があっても読めます）。");
}

const assign = new Map();
targets.forEach((slot, idx) => assign.set(slot, pasted[idx] ?? null));

// 書き戻す
const lines = readEnv();
const out = [];
const written = new Set();
for (const line of lines) {
  const m = /^(GEMINI_API_KEY(?:_(\d+))?)\s*=/.exec(line.trim());
  if (!m) {
    out.push(line);
    continue;
  }
  const slot = m[2] ? Number(m[2]) : 1;
  if (!assign.has(slot)) {
    out.push(line); // 残す枠はそのまま
    continue;
  }
  const v = assign.get(slot);
  if (v) out.push(`${slotName(slot)}=${v}`);
  written.add(slot);
}
// もともと行が無かった枠を足す
for (const [slot, v] of assign) {
  if (v && !written.has(slot)) out.push(`${slotName(slot)}=${v}`);
}

fs.copyFileSync(".env.local", ".env.local.bak");
fs.writeFileSync(".env.local", out.join("\n"), "utf8");

console.log("\n.env.local を更新しました（元の内容は .env.local.bak に残してあります）。");
for (const [slot, v] of assign) {
  console.log(`  ${slotName(slot).padEnd(20)} ${v ? "…" + v.slice(-4) : "（空き）"}`);
}
console.log("\n次: node scripts/push-keys-to-vercel.mjs で本番に反映します。");
