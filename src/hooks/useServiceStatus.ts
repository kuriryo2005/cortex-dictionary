/**
 * 本番がいま新しい単語を生成できるかを読む（/api/health）。
 *
 * これを付けた理由。生成が止まっているとき、集客で来た人は
 * 「登録 → 検索 → エラー → 離脱」を一直線に辿る。二度と戻ってきません。
 * 実際には**収録済みの単語の検索も、保存も、復習も動いている**ので、
 * 黙ってエラーを見せるのは、動いているものまで失うのと同じです。
 *
 * 先に伝えておけば、期待を下げたうえで使ってもらえる。
 * 落ちているときに何が使えるかを言うのは、言い訳ではなく案内です。
 *
 * 読めなかったときは「問題なし」として扱う。監視が落ちていることを理由に
 * 警告を出すと、健全なときに嘘の警告を出すことになる。
 */

import { useEffect, useState } from "react";

export interface ServiceStatus {
  /** 新しい単語の解説を生成できるか。 */
  canGenerate: boolean;
  /** 確認できたかどうか（false のときは canGenerate を信用しない）。 */
  known: boolean;
}

/** タブをまたいで何度も叩かないよう、モジュール内に覚えておく。 */
let cached: { at: number; value: ServiceStatus } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export function useServiceStatus(): ServiceStatus {
  const [status, setStatus] = useState<ServiceStatus>(
    () => cached?.value ?? { canGenerate: true, known: false }
  );

  useEffect(() => {
    if (cached && Date.now() - cached.at < CACHE_MS) {
      setStatus(cached.value);
      return;
    }

    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) return;
        const data = (await res.json()) as { canGenerate?: unknown };
        const value: ServiceStatus = {
          canGenerate: data.canGenerate !== false,
          known: true,
        };
        cached = { at: Date.now(), value };
        if (alive) setStatus(value);
      } catch {
        // 読めなくても何も言わない。警告を出す根拠が無い
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  return status;
}
