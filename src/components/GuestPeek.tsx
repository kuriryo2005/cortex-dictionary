/**
 * ログインせずに 3 語まで引ける試し引き（実験 E2）。
 *
 * 引けるのは収録済みの語だけ（/api/peek は AI を呼ばない）。未収録の語は
 * 「ログインすると AI が解説を作る」と案内して登録へつなぐ。
 * 回数は端末ごとに数える。厳密な制限ではなく「試すのはここまで」の目安。
 */

import React, { useState } from "react";
import { ShareWord } from "./ShareWord";

const LIMIT = 3;
const STORAGE_KEY = "cortex_guest_peeks_v1";

interface PeekResult {
  found: boolean;
  word: string;
  meaning?: string;
  phonetic?: string;
  specializedContexts?: { field: string; context: string }[];
  nuance?: string;
  etymology?: string;
}

function readUsed(): number {
  try {
    return Math.max(0, Number(localStorage.getItem(STORAGE_KEY) ?? 0) || 0);
  } catch {
    return 0;
  }
}

function writeUsed(n: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // 保存できない環境でも試し引き自体は動かす
  }
}

/** 何を引けばいいか迷う人向け。どれも学術モードで違いが出る語。 */
const EXAMPLES = ["significant", "stress", "yield", "bias"];

export const GuestPeek: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const [input, setInput] = useState("");
  const [academic, setAcademic] = useState(true);
  const [used, setUsed] = useState(readUsed);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PeekResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const left = Math.max(0, LIMIT - used);

  const peek = async (raw: string) => {
    const word = raw.trim().toLowerCase();
    if (!word || loading) return;
    if (!/^[a-z][a-z' -]{1,63}$/.test(word)) {
      setError("英単語を入力してください。");
      return;
    }
    if (left <= 0) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/lookup?w=${encodeURIComponent(word)}&m=${academic ? "aca" : "gen"}`);
      const body = (await res.json().catch(() => ({}))) as PeekResult & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "いまは表示できません。");
        return;
      }
      setResult(body);
      // 見つかったときだけ数える。未収録で回数を減らすと試せないまま終わる
      if (body.found) {
        const next = used + 1;
        setUsed(next);
        writeUsed(next);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-10 border-l-2 border-[#2A5CFF] pl-5">
      <h2 className="text-sm font-black">ログインせずに試す</h2>
      <p className="mt-1 text-xs text-[#8A9199]">
        論文で引っかかった単語を入れてみてください（{LIMIT}語まで・残り{left}語）
      </p>

      {left > 0 ? (
        <form
          className="mt-4 flex flex-wrap items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void peek(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="例: significant"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-56 max-w-full border-b border-[#C4C9CE] bg-transparent py-2 text-base outline-none focus:border-[#2A5CFF]"
          />
          <label className="flex items-center gap-1.5 text-xs text-[#656E77]">
            <input type="checkbox" checked={academic} onChange={(e) => setAcademic(e.target.checked)} />
            学術モード
          </label>
          <button type="submit" disabled={loading} className="text-sm font-bold text-[#2A5CFF] disabled:opacity-50">
            {loading ? "引いています…" : "引く"}
          </button>
        </form>
      ) : (
        <p className="mt-4 text-sm">
          試し引きはここまでです。続きは無料登録で、1日30語まで引けます。
        </p>
      )}

      {left > 0 && !result && (
        <p className="mt-3 text-xs text-[#8A9199]">
          {EXAMPLES.map((w, i) => (
            <React.Fragment key={w}>
              {i > 0 && " / "}
              <button type="button" className="underline" onClick={() => { setInput(w); void peek(w); }}>
                {w}
              </button>
            </React.Fragment>
          ))}
        </p>
      )}

      {error && <p className="mt-3 text-xs text-[#C0392B]">{error}</p>}

      {result && result.found && (
        <div className="mt-6">
          <p className="text-2xl font-black">
            {result.word}
            {result.phonetic && <span className="ml-2 text-sm font-normal text-[#8A9199]">/{result.phonetic}/</span>}
          </p>
          <p className="mt-2 text-[15px]">{result.meaning}</p>
          {result.specializedContexts && result.specializedContexts.length > 0 && (
            <ul className="mt-4 space-y-2">
              {result.specializedContexts.map((c) => (
                <li key={c.field} className="text-sm leading-relaxed">
                  <span className="font-bold">({c.field})</span>{" "}
                  <span className="text-[#656E77]">{c.context}</span>
                </li>
              ))}
            </ul>
          )}
          {result.nuance && <p className="mt-4 text-sm leading-relaxed text-[#656E77]">{result.nuance}</p>}
          {result.etymology && (
            <p className="mt-2 text-xs leading-relaxed text-[#8A9199]">語源: {result.etymology}</p>
          )}
          <div className="mt-5">
            <ShareWord word={result.word} contexts={result.specializedContexts} meaning={result.meaning} />
          </div>
          <p className="mt-5 text-sm">
            例文・類義語・語源のつながりまで見るには{" "}
            <button type="button" onClick={onLogin} className="font-bold text-[#2A5CFF] underline">
              Google で無料登録
            </button>
          </p>
        </div>
      )}

      {result && !result.found && (
        <p className="mt-6 text-sm leading-relaxed">
          <strong className="font-black">{result.word}</strong> はまだ収録されていません。
          <button type="button" onClick={onLogin} className="ml-1 font-bold text-[#2A5CFF] underline">
            ログインすると
          </button>
          、その場で AI が解説を作ります（試し引きの回数は減っていません）。
        </p>
      )}
    </section>
  );
};
