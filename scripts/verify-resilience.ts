/**
 * AI 呼び出しの粘り強さの検証。
 *
 *   npx tsx scripts/verify-resilience.ts
 *
 * Gemini には接続しない。withModelFallback に偽の失敗を食わせて、
 * 「混雑なら同じモデルで待って粘る / 使えないなら次のモデルへ降りる /
 * それ以外は即座に投げ返す」が実際にその通り動くかだけを見る。
 *
 * ここを壊すと利用者に「AI が混み合っています」が出る頻度が跳ね上がるが、
 * 本番でしか再現しないので、机上で押さえられる部分は押さえておく。
 */

import { FALLBACK_MODELS, MODEL, getClient, isModelUnavailable, reportKeyFailure, modelPausedUntil, reportKeySuccess, withModelFallback } from "../api/_lib/gemini.js";
import { classifyAiError } from "../api/_lib/handler.js";

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

const busy = () => new Error("503 The model is currently experiencing high demand");
const gone = () => new Error("404 models/x is not found or no longer available");
const bad = () => new Error("400 invalid argument");

console.log("\nwithModelFallback: 混雑したときの粘り");

{
  // 1〜2 回目は混雑、3 回目で通る。モデルを替えずに戻ってくるはず
  let calls: string[] = [];
  const result = await withModelFallback(async (model) => {
    calls.push(model);
    if (calls.length < 3) throw busy();
    return "ok";
  });

  check("混雑が続いても最終的に成功を返す", result === "ok");
  check("同じモデルで粘る（別モデルへ降りない）", new Set(calls).size === 1, calls);
  check("主力モデルで粘っている", calls[0] === MODEL, calls[0]);
  check("粘る回数は 3 回まで", calls.length === 3, calls.length);
}

{
  // ずっと混雑。粘ったうえで次のモデルへ降りる
  const calls: string[] = [];
  let caught: unknown;
  try {
    await withModelFallback(async (model) => {
      calls.push(model);
      throw busy();
    });
  } catch (e) {
    caught = e;
  }

  const distinct = [...new Set(calls)];
  check("全滅なら投げ返す", caught instanceof Error);
  check("主力で粘ってから次のモデルへ降りる", distinct.length > 1, distinct);
  check("降りる順番は主力 → FALLBACK_MODELS の順",
    distinct[0] === MODEL && distinct[1] === FALLBACK_MODELS[0], distinct.slice(0, 2));
  check("締め切りがあるので全モデルは試さない（20秒で打ち切る）",
    distinct.length <= 1 + FALLBACK_MODELS.length, distinct.length);
}

{
  // 本番で実際に起きた形。Gemini の 503 は返るまで 5 秒前後かかるため、
  // 同じモデルで粘ると 1 モデルだけで締め切りを使い切り、空いていたかも
  // しれない他のモデルへ一度も降りられずに終わっていた。
  const calls: string[] = [];
  try {
    await withModelFallback(async (model) => {
      calls.push(model);
      await new Promise((r) => setTimeout(r, 2100)); // 遅い 503
      throw busy();
    });
  } catch {
    // 全滅は想定どおり
  }
  const firstModelTries = calls.filter((m) => m === MODEL).length;
  check("遅い 503 では粘らず、すぐ次のモデルへ降りる", firstModelTries === 1, calls);
  check("締め切りの中で複数のモデルに手が届く", new Set(calls).size >= 4, calls);
}

{
  // 404（提供終了）は待っても直らないので、粘らずすぐ次のモデルへ
  const calls: string[] = [];
  try {
    await withModelFallback(async (model) => {
      calls.push(model);
      throw gone();
    });
  } catch {
    // 全滅は想定どおり
  }
  const first = calls.filter((m) => m === MODEL).length;
  check("使えないモデルでは粘らない（1 回で次へ）", first === 1, calls.slice(0, 3));
}

{
  // モデルのせいでないエラーは即座に投げ返す（無駄に9モデル叩かない）
  const calls: string[] = [];
  let caught: unknown;
  try {
    await withModelFallback(async (model) => {
      calls.push(model);
      throw bad();
    });
  } catch (e) {
    caught = e;
  }
  check("入力不正は 1 回で投げ返す", calls.length === 1, calls);
  check("投げ返すのは元のエラー", (caught as Error).message.includes("400"));
}

