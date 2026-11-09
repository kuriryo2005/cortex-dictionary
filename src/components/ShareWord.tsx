/**
 * 単語の共有ボタン（実験 E11）。
 *
 * 共有先は単語ページ /w/<語>。ページは収録済みの語ならどれでも開け、単語ごとの共有画像
 * （public/og/w/）がある語はプレビューにその画像が出る。流入は utm_source=share で数え、
 * どこから共有されたかを utm_medium で分ける。
 */

import React, { useState } from "react";

const SITE = "https://lexi-log-puce.vercel.app";

interface Props {
  word: string;
  contexts?: { field: string; context: string }[];
  meaning?: string;
}

export const ShareWord: React.FC<Props> = ({ word, contexts = [], meaning = "" }) => {
  const [copied, setCopied] = useState(false);
  const w = word.trim().toLowerCase();
  if (!w) return null;

  const url = (medium: string) => `${SITE}/w/${encodeURIComponent(w)}?utm_source=share&utm_medium=${medium}`;
  const text = contexts.length
    ? `${word} は論文だと意味が変わる：${contexts
        .slice(0, 2)
        .map((c) => `${c.field}「${c.context.slice(0, 24)}${c.context.length > 24 ? "…" : ""}」`)
        .join(" / ")}`
    : `${word} の意味：${meaning}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${url("copy")}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境ではボタンが反応しないだけにする
    }
  };

  const btn =
    "inline-flex items-center min-h-9 px-3 border border-[#DDE1E5] text-xs font-bold text-[#1A1C1E] hover:border-[#1A1C1E]";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-[#8A9199] mr-1">この単語を共有</span>
      <a
        className={btn}
        target="_blank"
        rel="noopener"
        href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url("x"))}`}
      >
        X
      </a>
      <a
        className={btn}
        target="_blank"
        rel="noopener"
        href={`https://www.threads.net/intent/post?text=${encodeURIComponent(`${text} ${url("threads")}`)}`}
      >
        Threads
      </a>
      <a
        className={btn}
        target="_blank"
        rel="noopener"
        href={`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url("line"))}`}
      >
        LINE
      </a>
      <button type="button" className={btn} onClick={copy}>
        {copied ? "コピーしました" : "リンクをコピー"}
      </button>
    </div>
  );
};
