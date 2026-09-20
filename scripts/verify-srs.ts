/**
 * 復習サイクルまわりの純粋ロジックの検証。
 *
 *   npx tsx scripts/verify-srs.ts
 *
 * 対象は src/lib/srs.ts（間隔の計算）、src/lib/recall.ts（想起テストの採点）、
 * src/lib/cycle.ts（今日のサイクルの段分け）、src/lib/graph.ts（房の判定）。
 * Firestore にも Gemini にも接続しない。
 */

import {
  LEARNING_STEPS_MS,
  applyRating,
  countAgain,
  formatInterval,
  isLeech,
  previewIntervals,
  replay,
  schedule,
} from "../src/lib/srs.js";
import { editDistance, initialHint, judge, normalizeAnswer } from "../src/lib/recall.js";
import { computeCycle } from "../src/lib/cycle.js";
import { buildGraph, isolatedWords, neighborhood } from "../src/lib/graph.js";
import { ReviewRating, ReviewSession, SavedWord } from "../src/types.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log("       ", detail);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

function word(id: string, extra: Partial<SavedWord> = {}): SavedWord {
  return {
    id,
    word: id,
    meaning: `${id} の意味`,
    grammar: "",
    etymology: "",
    nuance: "",
    specializedContexts: [],
    examples: [],
    synonyms: [],
    antonyms: [],
    etymologyNodes: [],
    category: "",
    timestamp: Date.now(),
    ...extra,
  };
}

function history(ratings: ReviewRating[], start = Date.now() - 100 * DAY): ReviewSession[] {
  return ratings.map((rating, i) => ({ rating, timestamp: start + i * DAY }));
}

// --------------------------------------------------------------------------
section("srs: 学習ステップ");

{
  const now = Date.now();

  const first = schedule([], ReviewRating.GOOD, now);
  check(
    "初回 GOOD は 10 分後（1 段目を終えて 2 段目へ）",
    first.nextReviewAt - now === LEARNING_STEPS_MS[1],
    first.nextReviewAt - now
  );
  check("初回 GOOD は同じセッション内で再出題する", first.requeueInSession);

  const again = schedule([], ReviewRating.AGAIN, now);
  check("AGAIN は 1 段目へ戻る（1 分後）", again.nextReviewAt - now === LEARNING_STEPS_MS[0]);

  const easy = schedule([], ReviewRating.EASY, now);
  check("初回 EASY は即卒業して数日後", easy.nextReviewAt - now > 3 * DAY, easy.intervalLabel);
  check("卒業した語は同じセッションに戻さない", !easy.requeueInSession);

  // GOOD 3 回で卒業する
  const g1 = replay(history([ReviewRating.GOOD]));
  const g2 = applyRating(g1, ReviewRating.GOOD, now);
  const g3 = applyRating(g2, ReviewRating.GOOD, now);
  check("GOOD 3 回で卒業する（step が外れる）", g3.step === null, g3);
}

// --------------------------------------------------------------------------
section("srs: 卒業後の間隔");

{
  const now = Date.now();
  const graduated = history([ReviewRating.GOOD, ReviewRating.GOOD, ReviewRating.GOOD]);

  const good = schedule(graduated, ReviewRating.GOOD, now);
  const hard = schedule(graduated, ReviewRating.HARD, now);
  const easy = schedule(graduated, ReviewRating.EASY, now);

  check("EASY > GOOD > HARD の順に間隔が長い",
    easy.nextReviewAt > good.nextReviewAt && good.nextReviewAt > hard.nextReviewAt,
    { easy: easy.intervalLabel, good: good.intervalLabel, hard: hard.intervalLabel });

  check("どの評価でも必ず未来になる", hard.nextReviewAt > now);

  // 間隔は伸び続ける（同じ履歴で縮まない）
  let state = replay(graduated);
  let prev = state.intervalMs;
  let monotonic = true;
  for (let i = 0; i < 8; i++) {
    state = applyRating(state, ReviewRating.GOOD, now);
    if (state.intervalMs < prev) monotonic = false;
    prev = state.intervalMs;
  }
  check("GOOD を続けると間隔が単調に伸びる", monotonic, prev / DAY);
  check("間隔には上限がある", prev <= 300 * DAY, prev / DAY);

  const lapsed = schedule(
    history([ReviewRating.GOOD, ReviewRating.GOOD, ReviewRating.GOOD, ReviewRating.GOOD]),
    ReviewRating.AGAIN,
    now
  );
  check("忘れた語は学習ステップへ戻る（当日中に再出題）",
    lapsed.nextReviewAt - now <= LEARNING_STEPS_MS[0] && lapsed.requeueInSession);
}

// --------------------------------------------------------------------------
section("srs: 履歴の再生とプレビュー");

{
  const h = history([ReviewRating.GOOD, ReviewRating.AGAIN, ReviewRating.GOOD, ReviewRating.HARD]);
  const a = replay(h);
  const b = replay(h);
  check("再生は決定的（同じ履歴なら同じ state）", JSON.stringify(a) === JSON.stringify(b));
  check("AGAIN は lapses に数えられる", a.lapses >= 0 && a.reps === 4, a);

  const preview = previewIntervals(h);
  check("4 段すべての予告が出る",
    Object.values(preview).every((v) => typeof v === "string" && v.length > 0), preview);

  check("formatInterval: 分", formatInterval(10 * MIN) === "10分後", formatInterval(10 * MIN));
  check("formatInterval: 日", formatInterval(3 * DAY) === "3日後", formatInterval(3 * DAY));
}

// --------------------------------------------------------------------------
section("srs: 抜けない語");