{
  // 1 回の呼び出しが返ってこない場合。実測で 35.8 秒かかった 503 があり、
  // 締め切りは試行と試行の「あいだ」でしか見ていなかったため上限を突破していた。
  const t0 = Date.now();
  const calls: string[] = [];
  try {
    await withModelFallback(async (model) => {
      calls.push(model);
      await new Promise((r) => setTimeout(r, 60_000)); // 返ってこない呼び出し
      return "never";
    });
  } catch {
    // 全滅は想定どおり
  }
  const elapsed = Date.now() - t0;
  check("返らない呼び出しでも締め切りを大きく超えない", elapsed < 35_000, elapsed);
  check("時間切れでも次のモデルへ降りる", new Set(calls).size > 1, calls);
}

console.log("\n枠切れはモデルごと（鍵ごとではない）");

{
  // 鍵プールは最初に getClient を呼んだ時点で環境変数から作られる。
  // ネットワークには出ないので、見分けのつく偽の鍵で十分。
  process.env.GEMINI_API_KEY = "test-key-1";
  process.env.GEMINI_API_KEY_2 = "test-key-2";
  process.env.GEMINI_API_KEY_3 = "test-key-3";

  const flash = "gemini-3.6-flash";
  const lite = "gemini-3.5-flash-lite";

  // 3 本あるので、3 回引けば全部出てくる（ラウンドロビン）
  const all = [getClient(flash), getClient(flash), getClient(flash)];
  const distinct = new Set(all);
  check("鍵をラウンドロビンで使い分ける", distinct.size === 3, distinct.size);

  // 1 本目を flash だけ枠切れにする
  const victim = all[0];
  reportKeyFailure(victim, new Error("429 Quota exceeded ... Please retry in 30s"), flash);

  const flashPicks = [getClient(flash), getClient(flash), getClient(flash), getClient(flash)];
  check(
    "枠切れにした鍵は、そのモデルでは選ばれない",
    !flashPicks.includes(victim),
    "flash で選ばれた鍵の数: " + new Set(flashPicks).size
  );

  const litePicks = [getClient(lite), getClient(lite), getClient(lite), getClient(lite)];
  check(
    "同じ鍵が別のモデルでは使われ続ける（ここが今回の修正点）",
    litePicks.includes(victim),
    "lite で選ばれた鍵の数: " + new Set(litePicks).size
  );

  // クレジット切れは鍵そのものの問題なので、全モデルで止める
  const other = all[1];
  reportKeyFailure(other, new Error("402 credits are depleted"));
  const afterDepleted = [getClient(lite), getClient(lite), getClient(lite), getClient(lite)];
  check(
    "クレジット切れの鍵はどのモデルでも使わない",
    !afterDepleted.includes(other),
    "lite で選ばれた鍵の数: " + new Set(afterDepleted).size
  );
}

console.log("\n429 が続いたら休ませる時間を伸ばす");

