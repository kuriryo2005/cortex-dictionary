/**
 * 現在の課金プランを保持する。
 *
 * ログイン状態が変わったときと、Checkout から戻ってきた直後に読み直す。
 * Webhook の反映が数秒遅れることがあるので、決済直後だけは数回リトライする。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { fetchPlanStatus, FREE_STATUS, type PlanStatus } from "../services/billingService";

export function usePlan(user: User | null) {
  const [status, setStatus] = useState<PlanStatus>(FREE_STATUS);
  const [loading, setLoading] = useState(false);
  const timers = useRef<number[]>([]);

  const refresh = useCallback(async () => {
    if (!user) {
      setStatus(FREE_STATUS);
      return;
    }
    setLoading(true);
    try {
      setStatus(await fetchPlanStatus());
    } catch {
      // 取得に失敗しても free として動かす（機能は制限されるが壊れない）
      setStatus(FREE_STATUS);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Checkout 成功で戻ってきたとき。Webhook が届くまで少し待って読み直す。
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "success") return;

    // URL を綺麗にしておく（リロードで何度も走らせない）
    params.delete("checkout");
    const query = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));

    for (const delay of [2000, 5000, 10000]) {
      timers.current.push(window.setTimeout(() => void refresh(), delay));
    }
    return () => {
      timers.current.forEach(window.clearTimeout);
      timers.current = [];
    };
  }, [user, refresh]);

  return { status, loading, refresh, isPro: status.plan === "pro" };
}
