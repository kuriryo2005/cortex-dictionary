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
  withModelFallback,
  firstTokenDeadline,
  MODEL,
  WORD_SCHEMA,
  FAST_THINKING,
  buildLookupPrompt,
  modeLabel,
  type ModeSlug,
  sanitizeEtymology,
} from "./_lib/gemini.js";
import type { GoogleGenAI } from "@google/genai";
import {
  GROQ_LOOKUP_MODELS,
  groqLookup,
  isGroqConfigured,
  isGroqRecoverable,
} from "./_lib/groq.js";
import { parsePartialJson } from "./_lib/partialJson.js";
import { checkAndConsumeLookupQuota } from "./_lib/quota.js";
import { logLookupCost, type UsageLike } from "./_lib/costLog.js";
import { peek } from "./_lib/peek.js";
import { renderWordPage } from "./_lib/wordPage.js";

/**
 * 混雑時は同じモデルで待って粘り、駄目なら別モデルへ降りる（合計 20 秒まで）。
 * 実行時間の上限を明示しておかないと、粘っている途中でプラットフォーム側に
 * 打ち切られて、こちらの丁寧なエラーではなく素の 504 が利用者に出る。
 * 30 秒はどのプランでも許される範囲。
 */
export const config = { runtime: "nodejs", maxDuration: 30 };

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

/**
 * GET は 2 つの公開用途に使う（Hobby の関数 12 個の枠が埋まっているため同居させている）。
 *   ?page=word|index … 単語ごとの公開ページ（/w/<単語> の rewrite 先）。api/_lib/wordPage.ts
 *   それ以外         … ログインなしの試し引き（収録済みの語だけ・AI は呼ばない）。api/_lib/peek.ts
 */
