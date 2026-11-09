/**
 * 活用形・複数形のキーに、見出し語の項目をそのまま複製する。
 *
 *   npx tsx scripts/pretrain-alias.mts plans=plan views=view took=take
 *   npx tsx scripts/pretrain-alias.mts --file=scripts/_aliases.txt
 *
 * なぜ要るのか:
 *   キャッシュの鍵は「利用者が打った綴りそのもの」。本番の検索は打たれた語を
 *   原形に直してから引くので、"plans" を引くと中身は "plan" の項目になる。
 *   ところが鍵は plans__gen なので、plan__gen が埋まっていても当たらない。
 *   頻度順リストの上位には活用形が大量に並ぶため、ここを埋めないと
 *   ヒット率が頭打ちになる。
 *
 * 中身は既存の項目の丸写しで、生成は一切走らない（原価ゼロ・追加の判断なし）。
 * 元が無い場合は何もしない。
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { getServiceAccessToken } from "../api/_lib/googleAuth.js";

const PROJECT = "gen-lang-client-0163841095";
const DB = "ai-studio-f55ff9db-e50f-4a01-bdbe-7636a1265750";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}/documents/dictionary_cache`;

const MODE = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=gen").slice(7);
const fileArg = process.argv.find((a) => a.startsWith("--file="));

const pairs: [string, string][] = [];
const add = (s: string) => {
  const [alias, base] = s.split("=");
  if (alias && base) pairs.push([alias.trim().toLowerCase(), base.trim().toLowerCase()]);
};
for (const a of process.argv.slice(2)) if (!a.startsWith("--")) add(a);
if (fileArg) {
  for (const line of readFileSync(fileArg.slice(7), "utf-8").split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) add(t);
  }
}
if (pairs.length === 0) {
  console.error("使い方: npx tsx scripts/pretrain-alias.mts <活用形>=<見出し語> ...");
  process.exit(1);
}

const token = await getServiceAccessToken();
const auth = { Authorization: `Bearer ${token}` };

let copied = 0, skipped = 0, missing = 0;
for (const [alias, base] of pairs) {
  if (alias === base) { skipped++; continue; }
  const aliasUrl = `${BASE}/${encodeURIComponent(`${alias}__${MODE}`)}`;
  const baseUrl = `${BASE}/${encodeURIComponent(`${base}__${MODE}`)}`;

  // 別名側の存在確認はしない（読み取りの日次枠は本番と共有）。作成時の前提条件で弾く。
  const src = await fetch(baseUrl, { headers: auth });
  if (src.status !== 200 && src.status !== 404) {
    console.error(`Firestore ${src.status}: 中断`);
    break;
  }
  if (src.status !== 200) {
    console.error(`元が無い: ${base}__${MODE}`);
    missing++;
    continue;
  }
  const doc = (await src.json()) as { fields?: Record<string, unknown> };
  if (!doc.fields) { missing++; continue; }

  const put = await fetch(`${aliasUrl}?currentDocument.exists=false`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: doc.fields }),
  });
  if (put.status === 400 || put.status === 409) { skipped++; continue; }
  if (!put.ok) {
    console.error(`書込失敗 ${alias}: ${(await put.text()).slice(0, 120)}`);
    missing++;
    continue;
  }
  copied++;
}
console.log(`複製 ${copied} / 既存・同一 ${skipped} / 元なし ${missing}`);
