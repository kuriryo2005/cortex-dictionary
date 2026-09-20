/**
 * Stripe の薄いクライアント。
 *
 * 公式 SDK は Node 専用で重いため、必要な3つ（Checkout Session 作成 /
 * Customer Portal Session 作成 / Subscription 取得）だけを REST で叩く。
 * Webhook の署名検証も Web Crypto で自前実装する。
 */

const API = "https://api.stripe.com/v1";

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY が設定されていません。");
  return key;
}

/** Stripe はネストしたパラメータを `a[b][c]=v` の形で受け取る。 */
function flatten(obj: Record<string, unknown>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          out.push(...flatten(item as Record<string, unknown>, `${key}[${i}]`));
        } else {
          out.push([`${key}[${i}]`, String(item)]);
        }
      });
    } else {
      out.push([key, String(v)]);
    }
  }
  return out;
}

async function call<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey()}` };
  let url = `${API}${path}`;
  let body: string | undefined;

  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(flatten(params ?? {})).toString();
  } else if (params) {
    url += `?${new URLSearchParams(flatten(params)).toString()}`;
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Stripe ${method} ${path} failed: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  current_period_end: number;
  metadata?: Record<string, string>;
}

export function createCheckoutSession(params: Record<string, unknown>) {
  return call<{ id: string; url: string }>("POST", "/checkout/sessions", params);
}

export function createPortalSession(params: Record<string, unknown>) {
  return call<{ url: string }>("POST", "/billing_portal/sessions", params);
}

export function getSubscription(id: string) {
  return call<StripeSubscription>("GET", `/subscriptions/${id}`);
}

/**
 * Webhook の署名を検証して本文を JSON として返す。
 *
 * Stripe-Signature は `t=<unix>,v1=<hex>,...`。`${t}.${payload}` を
 * Webhook シークレットで HMAC-SHA256 した値と v1 を突き合わせる。
 * リプレイ対策として 5 分より古いものは拒否する。
 */
export async function verifyWebhook(rawBody: string, signature: string): Promise<Record<string, any>> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET が設定されていません。");

  const parts = Object.fromEntries(
    signature.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  ) as Record<string, string>;

  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    throw new Error("Webhook のタイムスタンプが古すぎます。");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // v1 は鍵のローテーション中に複数並ぶことがある
  const received = signature
    .split(",")
    .filter((kv) => kv.trim().startsWith("v1="))
    .map((kv) => kv.trim().slice(3));

  const ok = received.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected));
  if (!ok) throw new Error("Webhook の署名が一致しません。");

  return JSON.parse(rawBody) as Record<string, any>;
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
