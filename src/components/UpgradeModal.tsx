/**
 * Pro へのアップグレード導線。
 *
 * カード情報はここでは一切扱わず、Stripe Checkout に遷移させるだけ。
 * 上限に当たった瞬間に開くこともあるので、そのときは理由を上に出す。
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, X, Check } from "lucide-react";
import { toast } from "sonner";
import { startCheckout, openBillingPortal, type PlanStatus } from "../services/billingService";

interface Props {
  open: boolean;
  onClose: () => void;
  status: PlanStatus;
  /** 上限に当たって開いた場合の説明文。 */
  reason?: string;
}

const FREE_POINTS = ["検索 1日10語", "保存 200語まで", "フラッシュカード復習", "データの書き出し"];

const PRO_POINTS = [
  "検索 1日100語（月1,500語）",
  "保存 無制限",
  "語彙ナレッジマップ 全開放",
  "英文から未知語を一括抽出",
  "発音（TTS）と発音記号",
  "学習統計とダッシュボード",
  "Anki 形式でのエクスポート",
];

const Row: React.FC<{ children: React.ReactNode; muted?: boolean }> = ({ children, muted }) => (
  <li className="flex items-start gap-2 text-sm leading-relaxed">
    <Check className={`w-4 h-4 shrink-0 mt-0.5 ${muted ? "text-[#C4C9CE]" : "text-[#2A5CFF]"}`} />
    <span className={muted ? "text-[#8A9199]" : "text-[#1A1C1E]"}>{children}</span>
  </li>
);

export const UpgradeModal: React.FC<Props> = ({ open, onClose, status, reason }) => {
  const [interval, setInterval] = useState<"month" | "year">("year");
  const [busy, setBusy] = useState(false);

  const isPro = status.plan === "pro";

  const go = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "処理に失敗しました。");
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] bg-black/30 flex items-center justify-center p-4"
          onClick={() => !busy && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[88vh] bg-white flex flex-col overflow-hidden"
          >
            <div className="flex items-start justify-between gap-4 px-8 pt-8 pb-4">
              <div>
                <h2 className="text-lg font-black text-[#1A1C1E]">
                  {isPro ? "ご契約中のプラン" : "Cortex Dictionary Pro"}
                </h2>
                <p className="text-xs text-[#8A9199] mt-1">
                  {reason ??
                    (isPro
                      ? "お支払い方法の変更と解約は Stripe の画面から行えます。"
                      : "語彙を本気で増やすための上限解放と全機能。いつでも解約できます。")}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="w-8 h-8 shrink-0 flex items-center justify-center text-[#8A9199] hover:text-[#1A1C1E]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto px-8 pb-8">
              {!isPro && (
                <div className="flex gap-6 border-t border-[#EDEFF1] pt-6">
                  <div className="flex-1">
                    <p className="text-xs font-bold text-[#8A9199] tracking-wide">FREE</p>
                    <p className="text-2xl font-black text-[#1A1C1E] mt-1">¥0</p>
                    <ul className="mt-4 space-y-2">
                      {FREE_POINTS.map((p) => (
                        <Row key={p} muted>
                          {p}
                        </Row>
                      ))}
                    </ul>
                  </div>

                  <div className="flex-1">
                    <p className="text-xs font-bold text-[#2A5CFF] tracking-wide">PRO</p>
                    <p className="text-2xl font-black text-[#1A1C1E] mt-1">
                      {interval === "year" ? "¥400" : "¥600"}
                      <span className="text-sm font-bold text-[#8A9199]"> / 月</span>
                    </p>
                    <p className="text-xs text-[#8A9199] mt-0.5">
                      {interval === "year" ? "年額 ¥4,800（2ヶ月分お得）" : "月額 ¥600"}
                    </p>
                    <ul className="mt-4 space-y-2">
                      {PRO_POINTS.map((p) => (
                        <Row key={p}>{p}</Row>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {isPro && (
                <div className="border-t border-[#EDEFF1] pt-6 text-sm text-[#1A1C1E]">
                  <p className="font-bold">Pro プラン</p>
                  {status.currentPeriodEnd ? (
                    <p className="text-xs text-[#8A9199] mt-1">
                      {status.cancelAtPeriodEnd ? "利用できるのは" : "次回の更新日は"}{" "}
                      {new Date(status.currentPeriodEnd).toLocaleDateString("ja-JP")}
                      {status.cancelAtPeriodEnd ? " までです。" : " です。"}
                    </p>
                  ) : null}
                  <ul className="mt-4 space-y-2">
                    {PRO_POINTS.map((p) => (
                      <Row key={p}>{p}</Row>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-8 flex flex-col gap-3">
                {!isPro && (
                  <div className="flex gap-2">
                    {(["year", "month"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setInterval(v)}
                        className={`flex-1 py-2 text-sm font-bold border ${
                          interval === v
                            ? "border-[#1A1C1E] text-[#1A1C1E]"
                            : "border-[#EDEFF1] text-[#8A9199] hover:text-[#1A1C1E]"
                        }`}
                      >
                        {v === "year" ? "年額 ¥4,800" : "月額 ¥600"}
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  disabled={busy || !status.billingEnabled}
                  onClick={() =>
                    go(isPro ? openBillingPortal : () => startCheckout(interval))
                  }
                  className="w-full py-3 bg-[#1A1C1E] text-white text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isPro ? "お支払い・解約の管理" : "Pro にアップグレード"}
                </button>

                {!status.billingEnabled && (
                  <p className="text-xs text-[#8A9199] text-center">
                    現在お申し込みを受け付けていません。しばらくしてからお試しください。
                  </p>
                )}
                {!isPro && status.billingEnabled && (
                  <p className="text-xs text-[#8A9199] text-center leading-relaxed">
                    決済は Stripe が処理します。カード情報がこのアプリに保存されることはありません。
                    <br />
                    お申し込みをもって{" "}
                    <a href="/legal/terms.html" target="_blank" rel="noreferrer" className="underline">
                      利用規約
                    </a>
                    {" と "}
                    <a href="/legal/privacy.html" target="_blank" rel="noreferrer" className="underline">
                      プライバシーポリシー
                    </a>
                    {" に同意したものとみなします（"}
                    <a href="/legal/tokushoho.html" target="_blank" rel="noreferrer" className="underline">
                      特商法表記
                    </a>
                    ）。
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
