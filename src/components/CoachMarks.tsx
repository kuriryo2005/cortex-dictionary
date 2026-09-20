/**
 * コーチマーク型の伴走ガイド。
 *
 * 登録直後にスライドショーを見せても、閉じた瞬間に忘れる。読むのと
 * 「どこを押すか」が結びつかないからです。実物の要素を明るく囲って、
 * その場で説明するほうが手が動きます。
 *
 * 対象は `data-coach="..."` を付けた実要素。要素が見つからない段は
 * 自動で飛ばします（画面幅で出ない要素があるため、止めない）。
 *
 * 位置は毎フレームではなくリサイズ・スクロール時に測り直します。
 */

import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

const SEEN_KEY = "cortex_coach_seen_v1";

export function hasSeenCoach(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // 読めない環境では出さない（毎回出るほうが害が大きい）
  }
}

export function markCoachSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // 保存できなくても進行は妨げない
  }
}

interface CoachStep {
  /** data-coach の値。null なら画面中央に出す */
  target: string | null;
  title: string;
  body: string;
}

const STEPS: CoachStep[] = [
  {
    target: null,
    title: "3分だけ、一緒に回してみます",
    body: "使い方は「引く → 保存 → 出題される」の3つだけです。順番に指させてください。",
  },
  {
    target: "search",
    title: "まずここに英単語を入れます",
    body: "調べたい語を打って Enter。意味・語源・例文・類義語までまとめて出ます。試しに1語入れてみてください。",
  },
  {
    target: "mode",
    title: "「一般」と「学術」で語義が変わります",
    body: "論文を読むなら「学術」。たとえば significant は学術だと「(統計) 有意な」が先に出ます。stress なら「(工学) 応力」です。",
  },
  {
    target: "nav",
    title: "覚えるのはここから",
    body: "「今日の学習」を上から順にやれば終わりです。保存が増えると「つながり」で語源の図ができます。英文を丸ごと貼って一括で追加することもできます。",
  },
  {
    target: null,
    title: "無料で30語まで保存できます",
    body: "削除すれば枠は戻るので、入れ替えながら使えます。まずは1語、検索欄から入れてみてください。",
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function measure(target: string | null): Rect | null {
  if (!target) return null;
  const el = document.querySelector(`[data-coach="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export const CoachMarks: React.FC<Props> = ({ open, onClose }) => {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const step = STEPS[index];

  const remeasure = useCallback(() => {
    setRect(measure(step?.target ?? null));
  }, [step]);

  useLayoutEffect(() => {
    if (!open) return;
    remeasure();
  }, [open, remeasure]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [open, remeasure]);

  const finish = useCallback(() => {
    markCoachSeen();
    onClose();
  }, [onClose]);

  const next = useCallback(() => {
    // 対象が見つからない段は飛ばす（画面幅によっては出ない要素がある）
    let i = index + 1;
    while (i < STEPS.length && STEPS[i].target && !measure(STEPS[i].target)) i++;
    if (i >= STEPS.length) finish();
    else setIndex(i);
  }, [index, finish]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "Enter" || e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, finish]);

  if (!open || !step) return null;

  const PAD = 8;
  const hole = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null;

  // 吹き出しは、囲みの下に出すのが基本。下に入らなければ上に出す。
  const CARD_W = 320;
  const cardStyle: React.CSSProperties = hole
    ? (() => {
        const below = hole.top + hole.height + 12;
        const fitsBelow = below + 190 < window.innerHeight;
        return {
          top: fitsBelow ? below : Math.max(12, hole.top - 190),
          left: Math.min(Math.max(12, hole.left), window.innerWidth - CARD_W - 12),
          width: CARD_W,
        };
      })()
    : (() => {
        // transform で中央寄せしない。framer-motion がアニメーションのために
        // transform を上書きするので、translate(-50%,-50%) が消えて
        // 画面の中心にカードの左上が来てしまう（実際にそうなった）。
        const w = Math.min(CARD_W, window.innerWidth - 32);
        return {
          top: Math.max(12, (window.innerHeight - 200) / 2),
          left: (window.innerWidth - w) / 2,
          width: w,
        };
      })();

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* 覆い。囲みの部分だけ切り抜く（box-shadow で穴を作る） */}
      {hole ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute rounded-lg pointer-events-none"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            boxShadow: "0 0 0 9999px rgba(15,18,22,0.62)",
            outline: "2px solid #2A5CFF",
            outlineOffset: 2,
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(15,18,22,0.62)]" />
      )}

      {/* 覆いのどこを押しても進む。ただし吹き出しの上は除く */}
      <div className="absolute inset-0" onClick={next} />

      <AnimatePresence mode="wait">
        <motion.div
          key={index}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          className="absolute rounded-xl bg-white shadow-2xl p-5"
          style={cardStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[10px] font-bold tracking-widest text-[#2A5CFF]">
            {index + 1} / {STEPS.length}
          </p>
          <h3 className="mt-1.5 text-[15px] font-black text-[#1A1C1E] leading-snug">
            {step.title}
          </h3>
          <p className="mt-2 text-[13px] leading-relaxed text-[#656E77]">{step.body}</p>

          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={finish}
              className="text-[11px] font-bold text-[#8A9199] hover:text-[#1A1C1E] transition-colors"
            >
              スキップ
            </button>
            <button
              type="button"
              onClick={next}
              className="rounded-lg bg-[#2A5CFF] px-4 py-2 text-[12px] font-bold text-white hover:bg-[#1A3FCC] transition-colors"
            >
              {index === STEPS.length - 1 ? "はじめる" : "次へ"}
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>,
    document.body
  );
};
