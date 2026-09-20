/**
 * 初回のスタートアップガイド。
 *
 * このアプリは「調べる → ためる → today のサイクルで覚える → つながりで補強する」
 * という流れで出来ているが、画面を開いただけではその順番が見えない。
 * 検索欄とサイドバーだけが目に入って、単語帳もつながり図も気づかれずに終わる。
 *
 * そこで初回ログイン時に一度だけ通しで見せる。ただし**読みたくない人を止めない**
 * ことを最優先にした。右上のスキップ、背景のクリック、Esc のどれでも即座に閉じ、
 * 閉じた時点で「見た」ことにして二度と自動では出さない。読みたくなったら
 * サイドバー下の「使い方」からいつでも開き直せる。
 */

import React, { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, ArrowRight, ArrowLeft } from "lucide-react";

const STORAGE_KEY = "cortex_dict_guide_seen";

/** 初回かどうか。localStorage が使えない環境では出さない（邪魔をしない側に倒す）。 */
export function hasSeenGuide(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markGuideSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // 保存できなくてもガイド自体は閉じられる
  }
}

// ---------------------------------------------------------------------------
// 図解。
//
// 文章だけだと読み飛ばされるので、各段に 1 枚ずつ小さな絵を置く。
// 画像は持たず、その場で描く SVG にしてある（読み込み待ちを作らないため）。
// 配色はアプリのトークンに合わせる。
// ---------------------------------------------------------------------------

const INK = "#1A1C1E";
const BLUE = "#2A5CFF";
const MUTED = "#8A9199";
const LINE = "#EAECEF";

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg viewBox="0 0 320 130" className="w-full h-auto" role="img" aria-hidden="true">
    {children}
  </svg>
);

/** 検索して引く。 */
const ArtLookup = () => (
  <Frame>
    <rect x="20" y="24" width="180" height="24" fill="none" stroke={LINE} />
    <line x1="20" y1="48" x2="200" y2="48" stroke={INK} strokeWidth="1.5" />
    <text x="30" y="41" fontSize="11" fill={INK} fontWeight="bold">turbulence</text>
    {[0, 1, 2].map((i) => (
      <g key={i}>
        <line x1="20" y1={72 + i * 18} x2={140 - i * 30} y2={72 + i * 18} stroke={MUTED} strokeWidth="1" />
        <line x1={150 - i * 30} y1={72 + i * 18} x2={190 - i * 34} y2={72 + i * 18} stroke={LINE} strokeWidth="1" />
      </g>
    ))}
    <rect x="228" y="24" width="72" height="82" fill="none" stroke={LINE} />
    <text x="238" y="44" fontSize="8" fill={MUTED}>意味</text>
    <text x="238" y="60" fontSize="8" fill={MUTED}>語源</text>
    <text x="238" y="76" fontSize="8" fill={MUTED}>例文</text>
    <text x="238" y="92" fontSize="8" fill={MUTED}>類義語</text>
    <path d="M204 60 L222 60" stroke={BLUE} strokeWidth="1.5" />
    <path d="M216 55 L222 60 L216 65" fill="none" stroke={BLUE} strokeWidth="1.5" />
  </Frame>
);

