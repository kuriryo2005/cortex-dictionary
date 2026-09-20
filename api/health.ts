/**
 * GET /api/health — 本番が今使える状態かを、ログインせずに確認する。
 *
 * 障害のたびに「ローカルの鍵は枯れているが本番はどうなのか」が分からず
 * 判断できなかった。Vercel の環境変数はローカルの .env.local とは別物
 * なので、外から見える形で持っておく。
 *
 * 各キーの生死は、実際に1トークンだけ生成させて確かめる。
 *
 * 以前はモデル一覧の取得（/v1beta/models）で判定していたが、**これは枠を
 * 使い切ったキーでも成功する**。その結果 healthy 5/5 と報告しながら実際の
 * 検索は「利用枠の上限」で失敗する、という嘘をついていた。生成できるかを
 * 知りたいのだから、生成して確かめるしかない。
 *
 * maxOutputTokens を 1 にして消費を最小にし、結果は10分キャッシュする
 * （キー1本あたり1日144回程度で、無料枠から見ても無視できる）。
 *
 * 返すのは本数と設定の有無だけで、キーそのものや設定値は一切出さない。
 * 本数が漏れて困ることはなく、止まっているのに気付けないほうが損失が大きい。
 */

import { jsonResponse } from "./_lib/handler.js";

export const config = { runtime: "nodejs" };

/** 生成を伴う確認なので、頻繁には叩かない。 */
const CACHE_MS = 10 * 60 * 1000;
/** 本番の検索と同じモデルで確かめないと意味がない。 */
const PROBE_MODEL = "gemini-3.8-flash";
let cached: { at: number; healthy: number; total: number } | null = null;

function loadKeys(): string[] {
  const keys: string[] = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let i = 2; ; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (!k) break;
    keys.push(k);
  }
  return keys;
}

/** 実際に生成できるかを確かめる。枠切れ（402/429）はここで false になる。 */
async function isUsable(key: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${PROBE_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  const keys = loadKeys();

  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const results = await Promise.all(keys.map(isUsable));
    cached = { at: Date.now(), healthy: results.filter(Boolean).length, total: keys.length };
  }

  const billingConfigured = Boolean(
    process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY && process.env.STRIPE_WEBHOOK_SECRET
  );

  // 単語の保存はサービスアカウント経由（api/save-words.ts）なので、
  // これが無いと誰も単語を保存できない。設定漏れに気付けるよう外に出す。
  const canSaveWords = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);

  return jsonResponse({
    // 収録済みの単語の検索と復習はキーが無くても動くので、ここが false でも
    // アプリ全体が止まっているわけではない（新しい単語の生成だけが止まる）。
    canGenerate: cached.healthy > 0,
    canSaveWords,
    keys: { healthy: cached.healthy, total: cached.total },
    billingConfigured,
    checkedAt: new Date(cached.at).toISOString(),
  });
}
