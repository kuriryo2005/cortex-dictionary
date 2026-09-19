/**
 * 今日あと何語検索できるかを読む。
 *
 * 無料プランで一番効く導線がこれ。残りが見えないまま突然「上限です」と
 * 言われるのと、「今日あと3語」が常に見えているのとでは、上限に対する
 * 納得感も Pro を検討する気持ちも変わる。
 *
 * カウンタ（usage_counters/{uid}）はサーバーのサービスアカウントだけが
 * 書き込み、本人は読み取りだけできる（firestore.rules）。したがって
 * ここは読むだけで、表示のために改竄されても実際の上限には影響しない。
 *
 * 期間キーの作り方は api/_lib/quota.ts と揃える必要がある（日本時間の日付）。
 */

import { useCallback, useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import type { PlanStatus } from "../services/billingService";

/** api/_lib/quota.ts の currentKeys と同じ規則で、日本時間の日付キーを作る。 */
function todayKeyJst(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}`;
}

export interface Usage {
  /** 今日すでに検索した語数。 */
  used: number;
  /** 今日の上限。 */
  limit: number;
  /** 残り（0 未満にはしない）。 */
  remaining: number;
}

export function useUsage(user: User | null, status: PlanStatus) {
  const limit = status.quota.lookup.day;
  const [used, setUsed] = useState(0);

  const refresh = useCallback(async () => {
    if (!user) {
      setUsed(0);
      return;
    }
    try {
      const snap = await getDoc(doc(db, "usage_counters", user.uid));
      const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
      // 日付が変わっていればサーバー側も 0 から数え直すので、ここでも 0 とみなす
      const fresh = data?.dayKey === todayKeyJst();
      setUsed(fresh ? Number(data?.dayCount ?? 0) : 0);
    } catch {
      // 読めなくても表示を諦めるだけ。検索自体には影響しない
      setUsed(0);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usage: Usage = { used, limit, remaining: Math.max(0, limit - used) };
  return { usage, refresh };
}
