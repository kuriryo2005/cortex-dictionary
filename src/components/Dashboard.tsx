/**
 * 今日のダッシュボード（実装仕様書 F6）。
 *
 * 表示する数値はすべてローカルキャッシュ上の savedWords から計算する。
 * Firestore への追加読み取りは発生しない（streak だけは日跨ぎの判定が
 * 必要なので user_stats に永続化してある）。
 *
 * 区切りは枠ではなく罫線と余白で表す。
 */

import React from "react";
import { motion } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import { Deck, SavedWord, UserStats } from "../types";
import { computeDeckProgress, computeStats } from "../lib/stats";
import type { DailyCycle, StageKey } from "../lib/cycle";
import { countAgain } from "../lib/srs";

interface Props {
  words: SavedWord[];
  decks: Deck[];
  stats: UserStats | null;
  enriching: { remaining: number; running: boolean };
  cycle: DailyCycle;
  onStartReview: (scope: "due" | "overdue" | "fresh" | "all") => void;
  onStartStage: (key: StageKey) => void;
  onOpenExtract: () => void;
  onSelectDeck: (deckId: string | null) => void;
  onWordClick: (word: SavedWord) => void;
}

/** 次にもう一度出る時刻を「あと N 分」で示す。 */
function untilLabel(at: number | undefined, now = Date.now()): string {
  if (at == null) return "";
  const min = Math.max(1, Math.round((at - now) / 60000));
  if (min < 60) return `あと ${min} 分`;
  return `あと ${Math.round(min / 60)} 時間`;
}

/**
 * 今日のサイクル。3 段を縦に並べ、いま手を付けるべき段だけを濃く出す。
 *
 * 数値を並べるだけのダッシュボードは「今日は何をどこまでやれば終わりか」に
 * 答えてくれない。段と残り枚数を出して、終わりを見えるようにする。
 */
