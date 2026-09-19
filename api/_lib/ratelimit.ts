/**
 * uid 単位の簡易レート制限（実装仕様書 F1）。
 *
 * サーバーレス関数のインスタンス内メモリで数えるため、インスタンスが増えると
 * 実効上限は緩くなる。厳密な制限には外部ストア（Vercel KV 等）が必要だが、
 * ログイン必須化によって「Google アカウントが必要」という壁が既にあるので、
 * 個人利用の想定ではこれで足りる。必要になったら差し替える。
 */

export interface RateLimitRule {
  /** 時間窓の長さ（ミリ秒） */
  windowMs: number;
  /** 時間窓あたりの上限回数 */
  max: number;
}

export const RATE_LIMITS = {
  lookup: { windowMs: 60 * 60 * 1000, max: 100 },
  story: { windowMs: 60 * 60 * 1000, max: 30 },
  review: { windowMs: 60 * 60 * 1000, max: 200 },
  extract: { windowMs: 60 * 60 * 1000, max: 10 },
  // 既存単語の発音記号の遅延補完（F4）。1単語1回きりの軽い呼び出しなので緩め。
  phonetic: { windowMs: 60 * 60 * 1000, max: 300 },
  // 課金導線（Checkout / Portal / 契約状態の取得）。連打されても困るので控えめ。
  billing: { windowMs: 60 * 60 * 1000, max: 60 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();

/** 古いエントリを掃除する（メモリが際限なく増えないように） */
function sweep(now: number) {
  if (counters.size < 5000) return;
  for (const [key, c] of counters) {
    if (c.resetAt <= now) counters.delete(key);
  }
}

export class RateLimitError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("レート制限を超えました。");
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * 回数を1つ消費する。上限を超えていれば RateLimitError を投げる。
 */
export function consume(name: RateLimitName, uid: string): void {
  const rule = RATE_LIMITS[name];
  const now = Date.now();
  sweep(now);

  const key = `${name}:${uid}`;
  const current = counters.get(key);

  if (!current || current.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + rule.windowMs });
    return;
  }

  if (current.count >= rule.max) {
    throw new RateLimitError(Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
  }

  current.count += 1;
}
