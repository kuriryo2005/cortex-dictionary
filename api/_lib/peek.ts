/**
 * GET /api/lookup?w=<単語>&m=gen|aca — ログインせずに収録済みの語を覗く（実験 E2）。
 *
 * Hobby プランは関数が 12 個までで枠が埋まっているため、独立の関数にせず
 * api/lookup.ts の GET として公開している（POST が従来の検索）。
 *
 * 1 語引くにもログインが要ったため、X から来た人は中身を見る前に帰っていた
 * （直帰 60%、登録 0）。登録の前に「この辞書は何を返すのか」を見せる。
 *
 * - **AI は呼ばない。** 共有キャッシュ（dictionary_cache）に既にある語だけを返す。
 *   未収録なら found:false を返し、生成はログイン後に回す。実費はゼロ
 * - 返すのは見出し（意味・分野ごとの用法・ニュアンス・語源の冒頭）だけ。
 *   全項目はログインしてから
 * - 3 語までの制限は画面側（localStorage）。ここでの歯止めは Firestore の枠を守るためのもの
 *
 * **Firestore の無料枠は本番のキャッシュ読みと共有している。** 一度、確認用の大量読み取りで
 * 枠を使い切り、本番の検索を止めた。だから
 *   1. 応答を CDN に長く持たせ、同じ語は Firestore まで来させない
 *   2. インスタンスごとに 1 分あたりの読み取りに上限を付ける
 *   3. Firestore が 429/5xx のときは「無い」ではなく「わからない」（503）を返す
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };
import { getServiceAccessToken } from "./googleAuth.js";
import { jsonResponse, errorResponse } from "./handler.js";


const DB_PATH = `projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}`;
const VALID_WORD = /^[a-z][a-z' -]{1,63}$/;

/** 1 インスタンスが 1 分間に Firestore を読む上限。乱打で共有の枠を食わせない。 */
const READS_PER_MINUTE = 60;
let windowStart = 0;
let readsInWindow = 0;

function takeReadSlot(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    readsInWindow = 0;
  }
  if (readsInWindow >= READS_PER_MINUTE) return false;
  readsInWindow++;
  return true;
}

/** Firestore REST の値を JS の値に戻す（必要な型だけ）。 */
function fromValue(v: Record<string, any> | undefined): unknown {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = fromValue(val as Record<string, any>);
    return out;
  }
  return null;
}

function clip(s: unknown, n: number): string {
  const t = typeof s === "string" ? s.trim() : "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** CDN に持たせる時間。収録済みの語の解説は書き換えられない（ルールで更新禁止）ので長くてよい。 */
const HIT_CACHE = "public, s-maxage=604800, stale-while-revalidate=86400";
/** 未収録は、誰かがログインして引けば収録されるので短めにする。 */
const MISS_CACHE = "public, s-maxage=3600";

export async function peek(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const word = (url.searchParams.get("w") ?? "").trim().toLowerCase();
  const mode = url.searchParams.get("m") === "aca" ? "aca" : "gen";

  if (!VALID_WORD.test(word)) return errorResponse(400, "英単語として認識できない入力です。");

  if (!takeReadSlot()) {
    return errorResponse(429, "混み合っています。少し待ってからもう一度お試しください。");
  }

  try {
    const token = await getServiceAccessToken();
    const read = (m: string) =>
      fetch(`https://firestore.googleapis.com/v1/${DB_PATH}/documents/dictionary_cache/${encodeURIComponent(`${word}__${m}`)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    let res = await read(mode);
    // 事前に収録した語はほとんどが一般モードで、学術モードの項目は少ない。
    // 一般モードの項目にも分野ごとの用法は入っているので、無ければそちらを見せる
    if (res.status === 404 && mode === "aca" && takeReadSlot()) {
      res = await read("gen");
    }

    if (res.status === 404) {
      return jsonResponse({ found: false, word }, 200, { "cache-control": MISS_CACHE });
    }
    if (!res.ok) {
      // 429 や 5xx は「無い」ではなく「わからない」。未収録と言ってしまわない
      console.warn(`[api:peek] firestore ${res.status} for ${word}__${mode}`);
      return errorResponse(503, "いまは表示できません。少し待ってからもう一度お試しください。");
    }

    const doc = (await res.json()) as { fields?: Record<string, Record<string, any>> };
    const f = doc.fields ?? {};
    const contexts = (fromValue(f.specializedContexts) as { field?: string; context?: string }[] | undefined) ?? [];

    return jsonResponse(
      {
        found: true,
        word: String(fromValue(f.word) ?? word),
        meaning: clip(fromValue(f.meaning), 200),
        phonetic: clip(fromValue(f.phonetic), 60),
        specializedContexts: contexts
          .filter((c) => c && c.field && c.context)
          .slice(0, 3)
          .map((c) => ({ field: clip(c.field, 40), context: clip(c.context, 160) })),
        nuance: clip(fromValue(f.nuance), 160),
        etymology: clip(fromValue(f.etymology), 120),
      },
      200,
      { "cache-control": HIT_CACHE }
    );
  } catch (e) {
    console.error("[api:peek] failed", e);
    return errorResponse(503, "いまは表示できません。少し待ってからもう一度お試しください。");
  }
}
