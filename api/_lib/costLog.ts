/**
 * 1検索あたりの実費をログに残す。
 *
 * この事業の採算は「キャッシュに当たらなかった検索の原価」と
 * 「キャッシュヒット率」でほぼ決まる。料金プランの上限は現状、
 * 出力3,000トークンという見積もりに基づいた暫定値なので、実測に
 * 置き換えられるよう Vercel のログに構造化して出しておく。
 *
 * Firestore に集計を書くと1検索ごとに書き込みが増えて本末転倒なので、
 * ここでは標準出力に1行出すだけにする（`[cost]` で grep できる）。
 */

/** gemini-3.8-flash の単価（USD / 1M トークン）。2026-12-31 までの導入価格。 */
const PRICE_PER_MTOK = { input: 0.75, output: 3.75 };
/** 円換算のレート。厳密である必要はなく、桁を見誤らないための目安。 */
const USD_JPY = 150;

export interface UsageLike {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export function logLookupCost(word: string, mode: string, usage: UsageLike | undefined): void {
  if (!usage) return;

  const input = usage.promptTokenCount ?? 0;
  // thinking は課金上は出力扱い
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const usd = (input * PRICE_PER_MTOK.input + output * PRICE_PER_MTOK.output) / 1_000_000;

  console.log(
    `[cost] ${JSON.stringify({
      word,
      mode,
      input,
      output,
      thoughts: usage.thoughtsTokenCount ?? 0,
      jpy: Number((usd * USD_JPY).toFixed(3)),
    })}`
  );
}
