/**
 * 検索ログ（2026-11-17 追加）。
 *
 * 「来た人が実際に検索しているか」「何の単語を引いているか」を知るためだけの記録。
 * 誰が引いたかは残さない（uid・メール・IP は保存しない）。残すのは
 * 単語・どこで解決したか・ログインの有無・流入元（utm_source）・日時だけ。
 *
 * Vercel のカスタムイベントは無料プランでは読めず、関数のログも短時間で消えるため、
 * Firestore の `search_log` に1検索1件で書く。今の規模（1日数十件）なら
 * 無料枠（書き込み 2 万件/日）への影響は無視できる。1日の上限を超えたら書かない。
 *
 * Hobby の関数は 12 個で埋まっているので、POST /api/lookup?log=1 に同居させている。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };
import { getServiceAccessToken } from "./googleAuth.js";

const DB_PATH = `projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}`;

const VALID_WORD = /^[a-z][a-z' -]{0,47}$/;
const SOURCES = new Set(["local", "firestore", "ai", "guest-hit", "guest-miss"]);

/** インスタンスあたりの1日の上限。荒らされても無料枠を食い潰さないため。 */
const DAILY_CAP = 3000;
/** 同じ IP からの1時間あたりの上限（IP は数えるだけで保存しない）。 */
const PER_IP_HOURLY = 120;

let day = "";
let dayCount = 0;
const perIp = new Map<string, { n: number; resetAt: number }>();

function jstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function allow(ip: string, now: Date): boolean {
  const d = jstDay(now);
  if (d !== day) {
    day = d;
    dayCount = 0;
  }
  if (dayCount >= DAILY_CAP) return false;
  const t = now.getTime();
  const c = perIp.get(ip);
  if (!c || c.resetAt < t) {
    if (perIp.size > 5000) perIp.clear();
    perIp.set(ip, { n: 1, resetAt: t + 3600_000 });
  } else if (++c.n > PER_IP_HOURLY) {
    return false;
  }
  dayCount++;
  return true;
}

const noContent = () => new Response(null, { status: 204 });

export async function handleSearchLog(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return noContent();
  }
  const word = String(body.word ?? "").trim().toLowerCase();
  const source = String(body.source ?? "");
  const mode = body.mode === "aca" ? "aca" : "gen";
  const guest = body.guest === true;
  const ref = typeof body.ref === "string" ? body.ref.slice(0, 32).replace(/[^a-zA-Z0-9_.-]/g, "") : "";

  // 不正な入力は黙って捨てる（ログのために利用者へエラーを見せない）
  if (!VALID_WORD.test(word) || !SOURCES.has(source)) return noContent();

  const now = new Date();
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "-";
  if (!allow(ip, now)) return noContent();

  try {
    const token = await getServiceAccessToken();
    await fetch(`https://firestore.googleapis.com/v1/${DB_PATH}/documents/search_log`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          word: { stringValue: word },
          source: { stringValue: source },
          mode: { stringValue: mode },
          guest: { booleanValue: guest },
          ref: ref ? { stringValue: ref } : { nullValue: null },
          day: { stringValue: jstDay(now) },
          at: { timestampValue: now.toISOString() },
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.warn("[search_log] 書き込みに失敗:", e);
  }
  return noContent();
}
