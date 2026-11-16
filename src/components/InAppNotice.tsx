/**
 * アプリ内ブラウザで開いている人への案内（帯と、ログインを押したときの説明）。
 * 判定と理由は src/lib/inAppBrowser.ts。
 */

import React, { useState } from "react";
import { androidExternalUrl, type InAppInfo } from "../lib/inAppBrowser";

const copyUrl = async (): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(location.href);
    return true;
  } catch {
    return false;
  }
};

const Steps: React.FC<{ info: InAppInfo }> = ({ info }) => {
  const [copied, setCopied] = useState(false);
  if (info.os === "android") {
    return (
      <div className="flex flex-col gap-2">
        <a
          href={androidExternalUrl()}
          className="inline-flex justify-center items-center min-h-11 px-4 bg-[#1A1C1E] text-white text-sm font-bold"
        >
          Chrome で開く
        </a>
        <p className="text-xs text-[#656E77]">開かないときは、右上の「︙」から「ブラウザで開く」を選んでください。</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ol className="text-sm text-[#1A1C1E] leading-relaxed list-decimal pl-5">
        <li>画面の右上（または右下）にある「…」をタップ</li>
        <li>「外部ブラウザで開く」または「ブラウザで開く」を選ぶ</li>
      </ol>
      <button
        type="button"
        onClick={async () => setCopied(await copyUrl())}
        className="inline-flex justify-center items-center min-h-11 px-4 border border-[#1A1C1E] text-sm font-bold"
      >
        {copied ? "コピーしました。Safari に貼り付けて開いてください" : "リンクをコピーして Safari で開く"}
      </button>
    </div>
  );
};

/** ページ上部の帯。試し引きはこのままできるので、閉じられるようにする。 */
export const InAppBanner: React.FC<{ info: InAppInfo; onOpenHelp: () => void }> = ({ info, onOpenHelp }) => {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="w-full bg-[#FFF4D6] border-b border-[#F0D58A] text-[#1A1C1E]">
      <div className="max-w-5xl mx-auto px-4 py-2.5 flex items-start gap-3 text-xs leading-relaxed">
        <p className="flex-1">
          {info.app} の中のブラウザで開いています。<b>ログイン（登録）はできない</b>ので、ブラウザで開き直してください。試し引きはこのままできます。
        </p>
        <button type="button" onClick={onOpenHelp} className="font-bold underline shrink-0">開き方</button>
        <button type="button" onClick={() => setHidden(true)} aria-label="閉じる" className="shrink-0 px-1">×</button>
      </div>
    </div>
  );
};

/** ログインを押したときに出す説明。 */
export const InAppLoginHelp: React.FC<{ info: InAppInfo; onClose: () => void }> = ({ info, onClose }) => (
  <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" onClick={onClose}>
    <div className="w-full sm:max-w-md bg-white p-5 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
      <div>
        <p className="text-base font-bold text-[#1A1C1E]">ブラウザで開くと登録できます</p>
        <p className="mt-1 text-sm text-[#656E77] leading-relaxed">
          {info.app} の中のブラウザでは、Google の決まりで Google ログインが使えません。Safari や Chrome で開き直すと、そのまま無料で登録できます。
        </p>
      </div>
      <Steps info={info} />
      <button type="button" onClick={onClose} className="text-xs text-[#656E77] underline self-center">閉じる</button>
    </div>
  </div>
);
