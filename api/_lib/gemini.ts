/**
 * サーバー側の Gemini クライアントとプロンプト定義（実装仕様書 F1）。
 *
 * GEMINI_API_KEY はサーバーの環境変数からのみ読む。
 * このファイルはブラウザに配信されないため、キーがクライアントへ漏れない。
 */

import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";

/**
 * 使用モデル。
 *
 * 旧: gemini-3-flash-preview（プレビュー版）
 * 実測で最初のトークンまで 15〜20 秒かかり、合計 17〜23 秒。thinkingLevel を
 * MINIMAL にしてもスキーマを小さくしても改善しなかった（scripts/bench-latency.ts）。
 * gemini-2.5-flash は同じ内容を TTFT 1.0 秒 / 合計 4.2 秒で返すため、しばらくこちらを使っていた。
 *
 * 2026-09: gemini-3.8-flash（正式版、プレビューではない）を試験導入。品質を見て
 * 2.5-flash に戻すか判断する。thinkingBudget は Gemini 3 系では非推奨のため
 * thinkingLevel に切り替えている（下記 FAST_THINKING 参照。MINIMAL は 3.8-flash
 * では無効なので使えず、最速設定は LOW）。
 */
/**
 * 主力モデル。
 *
 * 2026-09-20: gemini-3.8-flash から 3.6-flash に変更した。3.8 は 503
 * （high demand）を返し続けて実際に検索が止まったうえ、同じ単価で
 * 3.6 のほうが語源の説明が丁寧だった（turbulence で比較したところ、
 * 3.6 は turba まで遡るが lite 系は「動詞に由来する」で止まる）。
 * 語源がこのアプリの中心なので、そこが厚いほうを選ぶ。
 */
export const MODEL = "gemini-3.6-flash";

/**
 * MODEL が使えないときに順に試す代替モデル。
 *
 * 本番で gemini-3.8-flash が 503（This model is currently experiencing high
 * demand）を返し続け、検索が丸ごと止まった。キーの自動退避は作ってあったが、
 * モデル側が詰まったときの逃げ道が無く、1モデルに全面依存していた。
 *
 * 軽くて安い 3.5-flash-lite を先に置く（実測で 3.7秒 / 0.39円 と速く、
 * 構造は主力と同じ）。混雑が明けていれば 3.8-flash も試す。
 * 解説がやや簡素になっても、止まるよりははるかにいい。
 */
/**
 * MODEL が使えないときに順に試す代替モデル。
 *
 * **並べ方の根拠（2026-09-21 に無料枠の実容量を数えて組み替えた）**
 *
 * 無料枠はモデルごとに別勘定で、1 鍵あたり Flash 20回/日・Lite 500回/日。
 * 鍵 12 本だと
 *
 *   Flash 5 種 × 20 × 12 =  1,200 回/日（全体の  9%）
 *   Lite  2 種 × 500 × 12 = 12,000 回/日（全体の 91%）
 *
 * つまり容量のほとんどは Lite が持っている。それなのに以前は Lite を
 * 最後に置いていたため、混雑や枠切れのときに容量 9% の Flash を 5 種
 * 順に叩き、25 秒の締め切りに先に達して**残り 91% に手を付けないまま
 * 失敗していた**（「締め切りに達したので切り替えを打ち切ります」が実際に出た）。
 *
 * かといって Lite を先頭にはしない。語源の説明が浅くなるからで、
 * それはこのアプリの核を削ることになる（turbulence で比べると 3.6 は
 * turba まで遡るが、lite 系は「動詞に由来する」で止まる）。
 *
 * そこで **Flash を 3 種で見切って Lite へ渡す**。平常時の品質はそのままで、
 * 4 手目には必ず容量の大きい側へ届く。残りの Flash はさらにその後ろに置く。
 *
 * 2026-09-21: gemini-2.5-flash と gemini-2.5-flash-lite は外した。
 * 鍵 12 本すべてで 404（no longer available to new users）を返す。
 * ListModels の一覧にはまだ載っているので、一覧を見ただけでは気づけない。
 */
export const FALLBACK_MODELS = [
  // 品質の近い Flash はここまで（主力とあわせて 2 手）
  "gemini-3.8-flash",
  // 3 手目で容量の大きい Lite に渡す。
  // 4 手目に置いていたら、前の 3 つで締め切りを使い切って到達できなかった。
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  // 最後の保険
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
] as const;

/**
 * モデルが一時的に使えないことを示すエラーか。
 * 503（混雑）と 404（提供終了・2.5系で実際に起きた）を対象にする。
 */
export function isModelUnavailable(error: unknown): boolean {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    m.includes("503") ||
    m.includes("high demand") ||
    m.includes("overloaded") ||
    m.includes("unavailable") ||
    m.includes("404") ||
    m.includes("no longer available") ||
    // 無料枠の上限はモデルごとに付く（通常 Flash は1日20回、Lite は500回）。
    // あるモデルを使い切っても別のモデルには枠が残っているので、429 も
    // 「このモデルは諦めて次へ」の合図として扱う。キーの切り替えは
    // withKeyFailover が先に済ませているため、ここに届いた429は
    // 「どのキーでもこのモデルは枠切れ」を意味する。
    m.includes("429") ||
    m.includes("resource_exhausted") ||
    m.includes("quota")
  );
}

/**
 * MODEL で試し、モデル側の都合で駄目なら代替モデルへ降りる。
 *
 * `run` はモデル名を受け取って呼び出しを行う。キーの切り替えは
 * withKeyFailover が内側で面倒を見るので、ここはモデルだけを変える。
 */
