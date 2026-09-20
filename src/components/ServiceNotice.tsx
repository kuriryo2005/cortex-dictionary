/**
 * 新しい単語を生成できないときだけ出す帯。
 *
 * 「できないこと」ではなく「いま何ができるか」を先に書く。
 * 障害中に出していたのは「AIの応答に失敗しました」だけで、
 * 実際には収録済みの検索も復習も動いていることが伝わっていなかった。
 */

import React from "react";
import { useServiceStatus } from "../hooks/useServiceStatus";

export const ServiceNotice: React.FC = () => {
  const { canGenerate, known } = useServiceStatus();
  if (!known || canGenerate) return null;

  return (
    <div
      role="status"
      className="mb-8 rounded-xl border border-[#F0C36D] bg-[#FFF9EC] px-4 py-3 text-[13px] leading-relaxed text-[#6B5320]"
    >
      <span className="font-bold">いま新しい単語の解説を作れていません。</span>
      <br />
      提供元の利用枠が上限に達しています。
      <span className="font-bold">収録済みの単語の検索・保存・復習はこれまで通り使えます。</span>
      復旧まで少しお待ちください。
    </div>
  );
};
