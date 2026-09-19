/**
 * POST /api/lookup — 単語検索（実装仕様書 F1）。
 *
 * Server-Sent Events で部分結果を流す。meaning などの軽い項目が先に届くよう
 * スキーマのプロパティ順を組んであるので、クライアントは全体の完成を待たずに
 * 描画できる。
 *
 * data: {"type":"partial","payload":{...}}
 * data: {"type":"done","payload":{...}}
 * data: {"type":"error","message":"..."}
 */

import { withAuth, sseEvent, SSE_HEADERS, errorResponse, classifyAiError } from "./_lib/handler.js";
import {
  withKeyFailover,
  MODEL,
  WORD_SCHEMA,
  FAST_THINKING,
  buildLookupPrompt,
  modeLabel,
  type ModeSlug,
} from "./_lib/gemini.js";
import { parsePartialJson } from "./_lib/partialJson.js";
import { checkAndConsumeLookupQuota } from "./_lib/quota.js";
import { logLookupCost, type UsageLike } from "./_lib/costLog.js";

export const config = { runtime: "nodejs" };

const MAX_WORD_LENGTH = 64;
/** 「a」のような1文字や、入力途中の断片で AI を呼ばないための下限。 */
const MIN_WORD_LENGTH = 2;
/**
 * 英単語・熟語として妥当な形か（文字・アポストロフィ・ハイフン・空白のみ）。
 * 記号や数字だけの意味不明な入力を AI に投げてトークンを無駄にしないためのガード。
 */