/**
 * 実際の検索で「どのモデルが通ったか / 詰まったか」を記録しておく台帳。
 *
 * /api/health は当初、確認のために自分で1トークン生成していた。しかし
 * 無料枠の上限はモデルごとに1日20回しかない。10分おきに全キー全モデルを
 * 叩けば、それだけで1日144回。**監視が枠を食い尽くして本番を止めていた。**
 * 観測行為が観測対象を壊す、最悪の形になっていた。
 *
 * 本番の検索はどのみち成否を知っているのだから、それを書き留めれば
 * 追加の消費はゼロで済む。health はこれを読むだけにする。
 *
 * サーバーレスなのでインスタンスごとの部分的な記録にしかならないが、
 * 「枠を食わずに、実際に起きたことだけを報告する」ほうが、正確に嘘をつく
 * よりはるかにいい。
 */
export interface ModelObservation {
  model: string;
  ok: boolean;
  at: number;
}
const observations = new Map<string, ModelObservation>();

function record(model: string, ok: boolean): void {
  observations.set(model, { model, ok, at: Date.now() });
}

/** 直近に生成が通ったモデル（新しい順）。 */
export function observedWorkingModels(): string[] {
  return [...observations.values()]
    .filter((o) => o.ok)
    .sort((a, b) => b.at - a.at)
    .map((o) => o.model);
}

/** 何か1件でも観測できているか（まだ誰も検索していなければ false）。 */
export function hasObservations(): boolean {
  return observations.size > 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 1 回の試行に上限を付ける。
 *
 * 締め切り（deadline）は試行と試行の**あいだ**でしか見ていなかったため、
 * 1 回の呼び出しが長引くと上限をそのまま突破していた。実測で、1 回の 503 が
 * 返るまでに 35.8 秒かかったことがある。25 秒で打ち切るつもりが 35 秒待たされ、
 * Vercel 側の maxDuration(30秒) に先に刈られて、こちらの丁寧なエラーではなく
 * 素の 504 が利用者に出る。
 *
 * 時間切れは「そのモデルが応答しない」ことなので、503 と同じ扱いにして
 * 次のモデルへ降りられるようにする（isModelUnavailable が拾える文言にする）。
 *
 * 注意: ここで諦めても裏の HTTP リクエスト自体は止まらない。止める手段を
 * 用意していないので、通信は無駄になる。それでも、返らない呼び出しに
 * 全体を引きずられるよりはいい。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, model: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`503 timeout: ${model} が ${ms}ms 以内に応答しませんでした`)),
      ms
    );
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * 1 回の試行に許す最大時間（最後まで読み切るまで）。
 *
 * 成功時の実測が 10 秒前後なので、ここを短くすると成功を殺してしまう。
 * 「詰まったモデルを早く見切る」役はこちらではなく TTFT_TIMEOUT_MS が担う。
 */
const ATTEMPT_TIMEOUT_MS = 18_000;

/**
 * 最初のトークンが来るまでに許す時間。
 *
 * **ここが本命の見切り。**
 * 実測では、健全なら 2〜4 秒で最初のトークンが出る。出ないモデルは
 * そのあと速くなることもないので、待たずに次へ渡したほうがいい。
 *
 * 総時間で見切ろうとして失敗した経緯: 上限を 15 秒にしていたら、
 * 詰まった 3.8-flash がその 15 秒を丸ごと使い、3.6 の 2.3 秒と
 * 3.7 の 6.7 秒と合わせて 25 秒の締め切りを食い尽くし、
 * **容量の 91% を持つ Lite に一度も到達しないまま失敗した**（実地ログで確認）。
 * 総時間は成功に合わせるしかないので、見切りは初トークンで行う。
 */
export const TTFT_TIMEOUT_MS = 5_000;

/**
 * 「最初の 1 個」が来るまでに期限を設ける。
 * 1 個目が来たら解除し、その後は好きなだけ時間をかけてよい。
 */
export function firstTokenDeadline(model: string, ms = TTFT_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`503 timeout: ${model} が ${ms}ms 以内に返事を始めませんでした`)),
      ms
    );
  });
  // 誰も待っていない reject で落ちないように握っておく
  expired.catch(() => {});
  return {
    /** 期限付きで待つ */
    race: <T>(p: Promise<T>) => Promise.race([p, expired]) as Promise<T>,
    /** 1 個目が来たら呼ぶ */
    disarm: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * 「混雑（503）」と「このモデルはもう使えない（404 / 枠切れ）」を区別する。
 *
 * どちらも isModelUnavailable は true を返すが、取るべき手が違う。
 * 503 は数百ミリ秒待てば同じモデルで通ることが多い。そこで諦めて別モデルへ
 * 降りると、いちばん品質のいいモデルを混雑のたびに手放すことになる。
 * 404 と枠切れは待っても直らないので、即座に次のモデルへ行く。
 */
function isBusyNow(error: unknown): boolean {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    m.includes("503") ||
    m.includes("high demand") ||
    m.includes("overloaded") ||
    m.includes("unavailable")
  );
}

/** 同じモデルで粘る回数（初回を含む）。 */
const BUSY_ATTEMPTS = 3;

/**
 * 「速く跳ね返された」と見なす時間。
 *
 * 本番のログで分かったこと: Gemini の 503 は返ってくるまでに 5 秒前後かかる。
 * つまり同じモデルで 3 回粘ると、それだけで 15 秒以上を 1 モデルに使い切り、
 * 残りの 8 モデルへ降りる前に締め切りへ達していた（実際にそうなった）。
 * 粘ったせいで、空いていたかもしれないモデルに一度も触れずに終わる。
 *
 * 遅い 503 は「そのモデルが本当に詰まっている」合図なので、待たずに次へ降りる。
 * 速く跳ね返されたときだけ、一時的な波とみなして粘る。
 */