export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).searchParams.has("page")) return renderWordPage(request);
  return peek(request);
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
    const quota = await checkAndConsumeLookupQuota(idToken, user.uid, user);
    if (quota.ok === false) {
      // upgradable のときクライアントはアップグレード導線を出す
      return errorResponse(429, quota.message, { plan: quota.plan, upgradable: quota.upgradable });
    }

    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        // 実費の実測用。usageMetadata は最後のチャンクに入る。
        let usage: UsageLike | undefined;

        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(sseEvent(payload)));
        };

        /**
         * 1 モデル・1 キーで最後まで読み切る。返すのは受け取った JSON 文字列。
         *
         * **ここが失敗の主犯だった。**
         * 以前は generateContentStream の「呼び出し」だけを withModelFallback /
         * withKeyFailover で包み、**読み出しのループは包みの外**にあった。
         * Gemini の 503 は接続直後だけでなく本文を流している最中にも飛んでくる。
         * その場合どのキーにもどのモデルにも切り替わらないまま
         * 「AI が混み合っています」がそのまま利用者へ出ていた。
         * 12 本のキーと 9 個のモデルを用意してあっても、検索の本流である
         * この経路だけが素通しになっていた。
         *
         * 生成と読み出しをひとつの単位にして、まとめて包み直す。
         *
         * @param quiet 再試行のときは true。途中経過を送り直さない
         *   （一度出した内容が、作り直しの途中で一瞬減って見えるのを避ける）。
         */
        const readOnce = async (model: string, ai: GoogleGenAI, quiet: boolean) => {
          // 返事を始めるまでの期限。始まったら解除して、あとはいくらでも待つ。
          // 詰まったモデルをここで見切らないと、容量の大きい Lite へ降りる前に
          // 全体の締め切りを使い切ってしまう。
          const opening = firstTokenDeadline(model);

          const stream = await opening.race(
            ai.models.generateContentStream({
              model,
              contents: buildLookupPrompt(word, mode),
              config: {
                responseMimeType: "application/json",
                responseSchema: WORD_SCHEMA,
                thinkingConfig: FAST_THINKING,
              },
            })
          );

          let buffer = "";

          // 1 個目のチャンクだけ期限付きで待つ
          const iterator = stream[Symbol.asyncIterator]();
          let step = await opening.race(iterator.next());
          opening.disarm();

          for (; !step.done; step = await iterator.next()) {
            const chunk = step.value;
            if (chunk.usageMetadata) usage = chunk.usageMetadata as UsageLike;
            const text = chunk.text;
            if (!text) continue;
            buffer += text;

            if (quiet) continue;

            // 間引きと「増えていなければ送らない」の判断は emitPartial に一本化した。
            // ここで別に数えると、見出し（Groq）と本体（Gemini）で二重管理になる。
            // word は partial/final（AI の応答）のものをそのまま使う。ここで
            // 入力の生の word を後から展開すると、綴りミスを AI が直しても
            // 送信直前に元の綴りへ上書きされてしまう。
            emitFromText(buffer);
          }

          // 空の応答も、途中で切れて JSON として読めない応答も、ここで
          // 失敗にしておく。包みの外で JSON.parse すると、壊れた本文が
          // 再試行されずにそのまま「AI の応答を解釈できませんでした」になる。
          if (!buffer.trim()) throw new Error("503 empty stream (model returned nothing)");
          try {
            return JSON.parse(buffer) as Record<string, unknown>;
          } catch {
            throw new Error("503 truncated stream (response was not valid JSON)");
          }
        };

        /**
         * 途中経過の送信状況。**リクエスト全体で 1 つ**にする。
         *
         * 見出し（Groq）と本体（Gemini）を同時に走らせているので、
         * 別々に数えると「本体の途中経過が先に届いたあと、項目数の少ない
         * 見出しが上書きして画面の内容が減る」ことが起きる。
         * 送った項目数を 1 か所で覚えておき、それより少ないものは送らない。
         */
        const sent = { keys: 0, at: 0 };

        /** 途中経過を送る。増えていないものは送らない。 */
        const emitPartial = (payload: Record<string, unknown>, throttle: boolean) => {
          const now = Date.now();
          if (throttle && sent.at !== 0 && now - sent.at < PARTIAL_INTERVAL_MS) return;
          const keyCount = Object.keys(payload).length;
          if (keyCount <= sent.keys) return;
          sent.keys = keyCount;
          sent.at = now;
          send({ type: "partial", payload: { ...payload, mode: modeLabel(mode) } });
        };

        /** ストリームの途中の文字列から送る（本体用）。 */
        const emitFromText = (accumulated: string) => {
          const partial = parsePartialJson(accumulated);
          if (partial) emitPartial(partial, true);
        };

        /**
         * 本体の生成（Groq が主力）。
         *
         * 一度は「語源で Gemini が勝つ」と判断して Gemini を先に置いたが、
         * **比較の条件が不公平だった。** Gemini には専用に書き込んだ指示を、
         * Groq には薄い一行指示を与えていた。同じ強さの指示を与えて測り直すと
         * 結果が逆転した。
         *
         *   語源 7 語: Groq は 7/7 で印欧祖語まで到達（Gemini はラテン語止まりが多い）
         *   使い分け:  Groq は類義語を実名で対比、Gemini は一般論 1 文
         *   速度:      Groq 0.8〜3.9 秒、Gemini 7〜17 秒
         *
         * 加えて Gemini は無料枠が Flash で 1 鍵 20 回/日しかなく、503 も頻発する。
         * 実際に「Gemini が 1 件も返せない時間帯」が今日あった。
         */
        const handlerStartedAt = Date.now();
        /** 全体の持ち時間。maxDuration(30秒) に刈られる前に自分で畳む。 */
        const OVERALL_BUDGET_MS = 27_000;

        const tryGroq = async (): Promise<Record<string, unknown> | null> => {
          if (!isGroqConfigured()) return null;

          for (const model of GROQ_LOOKUP_MODELS) {
            const left = OVERALL_BUDGET_MS - (Date.now() - handlerStartedAt);
            if (left < 4_000) {
              console.warn("[api:lookup] 残り時間が足りないので groq は試しません");
              return null;
            }

            try {
              const r = await groqLookup(model, word, mode, emitFromText, left);
              console.log(`[api:lookup] groq ${r.model} が ${r.elapsedMs}ms で応答（Gemini の代役）`);
              return r.detail;
            } catch (e) {
              const detail = e instanceof Error ? e.message : String(e);
              if (!isGroqRecoverable(e)) {
                console.warn(`[api:lookup] groq ${model} を諦めます: ${detail.slice(0, 160)}`);
                return null;
              }
              console.warn(`[api:lookup] groq ${model} も詰まっています: ${detail.slice(0, 120)}`);
            }
          }
          return null;
        };

        /**
         * 生成は **1 回の呼び出しで完結させる**。
         *
         * 一時は「見出し（意味・使い分け）だけ先に別の呼び出しで作って
         * 1 秒で画面に出す」構成にしていた。体感は良かったが、
         * **1 検索につき Groq を 2 回消費する**ため、1 日に引ける数が半分
         * （4,000 → 2,000）になる。容量のほうが大事なので 1 回に戻した。
         *
         * 見出しを別プロンプトにしていた本当の理由は速さではなく、
         * 使い分けの指示を厚く書けることだった。その指示は本体プロンプト
         * （buildLookupPrompt の nuance）に取り込んであるので、
         * 1 回でも中身は落ちない。
         */
        try {
          let attempted = false;

          // 主力は Groq。詰まっていれば即座に 429 が返るので、
          // 失敗しても 0.1 秒程度しか損しない。
          let final: Record<string, unknown> | null = await tryGroq();

          if (!final) {
            // Groq が全滅した。容量の大きい Gemini に回す。
            // Gemini は遅いが 1 日 13,200 回あり、Groq（4,000 回）より太い。
            console.warn("[api:lookup] groq が全滅したので gemini に回します");
            final = await withModelFallback(
              (model) =>
                withKeyFailover((ai) => {
                  const quiet = attempted;
                  attempted = true;
                  return readOnce(model, ai, quiet);
                }, model),
              // Groq に使った分を引いた残りだけ渡す
              OVERALL_BUDGET_MS - (Date.now() - handlerStartedAt)
            );
          }

          logLookupCost(word, mode, usage);

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
                }), MODEL
              );
              const retryText = retryRes.text;
              if (retryText) final = JSON.parse(retryText) as Record<string, unknown>;
            } catch (retryError) {
              console.error("[api:lookup] strict retry failed", retryError);
              // 引き直しに失敗しても、最初の（疑わしい）結果をそのまま返して検索は継続する
            }
          }

          if (final && typeof final.etymology === "string") {
            final.etymology = sanitizeEtymology(word, final.etymology);
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