const VALID_WORD_PATTERN = /^[a-z][a-z' -]*$/i;

/**
 * 明らかに英単語ではない綴りを、AI に投げる前に弾く。
 *
 * 共有キャッシュに "bbbbbbb" が入っているのを見つけた。文字種のチェックだけ
 * では通ってしまい、生成の実費がかかったうえにキャッシュまで汚れる。
 * 判定は「英単語ならまず起きないこと」だけに絞り、実在する語を誤って
 * 弾かないようにしている（"aa"（溶岩）や "nth" のような語もあるため、
 * 短い語や母音の有無だけでは判断しない）。
 */
function looksLikeGibberish(word: string): boolean {
  const w = word.toLowerCase();

  // 同じ文字が3つ以上続く。英語では "aaa" のような綴りは実質ない
  if (/([a-z]){2,}/.test(w)) return true;

  // 5文字以上で母音（y を含む）が1つも無い
  if (w.length >= 5 && !/[aeiouy]/.test(w)) return true;

  return false;
}
/** 部分結果を送る最小間隔。細かく送りすぎても描画が追いつかない。 */
const PARTIAL_INTERVAL_MS = 200;

/** 編集距離（Levenshtein）。短い入力の暴走した「訂正」を検知するためだけに使う簡易実装。 */
function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * AI が「綴りミス訂正」のつもりで、入力とかけ離れた無関係の単語を返してしまう
 * 暴走を検知する。短い単語ほど別語への飛躍が起きやすいので閾値を厳しくする
 * （例: "map" -> "manipulate" のような訂正を弾く）。
 */
function isSuspiciousCorrection(input: string, corrected: string): boolean {
  const a = input.toLowerCase();
  const b = corrected.toLowerCase();
  if (a === b) return false;
  const distance = levenshtein(a, b);
  const threshold = Math.max(2, Math.ceil(a.length * 0.4));
  return distance > threshold;
}

export async function POST(request: Request): Promise<Response> {
  return withAuth(request, "lookup", async (user, body) => {
    const word = String(body.word ?? "").trim().toLowerCase();
    const mode: ModeSlug = body.mode === "aca" ? "aca" : "gen";

    if (!word) return errorResponse(400, "単語が指定されていません。");
    if (word.length < MIN_WORD_LENGTH) {
      return errorResponse(400, "検索する単語が短すぎます。");
    }
    if (word.length > MAX_WORD_LENGTH) {
      return errorResponse(400, `単語が長すぎます（${MAX_WORD_LENGTH}文字まで）。`);
    }
    if (!VALID_WORD_PATTERN.test(word) || looksLikeGibberish(word)) {
      return errorResponse(400, "英単語として認識できない入力です。");
    }

    // プラン別の検索上限（Free 日10 / Pro 日100）。キャッシュヒットはここに来ないので
    // 実際に AI 呼び出しが発生する検索だけがカウントされる。
    const authHeader = request.headers.get("authorization") ?? "";
    const idToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const quota = await checkAndConsumeLookupQuota(idToken, user.uid);
    if (quota.ok === false) {
      // upgradable のときクライアントはアップグレード導線を出す
      return errorResponse(429, quota.message, { plan: quota.plan, upgradable: quota.upgradable });
    }

    // キーが死んでいたら次のキーで引き直す（api/_lib/gemini.ts の withKeyFailover）
    const stream = await withKeyFailover((ai) =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: buildLookupPrompt(word, mode),
        config: {
          responseMimeType: "application/json",
          responseSchema: WORD_SCHEMA,
          thinkingConfig: FAST_THINKING,
        },
      })
    );

    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buffer = "";
        let lastSentAt = 0;
        let lastSentKeys = 0;
        // 実費の実測用。usageMetadata は最後のチャンクに入る。
        let usage: UsageLike | undefined;

        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(sseEvent(payload)));
        };

        try {
          for await (const chunk of stream) {
            if (chunk.usageMetadata) usage = chunk.usageMetadata as UsageLike;
            const text = chunk.text;
            if (!text) continue;
            buffer += text;

            const now = Date.now();
            if (now - lastSentAt < PARTIAL_INTERVAL_MS) continue;

            const partial = parsePartialJson(buffer);
            if (!partial) continue;

            // 新しいキーが増えていないなら送らない（同じ内容の再送を避ける）
            const keyCount = Object.keys(partial).length;
            if (keyCount <= lastSentKeys) continue;

            lastSentKeys = keyCount;
            lastSentAt = now;
            // word は partial/final（AI の応答）のものをそのまま使う。ここで
            // 入力の生の word を後から展開すると、綴りミスを AI が直しても
            // 送信直前に元の綴りへ上書きされてしまう。
            send({ type: "partial", payload: { ...partial, mode: modeLabel(mode) } });
          }

          logLookupCost(word, mode, usage);

          let final = JSON.parse(buffer) as Record<string, unknown>;

          // 「訂正」が暴走して無関係の単語に飛んでいないか確認し、怪しければ
          // 綴りを固定した厳格プロンプトで1回だけ引き直す（ストリーミングはしない）。
          if (
            typeof final.word === "string" &&
            isSuspiciousCorrection(word, final.word)
          ) {
            console.warn(`[api:lookup] suspicious correction "${word}" -> "${final.word}", retrying strict`);
            try {
              const retryRes = await withKeyFailover((ai) =>
                ai.models.generateContent({
                  model: MODEL,
                  contents: buildLookupPrompt(word, mode, { forceExactSpelling: true }),
                  config: {
                    responseMimeType: "application/json",
                    responseSchema: WORD_SCHEMA,
                    thinkingConfig: FAST_THINKING,
                  },
                })
              );
              const retryText = retryRes.text;
              if (retryText) final = JSON.parse(retryText) as Record<string, unknown>;
            } catch (retryError) {
              console.error("[api:lookup] strict retry failed", retryError);
              // 引き直しに失敗しても、最初の（疑わしい）結果をそのまま返して検索は継続する
            }
          }

          send({ type: "done", payload: { ...final, mode: modeLabel(mode) } });
        } catch (e) {
          console.error("[api:lookup] stream error", e);
          // 原因によって利用者が取れる行動が違うので、同じ判定を通す
          const failure = classifyAiError(e);
          send({ type: "error", message: failure.message, reason: failure.reason });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, { headers: SSE_HEADERS });
  });
}