const FAST_FAILURE_MS = 2_000;

export async function withModelFallback<T>(
  run: (model: string) => Promise<T>,
  /**
   * 使ってよい時間。省略すると既定の 25 秒。
   *
   * 呼び出し側が先に別のプロバイダを試している場合、その分を差し引いた
   * 残り時間を渡すこと。渡さないと Groq(15秒) + Gemini(25秒) で
   * maxDuration(30秒) を超え、丁寧なエラーではなく素の 504 が出る。
   */
  budgetMs?: number
): Promise<T> {
  // 9モデルを順に試すと、全滅に近いときに何分も待たせてしまう。実測で138秒
  // かかったことがあるので、全体の締め切りを設けて打ち切る。
  // 1 回の 503 に 5 秒前後かかるので、20 秒では 3〜4 モデルまでしか届かない。
  const deadline = Date.now() + Math.max(3_000, Math.min(25_000, budgetMs ?? 25_000));

  let lastError: unknown;
  for (const model of [MODEL, ...FALLBACK_MODELS]) {
    if (Date.now() > deadline) {
      console.warn("[gemini] 締め切りに達したのでモデルの切り替えを打ち切ります");
      break;
    }

    // 混雑しているだけなら、モデルを替える前に同じモデルで少し粘る。
    // Gemini の 503 は瞬間的な波であることが多く、1 秒も待てば通る。
    // ここが無かったので、波が来るたびに利用者へ
    // 「AI が混み合っています」が出ていた。
    for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        // 残り時間と 1 回あたりの上限の、短いほうで打ち切る。
        // こうしておけば締め切りを越えて待たされることがない。
        const budget = Math.max(1_000, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
        const result = await withTimeout(run(model), budget, model);
        record(model, true);
        return result;
      } catch (e) {
        lastError = e;
        if (!isModelUnavailable(e)) throw e; // モデルのせいでないならすぐ返す

        const took = Date.now() - startedAt;
        // 遅い 503 は本当に詰まっている合図。粘らずに次のモデルへ降りる。
        // ここを時間で切らないと、1 モデルで締め切りを使い切ってしまう。
        const busy = isBusyNow(e) && took < FAST_FAILURE_MS;
        const canRetry = busy && attempt < BUSY_ATTEMPTS - 1;
        if (!canRetry) {
          record(model, false);
          console.warn(
            `[gemini] ${model} が使えないので次のモデルを試します（${took}ms で失敗）`
          );
          break;
        }

        // 250ms → 600ms。同時に混雑を食らった利用者が足並みを揃えて
        // 殺到しないよう、待ち時間にばらつきを入れる。
        const wait = Math.round((250 + attempt * 350) * (0.7 + Math.random() * 0.6));
        if (Date.now() + wait > deadline) {
          record(model, false);
          break;
        }
        console.warn(`[gemini] ${model} が混雑。${wait}ms 待って同じモデルで再試行します`);
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

/**
 * 複数の Gemini API キーをラウンドロビンで使い分ける。
 *
 * 無料枠は1プロジェクト（1キー）あたりのレート制限なので、検索が集中すると
 * 429 で失敗することがある。GEMINI_API_KEY に加えて GEMINI_API_KEY_2,
 * GEMINI_API_KEY_3, ... を環境変数に足すと、リクエストのたびに順番に
 * キーを切り替えて負荷を分散する（1キーだけの場合は従来どおり単一キーで動く）。
 */
/** GEMINI_API_KEY_2 .. _30 まで探す。これ以上は現実的に使わない。 */
const MAX_KEY_INDEX = 30;

interface KeySlot {
  client: GoogleGenAI;
  /**
   * 鍵そのものが使えない期限（0 は健全）。
   * クレジット切れなど、どのモデルを選んでも直らない事情だけをここに入れる。
   */
  deadUntil: number;
  /**
   * モデルごとの枠切れの期限。model -> この時刻まではこの鍵でそのモデルを使わない。
   *
   * 無料枠はモデルごとに別勘定なので、3.6-flash を使い切っても 3.8-flash の枠は
   * 丸ごと残っている。以前は 429 を受けると鍵ごと 60 秒止めていたため、
   * **残っている枠に手が届かなくなっていた**（コード自身のコメントが想定していた
   * 「このモデルは諦めて次のモデルへ」と矛盾していた）。
   */
  modelDeadUntil: Map<string, number>;
  /**
   * モデルごとの 429 の連続回数。休ませる時間を段階的に伸ばすために数える。
   *
   * 429 の本文は「Please retry in 27.7s」のように待ち時間を教えてくれるが、
   * それが分あたりの制限（RPM 5）なのか 1 日の上限（RPD 20）なのかは
   * 書いていない。1 日の上限に 27 秒後に再挑戦しても必ず失敗するので、
   * 本文を鵜呑みにすると**その日いっぱい無駄打ちを続ける**ことになる。
   * 文言ではなく「何回続けて弾かれたか」で判断する。
   */
  modelStrikes: Map<string, { count: number; at: number }>;
}

let slots: KeySlot[] | null = null;
let roundRobinIndex = 0;

function loadSlots(): KeySlot[] {
  if (slots) return slots;

  const keys: string[] = [];
  const primary = process.env.GEMINI_API_KEY?.trim();
  if (primary) keys.push(primary);
  // 抜け番があっても止まらないように、決まった範囲を最後まで見る。
  // 以前は最初の空きで break していたため、本番に _2.._5 と _7.._12 が
  // 入っていたときに 5 本しか読めず、容量が半分以下になっていた。
  for (let i = 2; i <= MAX_KEY_INDEX; i++) {
    const extra = process.env[`GEMINI_API_KEY_${i}`]?.trim();
    if (extra) keys.push(extra);
  }

  if (keys.length === 0) {
    throw new Error("GEMINI_API_KEY が設定されていません（サーバー環境変数）。");
  }

  slots = keys.map((apiKey) => ({
    client: new GoogleGenAI({ apiKey }),
    deadUntil: 0,
    modelDeadUntil: new Map<string, number>(),
    modelStrikes: new Map<string, { count: number; at: number }>(),
  }));
  return slots;
}

/** 現在使えるキーの本数（全滅していれば 0）。 */
export function healthyKeyCount(): number {
  const now = Date.now();
  return loadSlots().filter((s) => s.deadUntil <= now).length;
}

/** その鍵で、そのモデルがいま使えるか。 */
function usable(slot: KeySlot, model: string | undefined, now: number): boolean {
  if (slot.deadUntil > now) return false;
  if (!model) return true;
  return (slot.modelDeadUntil.get(model) ?? 0) <= now;
}

/**
 * ラウンドロビンで次の「そのモデルに使える」キーのクライアントを返す。
 *
 * model を渡すと、そのモデルの枠を使い切った鍵を飛ばす。枠はモデルごとなので、
 * 他のモデルではその鍵を引き続き使う。
 */
export function getClient(model?: string): GoogleGenAI {
  const pool = loadSlots();
  const now = Date.now();

  // 1周だけ回して使えるキーを探す
  for (let i = 0; i < pool.length; i++) {
    const slot = pool[roundRobinIndex % pool.length];
    roundRobinIndex = (roundRobinIndex + 1) % pool.length;
    if (usable(slot, model, now)) return slot.client;
  }

  // 全部だめなときは、いちばん早く復帰するキーで一応試す
  return pool.reduce((a, b) => (a.deadUntil <= b.deadUntil ? a : b)).client;
}

/**
 * 呼び出しが失敗したキーを一時的に外す。
 *
 * クレジット切れ（402）や課金上限超過は日をまたぐまで直らないことが多いので
 * 長めに、レート制限（429）は短めに休ませる。キーを増やしていても、死んだ
 * キーがローテーションに残っていると一定割合のリクエストが失敗し続けるため、
 * これが無いと「12本挿したのに時々失敗する」状態になる。
 */
/**
 * 429 の本文に入っている待ち時間を読む。
 *
 * 例: "Please retry in 21.306676539s."
 * 分あたりの制限なら数十秒、1日の上限なら長い値が返る。Google が言ってきた
 * 時間をそのまま使うのが、決め打ちよりずっと正確。
 */
function parseRetryAfterMs(message: string): number | null {
  const m = message.match(/retry in ([\d.]+)s/i);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
}

/** 1日の上限に当たったか（分あたりの制限と区別する）。 */
function isDailyLimit(message: string): boolean {
  return /per\s*day|perday|requests_per_day|\bdaily\b/i.test(message);
}

/**
 * 同じ鍵×モデルで 429 が続いたときに休ませる時間。
 *
 * 1 回目は分あたりの制限のことが多いので短く。繰り返すなら 1 日の上限を
 * 使い切ったと考えて、その日のうちは触らない側へ寄せていく。
 */
const BACKOFF_STEPS_MS = [
  60 * 1000,          // 1分
  5 * 60 * 1000,      // 5分
  30 * 60 * 1000,     // 30分
  2 * 60 * 60 * 1000, // 2時間
  6 * 60 * 60 * 1000, // 6時間
];

/** これだけ間が空いたら、連続とは見なさず数え直す。 */
const STRIKE_FORGET_MS = 6 * 60 * 60 * 1000;

/** 1日の上限だと分かっている場合の下限（分あたりの制限と混ぜない）。 */
const DAILY_FLOOR_MS = 30 * 60 * 1000;

/**
 * 通った実績を記録して、罰を解く。
 *
 * 枠が回復したのに古い戦績で長く休ませ続けると、せっかくの容量を捨てることになる。
 */
/**
 * その鍵×モデルの休みが明ける時刻（ミリ秒）。休んでいなければ 0。
 * 検証スクリプトと /api/health から状態を覗くためのもの。
 */
export function modelPausedUntil(client: GoogleGenAI, model: string): number {
  const slot = loadSlots().find((s) => s.client === client);
  return slot?.modelDeadUntil.get(model) ?? 0;
}

export function reportKeySuccess(client: GoogleGenAI, model?: string): void {
  if (!model) return;
  const slot = loadSlots().find((s) => s.client === client);
  if (!slot) return;
  slot.modelStrikes.delete(model);
  slot.modelDeadUntil.delete(model);
}

export function reportKeyFailure(client: GoogleGenAI, error: unknown, model?: string): void {
  const slot = loadSlots().find((s) => s.client === client);
  if (!slot) return;

  const message = describeError(error);
  const now = Date.now();

  if (isDepleted(message)) {
    // クレジット切れ・課金上限は鍵そのものの問題。どのモデルでも直らない
    slot.deadUntil = now + 6 * 60 * 60 * 1000;
    return;
  }

  if (isRateLimited(message)) {
    const told = parseRetryAfterMs(message) ?? 0;

    if (!model) {
      // モデルが分からない場合だけは従来どおり鍵ごと（安全側）
      slot.deadUntil = now + Math.max(60 * 1000, told);
      return;
    }

    // 枠はモデルごとに別勘定なので、鍵ごと止めない。そのモデルだけ休ませる。
    const prev = slot.modelStrikes.get(model);
    const count = prev && now - prev.at < STRIKE_FORGET_MS ? prev.count + 1 : 1;
    slot.modelStrikes.set(model, { count, at: now });

    let wait = BACKOFF_STEPS_MS[Math.min(count, BACKOFF_STEPS_MS.length) - 1];
    // 1日の上限だと本文から分かるなら、最初から長めに休ませる
    if (isDailyLimit(message)) wait = Math.max(wait, DAILY_FLOOR_MS);
    // Google が言ってきた時間より短く再挑戦しても無駄
    wait = Math.max(wait, told);

    slot.modelDeadUntil.set(model, now + wait);
  }
  // 503（モデルの混雑）はキーの問題ではないので、キーは殺さない
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function isDepleted(message: string): boolean {
  return (
    message.includes("credits are depleted") ||
    message.includes("spending cap") ||
    message.includes("billing") ||
    message.includes("402")
  );
}

function isRateLimited(message: string): boolean {
  return message.includes("429") || message.includes("resource_exhausted");
}

/**
 * モデル側が混んでいるだけで、キーを替えても直らない類のエラーか。
 * 503 UNAVAILABLE は数秒待てば通ることが多い。
 */
function isTransient(message: string): boolean {
  return (
    message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("overloaded")
  );
}

/**
 * 生きているキーを順に試して、最初に成功した結果を返す。
 *
 * 失敗の種類で対応を分ける。
 *  - キーの問題（402 / 429）… そのキーを一時的に外し、次のキーで引き直す
 *  - モデルの混雑（503）… キーを替えても無駄なので、少し待って再試行する
 *  - それ以外（入力不正など）… 即座に投げ返す。粘っても直らない
 *
 * 503 をそのまま失敗させると、一時的な混雑でユーザーに「AI の応答に
 * 失敗しました」が出る。有料で使ってもらう以上ここは粘る。ただし待ちすぎても
 * 体験が悪いので、混雑での再試行は合計3秒程度までにとどめる。
 */
export async function withKeyFailover<T>(
  fn: (ai: GoogleGenAI) => Promise<T>,
  /**
   * いま試しているモデル。枠切れをモデル単位で記録するために要る。
   * 省略すると鍵ごと休ませる古い挙動になるので、呼び出し側は必ず渡すこと。
   */
  model?: string
): Promise<T> {
  const keyAttempts = Math.max(1, Math.min(loadSlots().length, 3));
  let lastError: unknown;

  for (let i = 0; i < keyAttempts; i++) {
    const ai = getClient(model);
    try {
      const result = await fn(ai);
      reportKeySuccess(ai, model);
      return result;
    } catch (e) {
      lastError = e;
      const message = describeError(e);

      // 混雑（503）はキーを替えても直らない。待つよりモデルを替えるほうが
      // 速いので、ここでは粘らずに投げ返して withModelFallback に任せる。
      if (isTransient(message)) throw e;

      if (isDepleted(message) || isRateLimited(message)) {
        reportKeyFailure(ai, e, model);
        continue;
      }
      throw e; // 入力不正などは粘っても直らない
    }
  }
  throw lastError;
}

export type ModeSlug = "gen" | "aca";

export function modeLabel(mode: ModeSlug): string {
  return mode === "aca" ? "学術（Academic）" : "一般";
}

const wordRelation = {
  type: Type.OBJECT,
  properties: {
    word: { type: Type.STRING },
    translation: { type: Type.STRING },
  },
  required: ["word", "translation"],
} as const;

/**
 * WordDetail の構造化出力スキーマ。
 *
 * **生成順は propertyOrdering で決まる。** JS のオブジェクトのキー順ではない。
 * これを指定しないと Gemini は自分の都合で並べる（実測すると、末尾に置いた
 * senses が nuance より先に生成されていた）。詳細ページで先に読まれる
 * 「意味 → 使い分け → 語源」を先に出し、画面に出ない単語帳用の項目
 * （senses / targetPhrases / derivatives）は最後に回す。
 */
export const WORD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    // 先に返ってほしい軽い項目を前に置く（ストリーミングで早く表示するため）
    word: { type: Type.STRING },
    meaning: { type: Type.STRING },
    grammar: { type: Type.STRING },
    phonetic: { type: Type.STRING },
    // --- ここから下は「詳細ページに出る順」に並べてある ---
    //
    // 構造化出力はプロパティの並び順にそのまま生成される。つまり
    // 並び順がそのまま「画面に出る順」になる。
    // 以前は単語帳用の重い項目（senses / targetPhrases / derivatives）が
    // ここに挟まっていたため、詳細ページで先に読まれる「使い分け」と
    // 「語源」が、画面に出ない項目の生成を待たされていた。
    // 読む順に合わせて並べ直す。
    category: { type: Type.STRING },
    nuance: { type: Type.STRING },
    etymology: { type: Type.STRING },
    specializedContexts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          field: { type: Type.STRING },
          context: { type: Type.STRING },
        },
        required: ["field", "context"],
      },
    },
    // 和訳を必ず伴わせるため、"英文\n和訳" の1本の文字列ではなく組で返させる。
    // 文字列形式だと和訳が落ちることがあった（normalizeExamples は両形式に対応）。
    examples: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          en: { type: Type.STRING },
          ja: { type: Type.STRING },
        },
        required: ["en", "ja"],
      },
    },
    collocations: { type: Type.ARRAY, items: { type: Type.STRING } },
    synonyms: { type: Type.ARRAY, items: wordRelation },
    antonyms: { type: Type.ARRAY, items: wordRelation },

    // --- ここから下は画面の下のほう、または単語帳専用 ---
    // 先に出す必要がないので最後に回す。
    importanceScore: { type: Type.NUMBER },
    // 紙面（単語帳）で使う項目。左ページの中身なので早めに返してほしい
    senses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ja: { type: Type.STRING },
          pos: { type: Type.STRING },
        },
        required: ["ja"],
      },
    },
    targetPhrases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          en: { type: Type.STRING },
          ja: { type: Type.STRING },
        },
        required: ["en", "ja"],
      },
    },
    derivatives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          pos: { type: Type.STRING },
          meaning: { type: Type.STRING },
        },
        required: ["word", "pos", "meaning"],
      },
    },
    examLevel: { type: Type.STRING },
    etymologyNodes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          meaning: { type: Type.STRING },
          root: { type: Type.STRING },
          relation: { type: Type.STRING },
          importance: { type: Type.NUMBER },
        },
        required: ["word", "meaning", "root", "relation", "importance"],
      },
    },
  },
  // 生成順。詳細ページで上から読まれる順に並べる（画面に出ない項目は後ろ）
  propertyOrdering: [
    "word", "meaning", "grammar", "phonetic", "category",
    "nuance", "etymology", "specializedContexts", "examples",
    "collocations", "synonyms", "antonyms", "importanceScore",
    "etymologyNodes",
    // ここから下は単語帳の紙面専用。詳細ページには出ないので最後でよい
    "senses", "targetPhrases", "derivatives", "examLevel",
  ],
  required: [
    "word", "meaning", "grammar", "phonetic", "senses", "targetPhrases", "derivatives",
    "examLevel", "category", "nuance", "etymology",
    "importanceScore", "examples", "collocations", "synonyms", "antonyms",
    "specializedContexts", "etymologyNodes",
  ],
} as const;

