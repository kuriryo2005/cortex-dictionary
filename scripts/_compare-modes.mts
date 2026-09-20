/**
 * 一般モードと学術モードで、本当に違う答えが返るのかを測る。
 *
 * このアプリの売りは「分野ごとの用法が出ること」。もし両モードが同じ答えを
 * 返すなら、その売りは成立していない。感覚で決めず、実際に引いて比べる。
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { buildLookupPrompt, withKeyFailover, withModelFallback, MODEL } from "../api/_lib/gemini.js";

const WORDS = process.argv.slice(2).length ? process.argv.slice(2) : ["stress", "resolution", "significant", "capacity", "novel"];

async function lookup(word: string, mode: "gen" | "aca") {
  const res = await withModelFallback((model) =>
    withKeyFailover((ai) =>
      ai.models.generateContent({
        model,
        contents: buildLookupPrompt(word, mode),
        config: { responseMimeType: "application/json" },
      })
    )
  );
  try {
    return JSON.parse(res.text ?? "{}");
  } catch {
    return {};
  }
}

for (const w of WORDS) {
  // 並列で叩くと混雑（503）を自分で引き起こすので、順番に引く
  const gen = await lookup(w, "gen");
  const aca = await lookup(w, "aca");
  const g = String(gen.meaning ?? "");
  const a = String(aca.meaning ?? "");
  const same = g === a;
  console.log(`\n=== ${w} ===  ${same ? "★ 完全に同一 ★" : "差あり"}`);
  console.log(`  一般: ${g}`);
  console.log(`  学術: ${a}`);
  const gp = (gen.targetPhrases ?? []).map((p: any) => p.en).join(" / ");
  const ap = (aca.targetPhrases ?? []).map((p: any) => p.en).join(" / ");
  if (gp || ap) {
    console.log(`  句(一般): ${gp}`);
    console.log(`  句(学術): ${ap}`);
  }
}
