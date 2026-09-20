/**
 * Stripe に Cortex Dictionary Pro の商品と料金を作る（1回だけ実行する）。
 *
 *   npx tsx scripts/setup-stripe-prices.ts
 *
 * .env.local の STRIPE_SECRET_KEY を読む。出力された price ID を
 * STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY に設定する。
 * 同名の商品が既にあれば作り直さず、その料金を表示するだけにする。
 */

import "dotenv/config";
import { config } from "dotenv";

config({ path: ".env.local", override: true });

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("STRIPE_SECRET_KEY が .env.local にありません。");
  process.exit(1);
}

const PRODUCT_NAME = "Cortex Dictionary Pro";
const PRODUCT_DESCRIPTION =
  "収録済みの単語は引き放題。AIが新しく解説を作る単語が1日100語まで。保存無制限・ナレッジマップ全開放・英文から一括抽出・発音・統計・Ankiエクスポート。";
const MONTHLY_JPY = 600;
const YEARLY_JPY = 4800;

async function stripe<T>(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${KEY}` };
  let url = `https://api.stripe.com/v1${path}`;
  let body: string | undefined;
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  } else if (Object.keys(params).length) {
    url += `?${new URLSearchParams(params).toString()}`;
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

interface Product { id: string; name: string }
interface Price { id: string; unit_amount: number; recurring?: { interval: string } }

const { data: products } = await stripe<{ data: Product[] }>("GET", "/products", { limit: "100", active: "true" });
let product = products.find((p) => p.name === PRODUCT_NAME);

if (product) {
  console.log(`既存の商品を使います: ${product.id}`);
  // 説明は Checkout 画面に出るので、文言を変えたら反映し直す
  await stripe<Product>("POST", `/products/${product.id}`, { description: PRODUCT_DESCRIPTION });
} else {
  product = await stripe<Product>("POST", "/products", {
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
  });
  console.log(`商品を作成しました: ${product.id}`);
}

const { data: prices } = await stripe<{ data: Price[] }>("GET", "/prices", {
  product: product.id,
  limit: "100",
  active: "true",
});

async function ensurePrice(amount: number, interval: "month" | "year"): Promise<string> {
  const found = prices.find((p) => p.unit_amount === amount && p.recurring?.interval === interval);
  if (found) return found.id;
  const created = await stripe<Price>("POST", "/prices", {
    product: product!.id,
    currency: "jpy",
    unit_amount: String(amount),
    "recurring[interval]": interval,
  });
  return created.id;
}

const monthly = await ensurePrice(MONTHLY_JPY, "month");
const yearly = await ensurePrice(YEARLY_JPY, "year");

console.log("\n--- .env.local と Vercel の環境変数に設定してください ---");
console.log(`STRIPE_PRICE_MONTHLY=${monthly}`);
console.log(`STRIPE_PRICE_YEARLY=${yearly}`);