/**
 * 見出し部分だけのスキーマ（意味・使い分けまで）。
 *
 * **いまは使っていない。** 一時期、これで「意味と使い分けだけ先に 1 秒で出す」
 * 構成にしていたが、1 検索につき生成が 2 回になり 1 日の容量が半分になるため
 * 1 回に戻した（api/lookup.ts の該当コメント参照）。
 *
 * 残してあるのは、「1 秒で意味を出す」を復活させたくなったときのため。
 * 使い分けを厚く書かせる指示自体は buildLookupPrompt に取り込み済みなので、
 * こちらを使わなくても中身は落ちない。
 */
export const HEAD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    word: { type: Type.STRING },
    phonetic: { type: Type.STRING },
    grammar: { type: Type.STRING },
    meaning: { type: Type.STRING },
    senses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { ja: { type: Type.STRING }, pos: { type: Type.STRING } },
        required: ["ja", "pos"],
      },
    },
    nuance: { type: Type.STRING },
  },
  propertyOrdering: ["word", "phonetic", "grammar", "meaning", "senses", "nuance"],
  required: ["word", "phonetic", "grammar", "meaning", "senses", "nuance"],
} as const;

/** HEAD_SCHEMA で作られる項目。マージのときにここだけ差し替える。 */
export const HEAD_FIELDS = ["word", "phonetic", "grammar", "meaning", "senses", "nuance"] as const;

