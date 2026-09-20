/**
 * コーチマークの見え方を、ログインせずに確かめるための画面（開発時のみ）。
 *
 *   npm run dev → http://localhost:3100/?coach=1
 *
 * 本物のアプリはログインしないとサイドバーが出ないので、囲みの位置計算や
 * 吹き出しの回り込みを目で確認できなかった。data-coach を付けた枠だけを
 * 同じ配置で並べて、そこに当てて見る。本番のバンドルには入らない。
 */

import React, { useState } from "react";
import { CoachMarks } from "./CoachMarks";

export const CoachMarksHarness: React.FC = () => {
  const [open, setOpen] = useState(true);

  return (
    <div className="flex h-screen bg-white text-[#1A1C1E]">
      <aside className="w-72 shrink-0 border-r border-[#E6E8EB] flex flex-col">
        <div className="px-6 pt-6">
          <form className="relative group" data-coach="search">
            <input
              placeholder="単語を検索"
              className="w-full h-10 text-sm border-b border-[#E6E8EB] outline-none"
              readOnly
            />
          </form>
          <div className="flex gap-4 mt-2" data-coach="mode">
            <span className="text-[11px] font-bold border-b border-[#1A1C1E]">一般</span>
            <span className="text-[11px] font-bold text-[#8A9199]">学術</span>
          </div>
        </div>
        <nav className="px-6 pt-6 pb-3 grid grid-cols-2 gap-x-3" data-coach="nav">
          {["単語帳", "今日の学習", "単語カード", "つながり", "英文から追加"].map((l) => (
            <span key={l} className="h-8 text-[11px] font-bold text-[#656E77]">
              {l}
            </span>
          ))}
        </nav>
      </aside>

      <main className="flex-1 p-10">
        <p className="text-sm text-[#656E77]">
          コーチマーク確認用（開発時のみ）。
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-lg bg-[#2A5CFF] px-4 py-2 text-[12px] font-bold text-white"
        >
          もう一度見る
        </button>
      </main>

      <CoachMarks open={open} onClose={() => setOpen(false)} />
    </div>
  );
};
