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
 * さらに 2026-09-20、単一モデル（3.8-flash）だけを叩いていたため
 * healthy 0/5 と出たが、実際には他のモデルには枠が残っていた。
 * 無料枠の上限は**モデルごと**に付くので、本番のフォールバック連鎖と
 * 同じ順でモデルを試し、どれか1つでも通ればそのキーは生きているとみなす。
 *
 * maxOutputTokens を 1 にして消費を最小にし、結果は10分キャッシュする。
 * 枠切れ（429）は消費されないので、全滅しているときの試行はタダで済む。
 *
 * 返すのは本数とモデル名だけで、キーそのものや設定値は一切出さない。
 */

import { jsonResponse } from "./_lib/handler.js";
import { MODEL, FALLBACK_MODELS } from "./_lib/gemini.js";

export const config = { runtime: "nodejs" };

/** 生成を伴う確認なので、頻繁には叩かない。 */
const CACHE_MS = 10 * 60 * 1000;
/** 本番の検索とまったく同じ順で試す。 */
const CHAIN = [MODEL, ...FALLBACK_MODELS];
/** GEMINI_API_KEY_2 .. _30 まで探す（api/_lib/gemini.ts と揃える）。 */
const MAX_KEY_INDEX = 30;

interface Probe {
  at: number;
  healthy: number;
  total: number;
  /** いま実際に生成できるモデル名（キーをまたいで1つでも通ったもの）。 */
  models: string[];
}
let cached: Probe | null = null;

function loadKeys(): string[] {
  const keys: string[] = [];
  const primary = process.env.GEMINI_API_KEY?.trim();
  if (primary) keys.push(primary);
  // 抜け番があっても止まらない。以前は最初の空きで break していたため、
  // 番号が飛んでいると後ろのキーを丸ごと見落としていた。
  for (let i = 2; i <= MAX_KEY_INDEX; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`]?.trim();
    if (k) keys.push(k);
  }
  return keys;
}

async function canGenerateWith(key: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(
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
    return res.ok;
  } catch {
    return false;
  }
}

/** このキーで生成できるモデルを1つ探す。見つからなければ null。 */
async function firstUsableModel(key: string): Promise<string | null> {
  for (const model of CHAIN) {
    if (await canGenerateWith(key, model)) return model;
  }
  return null;
}

export async function GET(): Promise<Response> {
  const keys = loadKeys();

  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const results = await Promise.all(keys.map(firstUsableModel));
    const usable = results.filter((m): m is string => m !== null);
    cached = {
      at: Date.now(),
      healthy: usable.length,
      total: keys.length,
      models: [...new Set(usable)],
    };
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
    models: cached.models,
    billingConfigured,
    checkedAt: new Date(cached.at).toISOString(),
  });
}