/**
 * 見出し部分のプロンプト。
 *
 * 本体のプロンプトから切り出したのではなく、**使い分けを厚く書かせるために
 * 書き下ろした**もの。本体側の一行指示（semantic difference from synonyms）では
 * どのモデルでも「格式ばった語」程度で終わってしまい、実測でも薄かった。
 *
 * 実測（recall / obtain / brave）では、この指示を与えた Groq の出力が
 * 本体プロンプトの Gemini より明確に濃く、しかも 6〜10 倍速かった。
 */
export function buildHeadPrompt(word: string, mode: ModeSlug): string {
  const context =
    mode === "aca"
      ? "学術・研究の文脈での使われ方を優先する。専門分野で別の語義があるなら、分野名を（）で添えて必ず入れる。"
      : "日常のテキスト・会話・報道で出会う意味を優先する。狭い専門語義から書き始めない。";

  return `英単語 "${word}" の、辞書の見出し部分だけを作ってください。${context}

- word: 綴り。明らかな打ち間違いなら直し、そうでなければそのまま返す。
- phonetic: IPA。スラッシュは付けない。
- grammar: 動詞 / 名詞 / 形容詞 など。
- meaning: 旺文社「英単語ターゲット」の書き方。他動詞は「を」「に」で始める
  （例: を変える）。目的語の種類は「(人)」「(物)」で示す。「；」区切りで最大3つ。
  説明文や「〜という意味」は書かない。
- senses: 頻度順の語義。ja は上と同じ書き方。pos はその語義での品詞（動/名/形/副 の1文字）。
- nuance: **類義語を実名で 2〜3 語挙げ、それぞれと何が違うかを対比で書く。**
  「格式ばった語」のような抽象的な一言で終わらせない。
  「どんな場面で使い、どんな場面では使わないか」を必ず 1 文入れる。
  書き方の例:
  「remember が自然に思い浮かぶのに対し、recall は意識的に呼び起こす行為を指す。recollect は努力して断片をつなぐ含みがある。日常会話では remember が普通で、recall は報道や証言などやや硬い文脈に多い」
  1 文にまとめず、2〜3 文で具体的に書く。

すべて日本語。改行は入れない。`;
}

