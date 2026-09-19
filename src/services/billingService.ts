/**
 * 課金まわりのクライアント側。サーバーの /api/billing-* を叩くだけ。
 *
 * カード情報はこのアプリでは一切扱わない。入力も解約も Stripe が
 * ホストする画面（Checkout / Customer Portal）に飛ばして任せる。
 */

import { auth } from "../firebase";

export type PlanId = "free" | "pro";

export interface PlanStatus {
  plan: PlanId;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  quota: { day: number; week: number; month: number };
  wordLimit: number | null;
  /** サーバーに Stripe の設定が入っているか。false なら課金導線を出さない。 */
  billingEnabled: boolean;
}

/** 契約状態が取れないときに使う既定値（常に厳しい側＝free に倒す）。 */
export const FREE_STATUS: PlanStatus = {
  plan: "free",
  quota: { day: 10, week: 40, month: 100 },
  wordLimit: 200,
  billingEnabled: false,
};

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("ログインが必要です。");
  const res = await fetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await user.getIdToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(detail.error ?? "リクエストに失敗しました。"));
  }
  return (await res.json()) as T;
}

export function fetchPlanStatus(): Promise<PlanStatus> {
  return post<PlanStatus>("/api/billing-status");
}

/** Stripe Checkout に遷移する。戻ってこないので返り値はない。 */
export async function startCheckout(interval: "month" | "year"): Promise<void> {
  const { url } = await post<{ url: string }>("/api/billing-checkout", { interval });
  window.location.href = url;
}

/** 解約・支払い方法の変更。Stripe の Customer Portal に遷移する。 */
export async function openBillingPortal(): Promise<void> {
  const { url } = await post<{ url: string }>("/api/billing-portal");
  window.location.href = url;
}
