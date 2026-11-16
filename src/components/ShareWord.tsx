/**
 * 単語の共有ボタン（実験 E11）。
 *
 * 共有先は単語ページ /w/<語>。ページは収録済みの語ならどれでも開け、単語ごとの共有画像
 * （public/og/w/）がある語はプレビューにその画像が出る。流入は utm_source=share で数え、
 * どこから共有されたかを utm_medium で分ける。
 *
 * Instagram には Web から投稿する入口が無いので、共有用の画像（4:5）をその場で作り、
 * スマホでは共有シート（Instagram を選べる）、PC では画像の保存とキャプションのコピーにする。
 */

import React, { useEffect, useState } from "react";
import { renderShareCard } from "../lib/shareCard";

const SITE = "https://lexi-log-puce.vercel.app";

interface Props {
  word: string;
  contexts?: { field: string; context: string }[];
  meaning?: string;
  phonetic?: string;
}

const XIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const InstagramIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const ThreadsIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M16.5 11.2c-.4-2.6-2.1-4-4.6-4-2.9 0-4.6 2.1-4.6 4.8s1.6 4.8 4.6 4.8c2.3 0 3.6-1.2 3.6-2.8 0-1.5-1.2-2.4-3.1-2.4-1.6 0-2.6.8-2.6 1.9" />
    <path d="M16.5 11.2c3 .6 3.7 3 2.6 5.3-1.2 2.5-3.9 4-7.2 4C7 20.5 3.5 17.2 3.5 12S7 3.5 11.9 3.5c3.5 0 6 1.6 7.3 4.3" />
  </svg>
);

const LineIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
    <path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.5 1.1-.5 5.9-3.5 8-5.9 1.4-1.6 2-3.2 2-4.9C22 6.6 17.5 3 12 3z" />
  </svg>
);

export const ShareWord: React.FC<Props> = ({ word, contexts = [], meaning = "", phonetic }) => {
  const [copied, setCopied] = useState(false);
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null);
  const [making, setMaking] = useState(false);
  const [notice, setNotice] = useState("");
  const w = word.trim().toLowerCase();

  useEffect(() => () => { if (card) URL.revokeObjectURL(card.url); }, [card]);

  if (!w) return null;

  const url = (medium: string) => `${SITE}/w/${encodeURIComponent(w)}?utm_source=share&utm_medium=${medium}`;
  const text = contexts.length
    ? `${word} は論文だと意味が変わる：${contexts
        .slice(0, 2)
        .map((c) => `${c.field}「${c.context.slice(0, 24)}${c.context.length > 24 ? "…" : ""}」`)
        .join(" / ")}`
    : `${word} の意味：${meaning}`;
  const caption = `${word}、論文だと意味が変わる。\n知ってる単語ほど読み違える📄\n\n分野ごとの意味はプロフィールのリンクから「${word}」で検索できます。\n\n#英語論文 #大学院生 #研究室 #英単語 #理系`;
  const fileName = `cortex-${w.replace(/[^a-z0-9-]/g, "-")}.png`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${url("copy")}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境ではボタンが反応しないだけにする
    }
  };

  const openInstagram = async () => {
    if (making) return;
    setMaking(true);
    setNotice("");
    try {
      const blob = await renderShareCard({ word, meaning, phonetic, contexts });
      setCard({ blob, url: URL.createObjectURL(blob) });
    } catch {
      setNotice("画像を作れませんでした。もう一度お試しください。");
    } finally {
      setMaking(false);
    }
  };

  const shareImage = async () => {
    if (!card) return;
    const file = new File([card.blob], fileName, { type: "image/png" });
    try {
      await navigator.clipboard.writeText(caption);
    } catch {
      // コピーできなくても共有は続ける
    }
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: caption });
        setNotice("共有先で Instagram を選んでください。キャプションはコピー済みです。");
      } catch {
        // 共有シートを閉じただけのときは何もしない
      }
      return;
    }
    saveImage();
  };

  const saveImage = () => {
    if (!card) return;
    const a = document.createElement("a");
    a.href = card.url;
    a.download = fileName;
    a.click();
    navigator.clipboard?.writeText(caption).catch(() => {});
    setNotice("画像を保存しました。Instagram で投稿するときに選んでください（キャプションはコピー済み）。");
  };

  const btn =
    "inline-flex items-center gap-1.5 min-h-9 px-3 border border-[#DDE1E5] text-xs font-bold text-[#1A1C1E] hover:border-[#1A1C1E]";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[#8A9199] mr-1">この単語を共有</span>
        <button
          type="button"
          onClick={openInstagram}
          className="inline-flex items-center gap-1.5 min-h-9 px-3 text-xs font-bold text-white bg-gradient-to-r from-[#F58529] via-[#DD2A7B] to-[#8134AF] hover:opacity-90"
        >
          <InstagramIcon />
          {making ? "画像を作成中…" : "Instagram 用の画像"}
        </button>
        <a
          className={btn}
          target="_blank"
          rel="noopener"
          aria-label="X で共有"
          href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url("x"))}`}
        >
          <XIcon />X
        </a>
        <a
          className={btn}
          target="_blank"
          rel="noopener"
          aria-label="Threads で共有"
          href={`https://www.threads.net/intent/post?text=${encodeURIComponent(`${text} ${url("threads")}`)}`}
        >
          <ThreadsIcon />Threads
        </a>
        <a
          className={btn}
          target="_blank"
          rel="noopener"
          aria-label="LINE で共有"
          href={`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url("line"))}`}
        >
          <span className="text-[#06C755]"><LineIcon /></span>LINE
        </a>
        <button type="button" className={btn} onClick={copy}>
          {copied ? "コピーしました" : "リンクをコピー"}
        </button>
      </div>

      {card && (
        <div className="border border-[#DDE1E5] p-3 flex flex-col sm:flex-row gap-4 items-start">
          <img src={card.url} alt={`${word} の共有画像`} className="w-full sm:w-56 border border-[#EEE]" />
          <div className="flex flex-col gap-2 text-xs text-[#656E77] leading-relaxed">
            <p>Instagram のフィード・ストーリーズにそのまま使えるサイズ（1080×1350）です。</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={shareImage}
                className="inline-flex items-center gap-1.5 min-h-9 px-3 text-xs font-bold text-white bg-[#1A1C1E] hover:opacity-90"
              >
                <InstagramIcon />共有する
              </button>
              <button type="button" className={btn} onClick={saveImage}>画像を保存</button>
              <button type="button" className={btn} onClick={() => setCard(null)}>閉じる</button>
            </div>
          </div>
        </div>
      )}
      {notice && <p className="text-xs text-[#656E77]">{notice}</p>}
    </div>
  );
};