/**
 * 語源の文字列の後始末。
 *
 * どれだけプロンプトで禁じても、AI は時々「ラテン語 precarious」のように
 * **英語の綴りのまま古語のラベルを貼る**段を挟んでくる（precarius が正しい）。
 * 意味は合っていても学習者には嘘になるので、決め打ちで落とす。
 *
 * 落とすのは「古語のラベル ＋ 見出し語と同じ綴り」の段だけで、
 * 末尾の「英語 precarious」には触らない。
 */
export function sanitizeEtymology(word: string, text: unknown): string {
  if (typeof text !== "string" || !text.trim()) return typeof text === "string" ? text : "";
  const head = word.trim().toLowerCase();
  if (!head) return text;

  const langs = "ラテン語|古典ラテン語|後期ラテン語|ギリシャ語|古代ギリシャ語|古フランス語|中英語|古英語|印欧祖語";
  // 「ラテン語 precarious「…」→ 」を段ごと消す（矢印の前でも後ろでもよい）
  // 見出し語は英字だけのはずなので、そうでないときは何もしない（正規表現に
  // 特殊文字が混ざるのを避ける）。
  if (!/^[a-z][a-z-]*$/.test(head)) return text;
  const re = new RegExp(
    `(?:${langs})\\s*${head}(?:\\s*[「（(][^」）)]*[」）)])?\\s*(?:→\\s*)?`,
    "gi"
  );
  let out = text.replace(re, "");
  // 消したせいで矢印が連続したり、先頭に残ったりするのを均す
  out = out.replace(/→\s*→/g, "→").replace(/^\s*→\s*/, "").replace(/\s{2,}/g, " ").trim();
  // 段が 1 つも残らなかったら、いじらないほうがまし
  return out.length < 8 ? text : out;
}