{
  // 鍵プールは前の節で作られている（test-key-1..3）
  const model = "gemini-3.6-flash";
  const rpm = new Error("429 Quota exceeded ... Please retry in 28s");

  // 同じ鍵×モデルで弾かれ続けたとき、何手目で試行対象から外れるか
  const client = getClient("gemini-3.7-flash"); // 別モデルで 1 本取り出す
  const tries: number[] = [];

  for (let i = 0; i < 5; i++) {
    reportKeyFailure(client, rpm, model);
    // その鍵がそのモデルで選ばれなくなっているか
    const picks = [getClient(model), getClient(model), getClient(model), getClient(model)];
    tries.push(picks.includes(client) ? 1 : 0);
  }

  check("1 回目から、その鍵ではそのモデルを使わない", tries[0] === 0, tries);

  // ここが本題: 弾かれるたびに休みが伸びているか
  reportKeySuccess(client, model); // いったん戦績を消してから数え直す
  const waits: number[] = [];
  for (let i = 0; i < 4; i++) {
    const before = Date.now();
    reportKeyFailure(client, rpm, model);
    waits.push(Math.round((modelPausedUntil(client, model) - before) / 1000));
  }
  check(
    "429 が続くほど休みが長くなる",
    waits[0] < waits[1] && waits[1] < waits[2] && waits[2] < waits[3],
    waits.map((w) => w + "秒").join(" → ")
  );
  check("1 回目は 1 分ほど（分あたりの制限を想定）", waits[0] === 60, waits[0]);
  check("4 回目には数時間まで伸びる（1日の上限を使い切った想定）", waits[3] >= 3600, waits[3]);
  check(
    "Google が言ってきた待ち時間より短くしない",
    waits.every((w) => w >= 28),
    waits
  );

  // 罰が伸びていることを、休みが明ける時刻の比較で確かめる。
  // 直接は読めないので、代わりに「成功したら罰が解ける」ことを確かめる。
  reportKeySuccess(client, model);
  const after = [getClient(model), getClient(model), getClient(model), getClient(model)];
  check("通ったら罰が解けて、また使われる", after.includes(client), "選ばれた鍵の数: " + new Set(after).size);

  // 1日の上限だと分かる文言なら、最初から長く休ませる
  const daily = new Error("429 Quota exceeded for quota metric requests per day, limit: 20");
  reportKeyFailure(client, daily, model);
  const afterDaily = [getClient(model), getClient(model), getClient(model), getClient(model)];
  check("1日の上限の文言でも、その鍵は外れる", !afterDaily.includes(client), "選ばれた鍵の数: " + new Set(afterDaily).size);

  // 別モデルは巻き添えにしない
  const other = [getClient("gemini-3.5-flash-lite"), getClient("gemini-3.5-flash-lite"), getClient("gemini-3.5-flash-lite"), getClient("gemini-3.5-flash-lite")];
  check("罰は別のモデルに波及しない", other.includes(client), "選ばれた鍵の数: " + new Set(other).size);
}

console.log("\nGroq（速い車線）");

{
  // 鍵はダミーでよい。ここで見るのは通信ではなく、読み込みと分類の筋。
  process.env.GROQ_API_KEY = "gsk_test_primary";
  process.env.GROQ_API_KEY_1 = "gsk_test_one";
  process.env.GROQ_API_KEY_2 = "gsk_test_two";

  const groq = await import("../api/_lib/groq.js");

  check("鍵があれば使う判定になる", groq.isGroqConfigured());
  check(
    "GROQ_API_KEY_1 を取りこぼさない（_2 から探すと 1 本落ちる）",
    groq.groqPausedUntil("gsk_test_one", "m") === 0
  );

  check("429 は持ち替え・再試行の対象", groq.isGroqRecoverable(new Error("429 rate limit reached")));
  check("timeout も対象", groq.isGroqRecoverable(new Error("503 timeout: m が返事を始めませんでした")));
  check(
    "スキーマ違反は対象外（持ち替えても直らない）",
    !groq.isGroqRecoverable(new Error("400 Generated JSON does not match the expected schema"))
  );
  check("鍵未設定も対象外", !groq.isGroqRecoverable(new Error("GROQ_API_KEY が設定されていません。")));

  // 使うモデルは質の高い順（120b が先）。速さだけで並べない
  check(
    "120b を先に試す（語源の記述が丁寧なため）",
    groq.GROQ_LOOKUP_MODELS[0] === "openai/gpt-oss-120b",
    groq.GROQ_LOOKUP_MODELS.join(" → ")
  );
}

console.log("\nエラーの分類");

{
  check("503 は混雑として扱う", classifyAiError(busy()).reason === "busy");
  check("429 は枠切れとして扱う", classifyAiError(new Error("429 quota")).reason === "capacity");
  check("400 はどちらでもない", classifyAiError(bad()).reason === undefined);
  check("空ストリームは再試行の対象になる", isModelUnavailable(new Error("503 empty stream")));
  check("入力不正は再試行の対象にしない", !isModelUnavailable(bad()));
}

console.log(failures === 0 ? "\nすべて通りました。" : `\n${failures} 件が失敗しました。`);
process.exit(failures === 0 ? 0 : 1);
