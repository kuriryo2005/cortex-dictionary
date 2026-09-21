/**
 * POST /api/save-words — 単語を保存する唯一の経路。
 *
 * 無料プランの「保存は30語まで」を本当に守らせるために作った。Firestore の
 * セキュリティルールにはコレクションの件数を数える機能が無いので、
 * クライアントから直接 addDoc できる状態では制限が成立しない
 * （`firestore.rules` 側で `words` の create を禁止してある）。
 *
 * 削除すれば枠は戻る。上限は「今いくつ保存しているか」で判定していて、
 * 過去に何語保存したかは見ない。間違えて保存した語を消して入れ替えられる。
 *
 * body:
 *   { words: [ {...}, ... ], source?: "search" | "extract" | "restore" }
 *
 * `restore`（バックアップからの復元）は Pro 限定。無料プランで数百語の
 * JSON を復元されると上限が意味をなくすため。書き出しは無料のまま
 * （プライバシーポリシーで「データはいつでも持ち出せる」と約束している）。
 */

import { withAuth, jsonResponse, errorResponse } from "./_lib/handler.js";
import { PLAN_WORD_LIMIT, resolvePlan } from "./_lib/plan.js";
import { countSavedWords, createWords } from "./_lib/wordStore.js";

export const config = { runtime: "nodejs" };

/** 1回のリクエストで受け付ける上限。一括抽出の最大件数に合わせてある。 */
const MAX_PER_REQUEST = 100;

/** 保存される単語として最低限の形になっているか。 */
function isValidWord(w: unknown): w is Record<string, unknown> {
  if (!w || typeof w !== "object") return false;
  const o = w as Record<string, unknown>;
  return (
    typeof o.word === "string" &&
    o.word.trim().length > 0 &&
    o.word.length <= 64 &&
    typeof o.meaning === "string" &&
    o.meaning.trim().length > 0
  );
}

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "review", async (user, body) => {
    const incoming = Array.isArray(body.words) ? body.words : [];
    const source = typeof body.source === "string" ? body.source : "search";

    if (incoming.length === 0) return errorResponse(400, "保存する単語がありません。");
    if (incoming.length > MAX_PER_REQUEST) {
      return errorResponse(400, `一度に保存できるのは ${MAX_PER_REQUEST} 語までです。`);
    }
    if (!incoming.every(isValidWord)) {
      return errorResponse(400, "単語の形式が正しくありません。");
    }

    const idToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const { plan, unlimited } = await resolvePlan(idToken, user.uid, user);
    // 運営者は保存数も無制限（PLAN_WORD_LIMIT を見ない）
    const limit = unlimited ? null : PLAN_WORD_LIMIT[plan];

    if (source === "restore" && plan !== "pro") {
      return errorResponse(403, "バックアップからの復元は Pro プランの機能です。", {
        plan,
        upgradable: true,
      });
    }

    // limit が null（Pro）なら数える必要もない
    if (limit !== null) {
      let current: number;
      try {
        current = await countSavedWords(user.uid);
      } catch (e) {
        // 数えられないときは保存を通す。制限機構の不調でサービスを止めない
        console.warn("[save-words] 保存語数を数えられませんでした:", e);
        current = 0;
      }

      const remaining = Math.max(0, limit - current);
      if (remaining === 0) {
        return errorResponse(
          403,
          `無料プランで保存できるのは ${limit} 語までです。いらない単語を削除すると枠が空きます。Pro にすると無制限に保存できます。`,
          { plan, upgradable: true, saved: current, limit }
        );
      }
      if (incoming.length > remaining) {
        return errorResponse(
          403,
          `あと ${remaining} 語しか保存できません（無料プランは ${limit} 語まで）。Pro にすると無制限に保存できます。`,
          { plan, upgradable: true, saved: current, limit, remaining }
        );
      }
    }

    const now = Date.now();
    const docs = incoming.map((w) => ({
      ...(w as Record<string, unknown>),
      // 時刻はサーバーで打つ。クライアントの時計を信用しない
      timestamp: typeof (w as Record<string, unknown>).timestamp === "number"
        ? (w as Record<string, unknown>).timestamp
        : now,
      updatedAt: now,
    }));

    const written = await createWords(user.uid, docs);

    const saved = limit === null ? null : await countSavedWords(user.uid).catch(() => null);
    return jsonResponse({ written, plan, limit, saved });
  });
}