export function buildLookupPrompt(
  word: string,
  mode: ModeSlug,
  options: { forceExactSpelling?: boolean } = {}
): string {
  const context = mode === "gen" ? "general everyday usage" : "academic and research contexts";

  const correctionRule = options.forceExactSpelling
    ? `Treat "${word}" as already correctly spelled. Do NOT change, "correct", or
substitute a different word for it under any circumstances, even if a longer or
more advanced word seems related or comes to mind. The "word" field in your
response must be exactly "${word}" (only case may be normalized).`
    : `"${word}" is very likely already a correct, valid English word — assume that
first. Only silently correct it if it is CLEARLY unusable as-is: a keyboard-adjacent
typo (e.g. "recieve" -> "receive", "beleive" -> "believe", "runing" -> "run") or an
inflected form you should lemmatize. A correction must stay close to the original
letters — never replace the input with an unrelated or much longer word just
because it seems more "advanced" or common in your training data. If "${word}" is
short (2-5 letters) and forms a real English word as typed (e.g. "map", "run",
"set", "bat"), you MUST look it up exactly as given and must NOT substitute any
other word. When genuinely uncertain whether a correction is warranted, do NOT
correct — look up the input exactly as typed. If you do correct it, the "word"
field in your response must contain the corrected spelling, not the original input.`;

  // 学術モードの差が「たまたま専門語義が混ざる」程度でしか出ていなかった。
  // 実測すると stress には「応力」が出るのに resolution では分野名が付かず、
  // 利用者から「一般と学術で同じでは？」と言われた。偶然に頼らず、
  // 分野の語義を必ず入れて、分野名を明示させる。
  const fieldRule =
    mode === "aca"
      ? `This word may carry a DISTINCT technical meaning in a specific academic
field (engineering, physics, medicine, statistics, linguistics, economics, ...).
If it does, you MUST include that sense, and prefix it with the field in
parentheses, e.g. "(工学) 応力，負荷" / "(統計) 有意な" / "(光学) 分解能".
Put the technical sense first when the word is most often encountered in papers
with that meaning. If the word genuinely has no field-specific sense, do not
invent one.`
      : `Prefer the meanings a learner meets in everyday text, conversation, and news.
Do NOT lead with a narrow technical sense.`;

  return `Look up the English word "${word}" specifically for ${context}.
Prioritize meanings in ${context}.

${fieldRule}

${correctionRule}

Write the Japanese exactly in the style of a Japanese university-entrance vocabulary
book (旺文社「英単語ターゲット」). This style is strict — follow it precisely:

* Transitive verbs start with the object particle: "を変える", "を学ぶ", "に尋ねる".
* Show the kind of object in parentheses: "(人)を手伝う", "(物)を与える".
* Separate near-synonymous wordings inside one sense with "，": "(人)を手伝う，助ける".
* Do NOT write a full sentence, a definition, or "〜という意味" — write only the gloss.

Provide:
- senses: the numbered meanings (①②③), most frequent first, 1-4 entries.
  Each { ja: the gloss in the style above, pos: 1-char part of speech such as
  動/名/形/副 only when it differs from the headword's main part of speech }.
  Example for "help": [{ja:"(人)を手伝う，助ける"},{ja:"(人)に役立つ"}]
- meaning: the same senses joined with "；" (kept for compatibility).
  Example for "change": "を変える；変わる；を替える"
- targetPhrases: 2-4 grammar patterns / collocations the word actually appears in,
  in the book's frame notation. Use A, B for noun slots, "do" for a bare infinitive,
  "doing" for a gerund, "~" for a free element.
  { en: the frame, ja: its Japanese reading WITHOUT 「」 }
  Examples:
    help  -> [{en:"help A with B", ja:"AのBを手伝う"},{en:"help ~ (to) do", ja:"〜するのを手伝う"}]
    learn -> [{en:"learn A from B", ja:"BからAを学ぶ"},{en:"learn about ~", ja:"〜について学ぶ"}]
    change-> [{en:"change one's life", ja:"〜の人生を変える"},{en:"change trains", ja:"乗り換える"}]
- derivatives: related forms of the SAME root (noun/adjective/adverb forms), 0-3 entries.
  { word, pos: one of 名/形/副/動, meaning: gloss in the same style }
  Example for "help": [{word:"help", pos:"名", meaning:"助け，手伝い"}]
- examLevel: one of 基礎 / 標準 / 難関 — how advanced this word is for entrance exams.
- grammar: part of speech in Japanese (動詞 / 名詞 / 形容詞 ...)
- phonetic: IPA pronunciation WITHOUT surrounding slashes (e.g. ˈtɜːbjələns)
- category: professional field (e.g. Mechanical Engineering, Finance, etc.)
- nuance: how this word differs from its near-synonyms, in Japanese.
  Name 2-3 actual synonyms and contrast each one. Do not settle for a vague
  single line such as 「格式ばった語」. Include one sentence on WHERE it is used
  and where it is not. Two or three sentences.
- etymology: the origin, in Japanese, as ONE single line with NO line breaks.
  This is the heart of the app, so it must be traced properly. Rules:
  (a) Go back to the OLDEST root you are confident about, and write the chain
      from oldest to newest, joined with "→". Never write it in reverse and
      never use "←": the arrow always points toward modern English.
  (b) Label every step with the language IN JAPANESE
      （印欧祖語 / ラテン語 / ギリシャ語 / 古フランス語 / 古英語）.
      Do not write "Latin", "PIE" or "Proto-Indo-European" in English.
  (c) Do NOT stop at a derived adjective or noun. If you name one, go back to
      the verb or base word it came from. This is the most common failure.
  (d) A Latin or Greek step must NEVER be spelled the same as the English word.
      If the form you are about to write is identical to the English headword,
      it is wrong — write the real classical form instead
      （precarious → precarius 、turbulence → turbulentia 、deficient → deficiens）.
      English endings (-ous / -ious / -ary / -al / -ence / -ent) belong to English.
  (e) If a step is uncertain, leave it out rather than inventing a form.
  (f) If the word is BUILT FROM PARTS (prefix + stem, or two stems), break it
      apart and gloss EVERY part in Japanese before joining them with ＋.
      This is what the learner actually wants to see.
      例: ラテン語 de-「下に・離れて」＋facere「作る・する」
  (h) An asterisk (*) marks a reconstructed form and is allowed ONLY on 印欧祖語
      steps. A starred Latin or Greek form means you are guessing — drop that
      step. A SHORT but correct chain beats a long invented one.
  (g) ALWAYS end with one short sentence, still on the same line, shaped
      「【部品を組み合わせたときの字義】から、【今の意味】を意味する。」
      The first half must be the LITERAL picture the parts paint, not the modern
      definition. The two halves must NOT be the same words — if they are, you
      have skipped the interesting part.
      誤: 「不足している」から、不足していることを意味する。（同じことを 2 回言っている）
      正: 「完全に作り上げられていない」から、不足していることを意味する。
      Never end on the bare chain.
  Three examples at the required depth (each ONE line, oldest first):
  ラテン語 de-「下に・離れて」＋facere「作る」→ ラテン語 deficere「欠ける」→ ラテン語 deficiens「欠けている」→ 英語 deficient。「完全に作り上げられていない」から、不足していることを意味する。
  印欧祖語 *twer-「かき回す」→ ラテン語 turba「群衆・混乱」→ turbare「かき乱す」→ turbulentus「乱れやすい」→ 英語 turbulence。かき乱されやすいということから、気流や情勢の「乱れ」を指す。
  印欧祖語 *bʰreg-「壊す」→ ラテン語 frangere「壊す」→ fragilis「壊れやすい」→ 古フランス語 fragile → 英語 fragile。力を加えると壊れてしまうことから、「もろい」を意味する。
- etymologyNodes: words that share the SAME core root as this word.
  The "root" field must be the **content word at the heart of the chain**
  (the verb or noun), not a prefix or a suffix. For "obstacle" the root is
  stare, not ob-. Keep the same root spelling across all nodes of a word so
  that they group together. Each node carries an 'importance' score (0.0-1.0)
  for an English/IELTS/Engineering learner.
- examples: 3 entries of { en: an English sentence, ja: its Japanese translation }.
  Both fields are required — never leave ja empty.
  The FIRST example must use the first sense, must contain "${word}" (any inflected
  form is fine), and must be a natural full sentence of 6-14 words.
  Its ja must translate the sense using the same wording as senses[0] so that the
  corresponding part of the Japanese sentence is recognisable.
- collocations: 5 common English verb/noun pairings
- synonyms/antonyms: 3 pairs each with Japanese translations
- specializedContexts: 3 fields with concise Japanese usage explanations
- importanceScore: 0.0 to 1.0 overall importance for English/IELTS/Engineering learners.`;
}

/**
 * gemini-3.8-flash では thinkingBudget が非推奨のため thinkingLevel を使う。
 * MINIMAL は 3.8-flash では無効な値なので、最速設定は LOW。
 */
export const FAST_THINKING = { thinkingLevel: ThinkingLevel.LOW };
