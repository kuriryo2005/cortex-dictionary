/**
 * ランディングページに置く語彙マップの見本。
 *
 * このアプリで一番伝わるのは語彙ナレッジマップだが、ログインしないと
 * 見られないため、来た人に一番の売りが伝わらないまま登録を求めていた。
 * 「単語が網になる」という体験は文章で説明しても伝わらないので、
 * 実際のデータで作った図をそのまま見せる。
 *
 * 本体の力学グラフ（react-force-graph）は重く、ユーザーのデータが無いと
 * 意味をなさないので、ここでは位置を決め打ちした静的な SVG にしている。
 * 語と意味は dictionary_cache に実在するものを使っている。
 */

import React from "react";

interface Node {
  word: string;
  ja: string;
  /** 中心からの角度（度）。0 が右、時計回り。 */
  angle: number;
  /** 中心からの距離。 */
  radius: number;
  /** まだ知らない語として薄く描く。 */
  unknown?: boolean;
}

/** 語源 vert（向きを変える）の束。すべて実際に収録されている語。 */
const NODES: Node[] = [
  { word: "divert", ja: "そらす", angle: -90, radius: 108 },
  { word: "adverse", ja: "不利な", angle: -30, radius: 122 },
  { word: "version", ja: "版", angle: 30, radius: 106 },
  { word: "diverse", ja: "多様な", angle: 90, radius: 120 },
  { word: "avert", ja: "回避する", angle: 150, radius: 104 },
  { word: "vertigo", ja: "めまい", angle: -150, radius: 124, unknown: true },
  { word: "introvert", ja: "内向的な人", angle: -60, radius: 196, unknown: true },
  { word: "controversial", ja: "物議を醸す", angle: 60, radius: 200, unknown: true },
];

const CX = 250;
const CY = 190;

function pos(n: Node): { x: number; y: number } {
  const rad = (n.angle * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * n.radius, y: CY + Math.sin(rad) * n.radius };
}

export const MapPreview: React.FC = () => (
  <figure className="m-0">
    <svg
      viewBox="0 0 500 380"
      role="img"
      aria-label="語源 vert でつながる英単語のマップ。中心の vert から divert、adverse、version、diverse、avert などが放射状に伸びている。"
      className="w-full"
    >
      {/* 中心から各語への線。未学習の語は薄く */}
      {NODES.map((n) => {
        const p = pos(n);
        return (
          <line
            key={`l-${n.word}`}
            x1={CX}
            y1={CY}
            x2={p.x}
            y2={p.y}
            stroke="#2A5CFF"
            strokeWidth={n.unknown ? 1 : 1.6}
            strokeOpacity={n.unknown ? 0.25 : 0.55}
          />
        );
      })}

      {NODES.map((n) => {
        const p = pos(n);
        return (
          <g key={n.word}>
            <circle
              cx={p.x}
              cy={p.y}
              r={n.unknown ? 5 : 7}
              fill={n.unknown ? "#ffffff" : "#2A5CFF"}
              stroke={n.unknown ? "#C4C9CE" : "none"}
              strokeDasharray={n.unknown ? "2 2" : undefined}
            />
            <text
              x={p.x}
              y={p.y - 14}
              textAnchor="middle"
              className="font-bold"
              fontSize="13"
              fill={n.unknown ? "#8A9199" : "#1A1C1E"}
            >
              {n.word}
            </text>
            <text x={p.x} y={p.y + 22} textAnchor="middle" fontSize="11" fill="#8A9199">
              {n.ja}
            </text>
          </g>
        );
      })}

      {/* 中心の語根 */}
      <circle cx={CX} cy={CY} r="34" fill="#1A1C1E" />
      <text x={CX} y={CY + 6} textAnchor="middle" fontSize="18" fontWeight="900" fill="#ffffff">
        vert
      </text>
      {/* 円の中に収めると窮屈なので、意味は円の外に出す */}
      <text x={CX} y={CY + 54} textAnchor="middle" fontSize="12" fontWeight="700" fill="#656E77">
        向きを変える
      </text>
    </svg>

    <figcaption className="mt-4 text-xs leading-relaxed text-[#8A9199]">
      実際の画面より。覚えた語は濃く、まだ知らない語は点線のシルエットで現れます。
      1語覚えるたびに、その周りの知らない語まで見えるようになります。
    </figcaption>
  </figure>
);