/** 導入 → 想起 → 定着 の 3 段。 */
const ArtCycle = () => (
  <Frame>
    {[
      { x: 26, label: "導入", note: "目を通す", on: true },
      { x: 122, label: "想起", note: "打って出す", on: true },
      { x: 218, label: "定着", note: "混ぜて出す", on: false },
    ].map((s, i) => (
      <g key={s.label}>
        <rect x={s.x} y="34" width="76" height="46" fill="none" stroke={s.on ? INK : LINE} />
        <text x={s.x + 12} y="55" fontSize="11" fontWeight="bold" fill={s.on ? INK : MUTED}>
          {s.label}
        </text>
        <text x={s.x + 12} y="70" fontSize="8" fill={MUTED}>{s.note}</text>
        {i < 2 && (
          <>
            <line x1={s.x + 78} y1="57" x2={s.x + 92} y2="57" stroke={MUTED} strokeWidth="1" />
            <path d={`M${s.x + 87} 53 L${s.x + 92} 57 L${s.x + 87} 61`} fill="none" stroke={MUTED} strokeWidth="1" />
          </>
        )}
      </g>
    ))}
    <line x1="26" y1="98" x2="294" y2="98" stroke={LINE} />
    <line x1="26" y1="98" x2="170" y2="98" stroke={BLUE} strokeWidth="2" />
    <text x="26" y="116" fontSize="8" fill={MUTED}>1分後 · 10分後 · 1日後 と間隔を空けて出し直す</text>
  </Frame>
);

/** 日本語から綴りを打たせる。 */
const ArtRecall = () => (
  <Frame>
    <text x="160" y="36" fontSize="11" fontWeight="bold" fill={INK} textAnchor="middle">
      乱流；動揺
    </text>
    <line x1="90" y1="70" x2="230" y2="70" stroke={INK} strokeWidth="1.5" />
    <text x="160" y="64" fontSize="13" fontWeight="bold" fill={INK} textAnchor="middle">
      turbulense
    </text>
    <text x="160" y="92" fontSize="9" fontWeight="bold" fill="#EA580C" textAnchor="middle">
      おしい
    </text>
    <text x="160" y="108" fontSize="8" fill={MUTED} textAnchor="middle">
      綴りのずれは 正解 / おしい / 不正解 で自動判定
    </text>
  </Frame>
);

/** 語根を真ん中に置いた房。 */
const ArtGraph = () => {
  const nodes = [
    { x: 70, y: 40, r: 9, c: BLUE, t: "inspect" },
    { x: 62, y: 96, r: 8, c: BLUE, t: "respect" },
    { x: 148, y: 100, r: 7, c: BLUE, t: "prospect" },
    { x: 244, y: 44, r: 8, c: "#C2410C", t: "disturb" },
    { x: 268, y: 96, r: 7, c: "#C2410C", t: "turbid" },
  ];
  return (
    <Frame>
      {nodes.slice(0, 3).map((n) => (
        <line key={n.t} x1={n.x} y1={n.y} x2="120" y2="62" stroke={INK} strokeOpacity="0.25" />
      ))}
      {nodes.slice(3).map((n) => (
        <line key={n.t} x1={n.x} y1={n.y} x2="228" y2="76" stroke="#C2410C" strokeOpacity="0.3" />
      ))}
      <circle cx="120" cy="62" r="13" fill="#fff" stroke={BLUE} strokeWidth="2" />
      <text x="120" y="66" fontSize="9" fontStyle="italic" fill={INK} textAnchor="middle">spect</text>
      <circle cx="228" cy="76" r="11" fill="#fff" stroke="#C2410C" strokeWidth="2" />
      <text x="228" y="80" fontSize="9" fontStyle="italic" fill={INK} textAnchor="middle">turb</text>
      {nodes.map((n) => (
        <g key={n.t}>
          <circle cx={n.x} cy={n.y} r={n.r} fill={n.c} />
          <text x={n.x} y={n.y + n.r + 11} fontSize="8" fill={MUTED} textAnchor="middle">{n.t}</text>
        </g>
      ))}
    </Frame>
  );
};

