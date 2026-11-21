/**
 * GET /api/health — 本番が今使える状態かを、ログインせずに確認する。
 *
 * 障害のたびに「ローカルの鍵は枯れているが本番はどうなのか」が分からず
 * 判断できなかった。Vercel の環境変数はローカルの .env.local とは別物
 * なので、外から見える形で持っておく。
 *
 * 各キーの生死は、本番の検索が残した記録から読む（2026-11-21 から自分では生成しない。下の説明）。
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
import { groqKeyCount, isGroqConfigured } from "./_lib/groq.js";
import { getServiceAccessToken } from "./_lib/googleAuth.js";
import {
  observedWorkingModels,
  hasObservations,
  healthyKeyCount,
} from "./_lib/gemini.js";

export const config = { runtime: "nodejs" };

/**
 * 2026-11-21: probe（自分で生成して確かめる）を廃止した。
 * トップページを開くたびにこの API が呼ばれ、記録の無いインスタンス（Vercel は
 * アクセスが増えると新しく立てる）では毎回 12 キー×モデル連鎖で実生成していた。
 * 海外の bot（headless Chrome 等）がトップを開くだけで無料枠が尽き、
 * 11/19〜21 は昼までに keys 0/12・生成不可になっていた。監視の curl も同じだった。
 * いまは本番の検索が残した記録（gemini.ts の台帳）を読むだけ。記録が無いときは
 * 「不明」（canGenerate: null）を返し、生成は一切しない。
 */
/** GEMINI_API_KEY_2 .. _30 まで探す（api/_lib/gemini.ts と揃える）。 */
const MAX_KEY_INDEX = 30;

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

/** 返らない Promise に応答全体を引きずられないための保険。 */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} が ${ms}ms 以内に終わりませんでした`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export async function GET(): Promise<Response> {
  const keys = loadKeys();

  // 本番の検索が残した記録だけを読む（枠を消費しない）。記録が無ければ不明。
  const known = hasObservations();
  const observed = known ? observedWorkingModels() : [];
  const healthy = known ? (observed.length > 0 ? healthyKeyCount() : 0) : null;
  const source: "traffic" | "unknown" = known ? "traffic" : "unknown";

  // 課金の設定。署名シークレットは「空文字が入っている」ことが実際にあったので、
  // 存在ではなく形まで見る（whsec_ で始まる十分な長さ）。
  const whsec = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  const billingConfigured = Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_PRICE_MONTHLY &&
      whsec.startsWith("whsec_") &&
      whsec.length > 20
  );

  // 単語の保存はサービスアカウント経由（api/save-words.ts）なので、
  // これが動かないと誰も単語を保存できないし、契約も反映されない。
  //
  // 以前はここで「環境変数があるか」だけを見ていた。しかし本番では
  // 変数はあるのに中身が壊れた JSON で、JSON.parse が落ちて保存も課金も
  // 失敗していた。**それでも canSaveWords は true を返していた。**
  // 有無ではなく、実際にトークンを取れるところまで確かめる。
  let canSaveWords = false;
  let saveWordsError: string | undefined;
  try {
    canSaveWords = Boolean(await withDeadline(getServiceAccessToken(), 5_000, "アクセストークンの取得"));
  } catch (e) {
    saveWordsError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  }

  return jsonResponse({
    // 収録済みの単語の検索と復習はキーが無くても動くので、ここが false でも
    // アプリ全体が止まっているわけではない（新しい単語の生成だけが止まる）。
    // null … このインスタンスではまだ検索が無く分からない（画面では「問題なし」扱い）
    canGenerate: healthy === null ? null : healthy > 0,
    canSaveWords,
    // 保存が動かないとき、何が悪いのかをここで言い切る
    ...(saveWordsError ? { saveWordsError } : {}),
    keys: { healthy, total: keys.length },
    models: observed,
    /**
     * Groq（生成の主力）の設定状況。
     *
     * 本番で「groq のログが 1 行も出ない」ときに、原因が
     * 「環境変数が届いていない」のか「コードが古い」のかを切り分けられない。
     * 鍵の**本数だけ**を出す（値は絶対に出さない）。
     * ここが 0 なら環境変数が未設定か未反映。
     * この項目自体が応答に無いなら、デプロイされているコードが古い。
     */
    groq: { configured: isGroqConfigured(), keys: groqKeyCount() },
    // traffic … 実際の検索の結果（枠を消費しない）
    // unknown … このインスタンスではまだ検索が無い（生成して確かめることはしない）
    source,
    billingConfigured,
    checkedAt: new Date().toISOString(),
  });
}
