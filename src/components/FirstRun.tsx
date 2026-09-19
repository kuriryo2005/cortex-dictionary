/**
 * 保存した単語がまだ1つも無い人に出す、最初の一歩。
 *
 * 登録した直後に空の画面だけを見せると、何をすればいいのか分からないまま
 * 離れてしまう。ここで1語引いてもらえるかどうかが、その後ずっと使って
 * もらえるかの分かれ目になる。
 *
 * 並べている語は、共有キャッシュに収録済みであることを確認したものだけ。
 * キャッシュヒットなら AI を呼ばないので、
 *  - すぐ表示される（待たせない）
 *  - 無料プランの1日の上限を消費しない
 *  - 提供側の利用枠が尽きている間でも動く
 * という3つが同時に成り立つ。最初の体験としてこれ以上のものはない。
 */

import React from "react";
import { motion } from "motion/react";
import { Search } from "lucide-react";

/**
 * 収録済みであることを確認した語（2026-09-20 時点）。
 * 論文や技術文書で繰り返し出会う、意味を曖昧なまま流しがちな語を選んでいる。
 */
const SUGGESTIONS = [
  "threshold",
  "arbitrary",
  "robust",
  "inherent",
  "subtle",
  "ambiguous",
  "coherent",
  "rigorous",
  "nuance",
  "trivial",
  "empirical",
  "converge",
];

interface Props {
  onPick: (word: string) => void;
}

export const FirstRun: React.FC<Props> = ({ onPick }) => (
  <motion.section
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    className="mx-auto w-full max-w-2xl py-10"
  >
    <h2 className="text-xl font-black tracking-tight text-[#1A1C1E]">まず1語、引いてみてください。</h2>
    <p className="mt-3 text-sm leading-relaxed text-[#656E77]">
      意味だけでなく、語源・ニュアンス・分野ごとの用法までまとめて出てきます。
      保存すると、語源でつながる単語のマップに並びます。
    </p>

    <div className="mt-7 flex flex-wrap gap-2">
      {SUGGESTIONS.map((word) => (
        <button
          key={word}
          type="button"
          onClick={() => onPick(word)}
          className="flex items-center gap-1.5 border border-[#EDEFF1] px-3 py-1.5 text-sm font-bold text-[#1A1C1E] transition-colors hover:border-[#1A1C1E]"
        >
          <Search className="h-3.5 w-3.5 text-[#8A9199]" />
          {word}
        </button>
      ))}
    </div>

    <p className="mt-6 text-xs leading-relaxed text-[#8A9199]">
      ここに並んでいる単語は辞書に収録済みなので、すぐに表示され、無料プランの1日の上限も消費しません。
    </p>
  </motion.section>
);