/** 見開きの紙面。 */
const ArtWordbook = () => (
  <Frame>
    <rect x="24" y="18" width="130" height="94" fill="none" stroke={LINE} />
    <rect x="166" y="18" width="130" height="94" fill="none" stroke={LINE} />
    <rect x="24" y="18" width="130" height="14" fill={INK} />
    <text x="32" y="28" fontSize="8" fill="#fff" fontWeight="bold">Unit 1</text>
    {[0, 1, 2, 3].map((i) => (
      <g key={i}>
        <text x="32" y={50 + i * 16} fontSize="9" fontWeight="bold" fill={INK}>word</text>
        <rect x="70" y={43 + i * 16} width="76" height="8" fill="#E4007F" opacity="0.18" />
        <line x1="174" y1={50 + i * 16} x2="264" y2={50 + i * 16} stroke={MUTED} strokeWidth="0.8" />
        <line x1="174" y1={55 + i * 16} x2="234" y2={55 + i * 16} stroke={LINE} strokeWidth="0.8" />
      </g>
    ))}
    <text x="24" y="126" fontSize="8" fill={MUTED}>赤シートで訳を隠せる · そのまま印刷できる</text>
  </Frame>
);

// ---------------------------------------------------------------------------

interface Step {
  /** 上に出す小見出し */
  eyebrow: string;
  title: string;
  /** 1 行の要約 */
  lead: string;
  /** 箇条書き。3 つまで */
  points: string[];
  art: React.FC;
}

const STEPS: Step[] = [
  {
    eyebrow: "はじめに",
    title: "1語ずつ覚えるのをやめる",
    lead: "語源でつながった「束」で覚えるアプリです。使う手順は、引く → 保存する → 出題される、の3つだけです。",
    points: [
      "調べると、意味・語源・例文・類義語まで一度に出ます",
      "保存した語は、忘れるころに自動で出題されます",
      "無料で 30 語まで保存できます（削除すれば枠は戻ります）",
    ],
    art: ArtLookup,
  },
  {
    eyebrow: "1. 調べる",
    title: "検索欄に英単語を入れる",
    lead: "画面左上の検索欄に英単語を打ってEnter。数秒で解説が出るので、「保存」を押すと自分の単語帳に入ります。",
    points: [
      "「一般 / 学術」の切り替えで語義の優先順位が変わります（例: stress は学術だと「応力」が出ます）",
      "英文を丸ごと貼ると、知らなそうな語だけをまとめて抜き出せます",
      "保存した語はデッキとタグで分けられます",
    ],
    art: ArtLookup,
  },
  {
    eyebrow: "2. 覚える",
    title: "「今日の学習」を上から順にやる",
    lead: "その日やることが3段で並びます。3段を終えたら今日は終わりです。何をやるか迷う必要はありません。",
    points: [
      "導入 — 今日入れた語に一度目を通す",
      "想起 — 同じ語を、日本語から綴りを打って思い出す",
      "定着 — 期限が来た古い語を混ぜて出す",
    ],
    art: ArtCycle,
  },
  {
    eyebrow: "3. 引き出す",
    title: "「見れば分かる」では足りない",
    lead: "カードをめくる復習に加えて、日本語から綴りを打つテストがあります。綴りは機械が判定するので、自己採点が甘くなりません。",
    points: [
      "評価を押すと「次にいつ出るか」が表示されます（覚えた→10分後 / 余裕→5日後）",
      "新しい語は、その日のうちに 1分後・10分後にもう一度出ます",
      "何度やっても抜けない語は自動で拾い上げます",
    ],
    art: ArtRecall,
  },
  {
    eyebrow: "4. つなげる",
    title: "保存した語が図でつながる",
    lead: "保存が増えると、語源・類義語・対義語で結んだ図ができます。同じ語根の語は自動で同じ色の房になります。",
    points: [
      "語根をクリックすると、まだ持っていない仲間の語を探せます",
      "どこともつながっていない語は別に表示されます（いちばん抜けやすい語です）",
      "図は保存が10語を超えたあたりから見応えが出ます",
    ],
    art: ArtGraph,
  },
  {
    eyebrow: "5. 持ち出す",
    title: "紙にも、他のアプリにも出せる",
    lead: "ためた語はこのアプリの中に閉じ込めません。いつでも持ち出せます。",
    points: [
      "市販の単語帳と同じ見開きに組んで印刷できます（赤シート対応）",
      "JSON / CSV / Anki 形式で書き出せます",
      "書き出した JSON から復元できます（復元は Pro 限定）",
    ],
    art: ArtWordbook,
  },
];