const Cycle: React.FC<{
  cycle: DailyCycle;
  onStartStage: (key: StageKey) => void;
}> = ({ cycle, onStartStage }) => {
  // 先頭の未完了段が「いま手を付ける段」
  const activeKey = cycle.stages.find((s) => s.words.length > 0)?.key;

  return (
    <section className="section">
      <div className="flex items-baseline justify-between mb-5">
        <h3 className="section-label !mb-0">今日のサイクル</h3>
        <span className="text-[11px] font-bold text-[#8A9199] tabular-nums">
          {Math.round(cycle.progress * 100)}%
        </span>
      </div>

      <div className="h-0.5 bg-[#F1F3F5] mb-7">
        <div
          className="h-0.5 bg-[#1A1C1E] transition-all duration-500"
          style={{ width: `${cycle.progress * 100}%` }}
        />
      </div>

      <ol>
        {cycle.stages.map((stage, i) => {
          const total = stage.words.length + stage.done;
          const idle = total === 0;
          const active = stage.key === activeKey;

          return (
            <li
              key={stage.key}
              className="flex items-start gap-4 py-4 border-t border-[#F1F3F5] first:border-t-0 first:pt-0"
            >
              {/* 段の番号。済んだ段はチェックに変わる */}
              <span
                className={`mt-0.5 w-5 h-5 shrink-0 flex items-center justify-center text-[10px] font-black tabular-nums ${
                  stage.complete && !idle
                    ? "bg-[#1A1C1E] text-white"
                    : active
                      ? "bg-[#2A5CFF] text-white"
                      : "border border-[#EAECEF] text-[#C9CDD2]"
                }`}
              >
                {stage.complete && !idle ? <Check className="w-3 h-3" /> : i + 1}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span
                    className={`text-sm font-black ${
                      idle ? "text-[#C9CDD2]" : "text-[#1A1C1E]"
                    }`}
                  >
                    {stage.title}
                  </span>
                  <span className="text-[11px] font-bold text-[#8A9199] tabular-nums">
                    {idle ? "対象なし" : `${stage.done} / ${total}`}
                  </span>
                </div>
                <p
                  className={`text-[11px] leading-relaxed mt-1 ${
                    idle ? "text-[#C9CDD2]" : "text-[#656E77]"
                  }`}
                >
                  {stage.hint}
                </p>
              </div>

              {stage.words.length > 0 && (
                <button
                  type="button"
                  onClick={() => onStartStage(stage.key)}
                  className={`shrink-0 text-xs font-bold border-b transition-colors ${
                    active
                      ? "text-[#2A5CFF] border-[#2A5CFF]"
                      : "text-[#8A9199] border-transparent hover:text-[#1A1C1E] hover:border-[#1A1C1E]"
                  }`}
                >
                  {stage.words.length} 語を始める
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {cycle.finished && (
        <p className="mt-6 pl-4 border-l-2 border-[#1A1C1E] text-xs text-[#656E77] leading-loose">
          今日の分は終わりました。ここで止めるのが、明日も続けるいちばんの近道です。
        </p>
      )}

      {cycle.soonAgain.length > 0 && (
        <div className="mt-8 pt-6 border-t border-[#F1F3F5]">
          <p className="text-[11px] font-bold text-[#8A9199] mb-3">
            今日この後もう一度出る語 {cycle.soonAgain.length}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {cycle.soonAgain.slice(0, 8).map((w) => (
              <span key={w.id} className="text-[11px] text-[#656E77]">
                <b className="font-bold text-[#1A1C1E]">{w.word}</b>{" "}
                <span className="tabular-nums text-[#8A9199]">{untilLabel(w.nextReviewAt)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

/** 数値ひとつ。押せるものは下線で示す。 */
const Metric: React.FC<{
  value: number;
  label: string;
  onClick?: () => void;
  emphasis?: boolean;
}> = ({ value, label, onClick, emphasis }) => {
  const disabled = !onClick || value === 0;
  const color = emphasis && value > 0 ? "text-red-600" : "text-[#1A1C1E]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-left group disabled:cursor-default"
    >
      <div
        className={`text-4xl font-black tabular-nums ${color} ${
          disabled ? "opacity-30" : "group-hover:text-[#2A5CFF] transition-colors"
        }`}
      >
        {value}
      </div>
      <div className="text-[11px] font-bold text-[#8A9199] mt-1">{label}</div>
    </button>
  );
};

export const Dashboard: React.FC<Props> = ({
  words,
  decks,
  stats,
  enriching,
  cycle,
  onStartReview,
  onStartStage,
  onOpenExtract,
  onSelectDeck,
  onWordClick,
}) => {
  const s = computeStats(words);
  const progress = computeDeckProgress(words, decks);
  const maxDaily = Math.max(1, ...s.weekly.map((d) => d.count));

  if (words.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="h-full flex flex-col justify-center max-w-xl mx-auto w-full"
      >
        <h2 className="text-3xl font-black text-[#1A1C1E] mb-3">保存された単語はありません</h2>
        <p className="text-[#656E77] text-sm mb-10 leading-relaxed">
          左上の検索から単語を調べるか、英文を貼り付けてまとめて追加できます。
        </p>
        <div>
          <button type="button" onClick={onOpenExtract} className="btn-quiet px-0">
            英文を貼り付けて追加
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-3xl mx-auto pb-12"
    >
      <div className="mb-10">
        <h1 className="text-3xl md:text-4xl font-black tracking-tight text-[#1A1C1E]">今日の学習</h1>
        <p className="text-sm text-[#8A9199] mt-1">
          {s.total} 語を管理中 · 今週 {s.addedThisWeek} 語追加
        </p>
      </div>

      {enriching.remaining > 0 && (
        <p className="mb-10 pl-4 border-l-2 border-[#2A5CFF] text-xs text-[#656E77] flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 text-[#2A5CFF] animate-spin shrink-0" />
          追加した単語の詳細を生成しています（残り {enriching.remaining} 語）
        </p>
      )}

      <section className="section">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <Metric value={s.dueToday} label="今日の復習" onClick={() => onStartReview("due")} />
          <Metric value={s.overdue} label="期限超過" onClick={() => onStartReview("overdue")} emphasis />
          <Metric value={s.fresh} label="未復習" onClick={() => onStartReview("fresh")} />
          <Metric value={stats?.streak ?? 0} label="連続学習日" />
        </div>

        <div className="flex flex-wrap items-center gap-8 mt-10">
          <button
            type="button"
            onClick={() => onStartReview(s.dueToday > 0 ? "due" : "all")}
            className="btn-primary"
          >
            復習を始める
          </button>
          <button type="button" onClick={onOpenExtract} className="btn-quiet px-0">
            英文から追加
          </button>
        </div>

        {s.overdue > 20 && (
          <p className="mt-10 pl-4 border-l-2 border-[#EAECEF] text-xs text-[#656E77] leading-loose">
            期限を過ぎた単語が {s.overdue} 語あります。一度にすべて復習せず、
            「期限超過」から少しずつ進めることをおすすめします。
          </p>
        )}
      </section>

      <Cycle cycle={cycle} onStartStage={onStartStage} />

      {/* 何度やっても抜けない語。間隔を伸ばしても効かないので別の入口を出す */}
      {cycle.leeches.length > 0 && (
        <section className="section">
          <h3 className="section-label">抜けない語 {cycle.leeches.length}</h3>
          <p className="text-[11px] text-[#656E77] leading-loose mb-5">
            間隔を伸ばしても抜けない語です。カードをめくり直すより、語源や例文から
            入れ直すほうが早いことが多いので、詳細を開いて別の手がかりを付けてください。
          </p>
          <div>
            {cycle.leeches.slice(0, 6).map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => onWordClick(w)}
                className="w-full text-left group py-3 border-t border-[#F1F3F5] first:border-t-0 first:pt-0 flex items-baseline justify-between gap-4"
              >
                <span className="min-w-0">
                  <span className="text-xs font-bold text-[#1A1C1E] group-hover:text-[#2A5CFF] transition-colors">
                    {w.word}
                  </span>
                  <span className="text-[11px] text-[#8A9199] ml-3">{w.meaning}</span>
                </span>
                <span className="shrink-0 text-[10px] font-bold text-[#DC2626] tabular-nums">
                  忘れた {countAgain(w)} 回
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h3 className="section-label">直近7日の追加</h3>
        <div className="flex items-end justify-between gap-3 h-24">
          {s.weekly.map((d) => (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-2">
              <span className="text-[10px] font-bold text-[#8A9199] tabular-nums">
                {d.count || ""}
              </span>
              <div
                className="w-full bg-[#1A1C1E] transition-all"
                style={{
                  height: `${Math.max(d.count ? 4 : 1, (d.count / maxDaily) * 72)}px`,
                  opacity: d.count ? 1 : 0.12,
                }}
              />
              <span className="text-[10px] text-[#8A9199]">{d.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h3 className="section-label">デッキ別の定着</h3>

        {progress.length === 0 ? (
          <p className="text-xs text-[#8A9199]">デッキはまだありません。</p>
        ) : (
          <div>
            {progress.map((row) => (
              <button
                key={row.deck?.id ?? "unfiled"}
                onClick={() => onSelectDeck(row.deck?.id ?? null)}
                className="w-full text-left group py-4 border-t border-[#F1F3F5] first:border-t-0 first:pt-0"
              >
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-xs font-bold text-[#1A1C1E] group-hover:text-[#2A5CFF] transition-colors">
                    {row.deck?.name ?? "未分類"}
                  </span>
                  <span className="text-[11px] text-[#8A9199] tabular-nums">
                    {Math.round(row.retained * 100)}% · {row.total} 語
                  </span>
                </div>
                <div className="h-0.5 bg-[#F1F3F5]">
                  <div
                    className="h-0.5 transition-all"
                    style={{
                      width: `${row.retained * 100}%`,
                      backgroundColor: row.deck?.color ?? "#1A1C1E",
                    }}
                  />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </motion.div>
  );
};
