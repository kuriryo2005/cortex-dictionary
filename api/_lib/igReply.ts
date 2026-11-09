/**
 * Instagram のコメントに DM で自動返信する（2026-11-02 本人依頼）。
 *
 *   /api/ig-webhook → /api/billing-webhook?src=ig（vercel.json の rewrites。Hobby の関数 12 個の枠が埋まっているため同居）
 *
 * 自分の投稿に「辞書」か英単語だけのコメントが付いたら、その人に DM（Private Reply）を 1 通送る。
 *   - 「辞書」を含む     … アプリのトップ
 *   - 英単語・熟語だけ   … 収録済みなら単語ページ /w/<語>、未収録ならアプリでその語を引く ?w=<語>
 *   - それ以外           … 何もしない（普通の感想に DM を送りつけない）
 *
 * Meta の決まりで Private Reply はコメント 1 件につき 1 回・7 日以内。それに加えて、乱用と誤爆を防ぐため
 * 1 人 1 日 3 通・全体で 1 日 30 通までにする。数えるのはインスタンスのメモリなので目安（本番 DB には書かない）。
 *
 * 送り方は Meta の「非公開返信」: POST graph.facebook.com/<PAGE_ID>/messages（recipient に comment_id）。
 * 新しいアプリは Instagram ログインの API が使えず、Facebook ログイン（統合ログイン）になる（2026-11-02 設定画面で確認）。
 * 必要な権限は instagram_manage_comments と pages_messaging。一般の人のコメントに返すにはアプリレビュー（アドバンスアクセス）が要る。
 *
 * 必要な環境変数（Vercel）: IG_APP_SECRET（アプリシークレット・署名検証）/ IG_VERIFY_TOKEN（Webhook 登録時の照合）/
 * IG_PAGE_ID（cortex_dictionary につながる Facebook ページ）/ IG_ACCESS_TOKEN（そのページのアクセストークン）/
 * IG_GRAPH_VERSION（省略時 v24.0）
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import wordIndex from "./wordIndex.json" with { type: "json" };

const SITE = "https://lexi-log-puce.vercel.app";
const INDEXED = new Set<string>(wordIndex as string[]);
const WORD = /^[a-z][a-z' -]{1,40}$/;
/** 感想・あいさつとしてよく書かれる語。これを含むコメントは「単語を知りたい」ではないので返さない。 */
const CHAT = new Set(
  "i me my you your we it this that is am are was so very too love like nice good great cool wow thanks thank please lol omg yes no ok hi hello amazing awesome cute haha".split(" ")
);
const PER_USER_PER_DAY = 3;
const TOTAL_PER_DAY = 30;

const sent = { day: "", total: 0, byUser: new Map<string, number>() };

function today(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // 日本時間の日付
}

/** 上限内なら数えて true。日が変わったら数え直す。 */
function take(userId: string): boolean {
  const d = today();
  if (sent.day !== d) Object.assign(sent, { day: d, total: 0, byUser: new Map() });
  const n = sent.byUser.get(userId) ?? 0;
  if (sent.total >= TOTAL_PER_DAY || n >= PER_USER_PER_DAY) return false;
  sent.total++;
  sent.byUser.set(userId, n + 1);
  return true;
}

const utm = "utm_source=instagram&utm_medium=comment_dm";

/** コメントから返す文を決める。返さないときは null。 */
export function replyFor(raw: string): string | null {
  const text = raw
    .normalize("NFKC")
    .replace(/@[\w.]+/g, "")
    .replace(/[\p{Extended_Pictographic}‍️]/gu, "")
    .trim();
  if (!text) return null;

  if (text.includes("辞書")) {
    return `コメントありがとうございます🦌\nCortex Dictionary はこちらです。ログインなしで、論文の英単語を分野ごとの意味で引けます。\n${SITE}/?${utm}`;
  }

  const w = text.replace(/^["'「『]+|[.!?。！？"'」』]+$/g, "").trim().toLowerCase();
  if (!WORD.test(w) || /([a-z])\1\1/.test(w)) return null;
  const parts = w.split(/\s+/);
  if (parts.length > 3 || parts.some((p) => CHAT.has(p))) return null;
  const url = INDEXED.has(w)
    ? `${SITE}/w/${encodeURIComponent(w)}?${utm}`
    : `${SITE}/?w=${encodeURIComponent(w)}&${utm}`;
  return `コメントありがとうございます🦌\n「${w}」の分野ごとの意味はこちらです。\n${url}\nほかの単語もログインなしで引けます。`;
}

function validSignature(body: string, header: string | null): boolean {
  const secret = process.env.IG_APP_SECRET?.trim();
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const got = Buffer.from(header.slice(7));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

async function privateReply(commentId: string, text: string): Promise<void> {
  const v = process.env.IG_GRAPH_VERSION || "v24.0";
  const res = await fetch(`https://graph.facebook.com/${v}/${process.env.IG_PAGE_ID?.trim()}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.IG_ACCESS_TOKEN?.trim()}` },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
  if (!res.ok) console.error("[ig] 返信に失敗:", res.status, await res.text());
}

/** Webhook 登録時の照合（Meta が GET で hub.challenge を送ってくる）。 */
export function igVerify(request: Request): Response {
  const q = new URL(request.url).searchParams;
  const token = process.env.IG_VERIFY_TOKEN?.trim(); // PowerShell から登録すると末尾に改行が付く
  const ok = q.get("hub.mode") === "subscribe" && !!token && q.get("hub.verify_token") === token;
  return ok ? new Response(q.get("hub.challenge") ?? "", { status: 200 }) : new Response("forbidden", { status: 403 });
}

export async function igWebhook(request: Request): Promise<Response> {
  const body = await request.text();
  if (!validSignature(body, request.headers.get("x-hub-signature-256"))) {
    console.warn("[ig] 受信: 署名不一致");
    return new Response("bad signature", { status: 401 });
  }

  let payload: { entry?: { id?: string; changes?: { field?: string; value?: Record<string, any> }[] }[] };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  console.log("[ig] 受信:", (payload.entry ?? []).flatMap((e) => (e.changes ?? []).map((c) => c.field)).join(",") || "変更なし");
  for (const entry of payload.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      const v = ch.value;
      if (ch.field !== "comments" || !v?.id || !v.from?.id) continue;
      if (v.from.id === entry.id) continue; // 自分のコメント（返信など）には反応しない
      const text = replyFor(String(v.text ?? ""));
      // 診断用（ユーザー名・本文は出さない）
      console.log("[ig] 受信: comments", text ? "対象語あり" : "対象外");
      if (!text || !take(v.from.id)) continue;
      // 失敗しても 200 を返す（Meta の再送で二重に送らないため）
      await privateReply(v.id, text).catch((e) => console.error("[ig] 返信に失敗:", e));
    }
  }
  return new Response("ok", { status: 200 });
}