interface Props {
  open: boolean;
  /** 閉じたとき。スキップでも完了でも同じように呼ばれる */
  onClose: () => void;
}

export const StartupGuide: React.FC<Props> = ({ open, onClose }) => {
  const [index, setIndex] = useState(0);

  const close = useCallback(() => {
    markGuideSeen();
    onClose();
  }, [onClose]);

  // 開き直したときは頭から
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Esc で閉じる。矢印キーで進む・戻る
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowRight") {
        setIndex((i) => Math.min(STEPS.length - 1, i + 1));
      } else if (e.key === "ArrowLeft") {
        setIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;
  const Art = step.art;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] bg-black/30 flex items-center justify-center p-4"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label="使い方"
        >
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl max-h-[90vh] bg-white flex flex-col overflow-hidden"
          >
            {/* 上段。スキップは最初から最後まで同じ位置に出し続ける */}
            <div className="flex items-start justify-between gap-4 px-8 pt-7 pb-2">
              <span className="text-[10px] font-bold text-[#8A9199] uppercase tracking-[0.12em] mt-1">
                {step.eyebrow}
              </span>
              <button
                type="button"
                onClick={close}
                className="flex items-center gap-1.5 text-[11px] font-bold text-[#8A9199] hover:text-[#1A1C1E] transition-colors shrink-0"
              >
                スキップ
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/*
              入れ替えは AnimatePresence を使わない。
              mode="wait" だと退場アニメーションの間だけ古い段が残るため、
              外側に置いた小見出しやドットが先に進んで本文だけ 1 段遅れる
              （実際にそうなっていた）。key で作り直して入場だけ付ければ、
              どの部品も同じ段を指したままになる。
            */}
            <div className="px-8 pb-2 overflow-y-auto">
              <motion.div
                key={index}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.16 }}
              >
                <h2 className="text-2xl font-black tracking-tight text-[#1A1C1E]">
                  {step.title}
                </h2>
                <p className="text-sm text-[#656E77] leading-relaxed mt-2">{step.lead}</p>

                <div className="my-7 py-4 border-t border-b border-[#F1F3F5]">
                  <Art />
                </div>

                <ul className="space-y-2.5">
                  {step.points.map((point) => (
                    <li key={point} className="flex items-start gap-3">
                      <span className="mt-[7px] w-1 h-1 shrink-0 bg-[#1A1C1E]" />
                      <span className="text-[13px] text-[#1A1C1E] leading-relaxed">{point}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            </div>

            {/* 下段。現在地と進む／戻る */}
            <div className="mt-auto px-8 pt-6 pb-7">
              <div className="flex items-center justify-between gap-4">
                {/* 段の位置。押して飛べる */}
                <div className="flex items-center gap-2">
                  {STEPS.map((s, i) => (
                    <button
                      key={s.title}
                      type="button"
                      onClick={() => setIndex(i)}
                      aria-label={`${i + 1} ページ目`}
                      className={`h-1 transition-all ${
                        i === index ? "w-6 bg-[#1A1C1E]" : "w-2 bg-[#EAECEF] hover:bg-[#C9CDD2]"
                      }`}
                    />
                  ))}
                </div>

                <div className="flex items-center gap-5 shrink-0">
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => setIndex((i) => i - 1)}
                      className="flex items-center gap-1.5 text-xs font-bold text-[#8A9199] hover:text-[#1A1C1E] transition-colors"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      戻る
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => (isLast ? close() : setIndex((i) => i + 1))}
                    className="btn-primary h-10 px-6 text-sm"
                  >
                    {isLast ? "はじめる" : "次へ"}
                    {!isLast && <ArrowRight className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-[#C9CDD2] mt-5">
                あとからサイドバー下の「使い方」でいつでも開けます
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
