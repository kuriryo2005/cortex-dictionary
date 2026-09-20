/**
 * 「今日のサイクル」— その日に覚えるための決まった手順。
 *
 * これまでの復習は「復習を始める」の一本しかなく、何をどこまでやれば
 * その日が終わりなのかが決まっていなかった。終わりが見えない作業は続かないし、
 * 新しく調べた語はその日のうちに一度も想起されないまま翌日へ流れていた。
 *
 * そこで 1 日を 3 つの段に切る。段の設計は忘却曲線に合わせている。
 *
 *   1. 導入   新しく入れた語に一度目を通す（意味と語源を結びつける）
 *   2. 想起   同じ語を、今度は日本語から綴りを打たせて引き出す
 *   3. 定着   今日の語に期限が来た古い語を混ぜて出す（インターリービング）
 *
 * 1 と 2 のあいだは学習ステップ（1分 / 10分 / 1日）が受け持つので、
 * ここで決めるのは「どの語がどの段に属するか」だけ。
 */

import { endOfDay, startOfDay } from "date-fns";
import { SavedWord } from "../types";
import { isLeech, replay } from "./srs";

export type StageKey = "intro" | "recall" | "mix";

export interface CycleStage {
  key: StageKey;
  title: string;
  /** その段でやることの説明。1 行 */
  hint: string;
  /** 対象の単語 */
  words: SavedWord[];
  /** 済んだ語数 */
  done: number;
  /** 段として完了しているか */
  complete: boolean;
}

export interface DailyCycle {
  stages: CycleStage[];
  /** 学習ステップの途中で、今日この後もう一度出る語 */
  soonAgain: SavedWord[];
  /** 何度も落としている語。別の覚え方に切り替える合図 */
  leeches: SavedWord[];
  /** 0..1 */
  progress: number;
  /** 3 段すべて終わったか */
  finished: boolean;
}

/** その日に触れた語か（保存したか、評価したか）。 */
function touchedToday(word: SavedWord, dayStart: number, dayEnd: number): boolean {
  if (word.timestamp >= dayStart && word.timestamp <= dayEnd) return true;
  return (word.reviewHistory ?? []).some((h) => h.timestamp >= dayStart && h.timestamp <= dayEnd);
}

/** その日に評価した回数。 */
function gradesToday(word: SavedWord, dayStart: number, dayEnd: number): number {
  return (word.reviewHistory ?? []).filter((h) => h.timestamp >= dayStart && h.timestamp <= dayEnd)
    .length;
}

export function computeCycle(words: SavedWord[], now = new Date()): DailyCycle {
  const dayStart = startOfDay(now).getTime();
  const dayEnd = endOfDay(now).getTime();
  const ts = now.getTime();

  /** 今日入れた語。導入と想起の対象になる */
  const todayWords = words.filter((w) => w.timestamp >= dayStart && w.timestamp <= dayEnd);

  /** 今日入れた語のうち、まだ一度も評価していないもの */
  const introPending = todayWords.filter((w) => (w.reviewHistory ?? []).length === 0);

  /** 導入は済んだが、今日 2 回目に達していないもの */
  const recallPending = todayWords.filter(
    (w) => (w.reviewHistory ?? []).length > 0 && gradesToday(w, dayStart, dayEnd) < 2
  );

  /** 期限が来ている古い語。今日入れた語は含めない */
  const duePending = words.filter(
    (w) =>
      w.timestamp < dayStart &&
      w.nextReviewAt != null &&
      w.nextReviewAt <= dayEnd &&
      !touchedToday(w, dayStart, dayEnd)
  );

  const introDone = todayWords.length - introPending.length;
  const recallDone = todayWords.filter((w) => gradesToday(w, dayStart, dayEnd) >= 2).length;
  const dueTotal = words.filter(
    (w) => w.timestamp < dayStart && w.nextReviewAt != null && w.nextReviewAt <= dayEnd
  ).length;
  const dueDone = dueTotal - duePending.length;

  const stages: CycleStage[] = [
    {
      key: "intro",
      title: "導入",
      hint: "今日入れた語に一度目を通す。意味と語源を結びつける",
      words: introPending,
      done: introDone,
      complete: introPending.length === 0,
    },
    {
      key: "recall",
      title: "想起",
      hint: "同じ語を、日本語から綴りを打って引き出す",
      words: recallPending,
      done: recallDone,
      complete: todayWords.length > 0 && recallPending.length === 0,
    },
    {
      key: "mix",
      title: "定着",
      hint: "期限が来た古い語を混ぜて出す",
      words: duePending,
      done: dueDone,
      complete: duePending.length === 0,
    },
  ];

  /** 学習ステップの途中で、今日この後もう一度出る語 */
  const soonAgain = words
    .filter((w) => {
      if (w.nextReviewAt == null || w.nextReviewAt <= ts || w.nextReviewAt > dayEnd) return false;
      return replay(w.reviewHistory).step !== null;
    })
    .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0));

  const leeches = words.filter(isLeech);

  // 進み具合は「その段に用がある」ものだけを分母にする。
  // 今日 1 語も入れていない日に、導入が 0/0 で未完のまま残らないようにする。
  const active = stages.filter((s) => s.words.length + s.done > 0);
  const totalUnits = active.reduce((n, s) => n + s.words.length + s.done, 0);
  const doneUnits = active.reduce((n, s) => n + s.done, 0);

  return {
    stages,
    soonAgain,
    leeches,
    progress: totalUnits === 0 ? 1 : doneUnits / totalUnits,
    finished: active.every((s) => s.complete),
  };
}