{
  const leech = word("obfuscate", { reviewHistory: history(Array(6).fill(ReviewRating.AGAIN)) });
  const fine = word("clear", { reviewHistory: history([ReviewRating.GOOD, ReviewRating.GOOD]) });
  check("AGAIN 6 回で抜けない語になる", isLeech(leech), countAgain(leech));
  check("覚えている語は対象外", !isLeech(fine));
}

// --------------------------------------------------------------------------
section("recall: 想起テストの採点");

{
  check("完全一致は正解", judge("turbulence", "turbulence") === "correct");
  check("大文字と前後の空白は無視する", judge("  Turbulence ", "turbulence") === "correct");
  check("長い語の 1 文字違いはおしい", judge("turbulense", "turbulence") === "close");
  check("短い語の 1 文字違いは不正解", judge("cut", "cat") === "wrong");
  check("空欄は不正解", judge("", "cat") === "wrong");
  check("まったく違う語は不正解", judge("banana", "turbulence") === "wrong");

  check("normalizeAnswer が記号を落とす", normalizeAnswer("To  Look!") === "to look");
  check("editDistance の打ち切りが効く", editDistance("a", "abcdefghij", 3) > 3);
  check("initialHint は最初と最後だけ見せる",
    initialHint("turbulence") === "t········e", initialHint("turbulence"));
}

// --------------------------------------------------------------------------
section("cycle: 今日のサイクル");

{
  const now = new Date();
  const today = now.getTime();
  const yesterday = today - DAY;

  const fresh = word("fresh", { timestamp: today });
  const introduced = word("introduced", {
    timestamp: today,
    reviewHistory: [{ rating: ReviewRating.GOOD, timestamp: today }],
    nextReviewAt: today + 10 * MIN,
  });
  const settled = word("settled", {
    timestamp: today,
    reviewHistory: [
      { rating: ReviewRating.GOOD, timestamp: today },
      { rating: ReviewRating.GOOD, timestamp: today },
    ],
  });
  const dueOld = word("due", { timestamp: yesterday - 10 * DAY, nextReviewAt: today - DAY });
  const futureOld = word("future", { timestamp: yesterday - 10 * DAY, nextReviewAt: today + 30 * DAY });

  const cycle = computeCycle([fresh, introduced, settled, dueOld, futureOld], now);
  const [intro, recall, mix] = cycle.stages;

  check("導入には今日入れた未評価の語だけが入る",
    intro.words.length === 1 && intro.words[0].id === "fresh", intro.words.map((w) => w.id));
  check("想起には 1 回だけ評価した今日の語が入る",
    recall.words.some((w) => w.id === "introduced") && !recall.words.some((w) => w.id === "settled"),
    recall.words.map((w) => w.id));
  check("定着には期限が来た古い語が入る",
    mix.words.length === 1 && mix.words[0].id === "due", mix.words.map((w) => w.id));
  check("期限が先の語はどの段にも入らない",
    !cycle.stages.some((s) => s.words.some((w) => w.id === "future")));
  check("学習ステップの途中の語は「この後もう一度」に出る",
    cycle.soonAgain.some((w) => w.id === "introduced"), cycle.soonAgain.map((w) => w.id));
  check("進み具合は 0..1 に収まる", cycle.progress >= 0 && cycle.progress <= 1, cycle.progress);

  const empty = computeCycle([], now);
  check("単語が無い日は終わっている扱い", empty.finished && empty.progress === 1);
}

// --------------------------------------------------------------------------
section("graph: 房とレイヤーの重ね合わせ");

{
  const inspect = word("inspect", {
    etymologyNodes: [
      { word: "respect", meaning: "尊敬する", root: "spect (to look)", relation: "同じ語根", importance: 0.8 },
    ],
    synonyms: [{ word: "examine", translation: "調べる" }],
  });
  const respect = word("respect", {
    etymologyNodes: [
      { word: "inspect", meaning: "検査する", root: "-SPECT-", relation: "同じ語根", importance: 0.8 },
    ],
  });
  const lonely = word("lonely", {});

  const ety = buildGraph([inspect, respect, lonely], "etymology");
  check("語根の表記ゆれは 1 つの語根ノードにまとまる",
    ety.nodes.filter((n) => n.kind === "root").length === 1,
    ety.nodes.filter((n) => n.kind === "root").map((n) => n.label));
  check("同じ語根の語は同じ房になる",
    ety.nodes.find((n) => n.id === "inspect")!.cluster ===
      ety.nodes.find((n) => n.id === "respect")!.cluster);
  check("つながりのない語は孤立語として拾える",
    isolatedWords(ety).map((w) => w.id).join(",") === "lonely",
    isolatedWords(ety).map((w) => w.id));

  const both = buildGraph([inspect, respect, lonely], ["etymology", "synonym"]);
  check("レイヤーを重ねると類義語の線も乗る",
    both.links.some((l) => l.kind === "synonym") && both.links.some((l) => l.kind === "root"));
  check("重ねてもノードは重複しない",
    new Set(both.nodes.map((n) => n.id)).size === both.nodes.length);

  const near = neighborhood(ety, "inspect", 2);
  check("2 歩で同じ語根の相手まで届く", near.has("respect"), [...near]);
  check("孤立語は近傍に入らない", !near.has("lonely"));

  const clustersWithWords = ety.clusters.filter((c) => c.words.length >= 2);
  check("房の一覧が作られる", clustersWithWords.length === 1, ety.clusters.map((c) => c.words.length));
}

// --------------------------------------------------------------------------
console.log(
  failures === 0 ? "\nすべて通りました。" : `\n${failures} 件が失敗しました。`
);
process.exit(failures === 0 ? 0 : 1);
