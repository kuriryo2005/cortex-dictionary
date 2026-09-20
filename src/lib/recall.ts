/**
 * 想起テストの採点。
 *
 * これまでの復習はカードをめくって「思い出せたか」を自己申告するだけだった。
 * 自己申告は甘くなる。見れば分かる（再認）と、何も無いところから出てくる
 * （想起）の差は大きく、試験で要るのは後者なので、綴りを打たせて機械的に
 * 判定する経路を足す。
 *
 * 判定は 3 段階にする。完全一致だけを正解にすると、冠詞や大文字、
 * 綴りの 1 文字違いで折れてしまい、続かない。
 */

export type Judgement = "correct" | "close" | "wrong";

/** 比較用に均す。大小・前後の空白・記号・連続空白を落とす。 */
export function normalizeAnswer(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.,!?;:"'’”“()[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** レーベンシュタイン距離。上限を越えたら早期に打ち切る。 */
export function editDistance(a: string, b: string, limit = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev = row;
  }

  return prev[b.length];
}

/**
 * 許容する綴りのずれ。短い語ほど厳しくする。
 * "cat" と "cut" を正解にしてしまうと意味がない。
 */
function tolerance(length: number): number {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

export function judge(input: string, expected: string): Judgement {
  const a = normalizeAnswer(input);
  const b = normalizeAnswer(expected);
  if (!a) return "wrong";
  if (a === b) return "correct";

  const d = editDistance(a, b, 3);
  return d <= tolerance(b.length) ? "close" : "wrong";
}

/**
 * 答えのどこが違うかを文字単位で示す。
 * 「おしい」と言われるだけでは、どこを直せばいいか分からない。
 */
export function diffChars(input: string, expected: string): { ch: string; ok: boolean }[] {
  const a = normalizeAnswer(input);
  const b = normalizeAnswer(expected);
  return [...b].map((ch, i) => ({ ch, ok: a[i] === ch }));
}

/**
 * 最初の 1 文字だけ見せるヒント。
 * 完全に出てこないときに全部見せてしまうと、想起の機会が消える。
 */
export function initialHint(word: string): string {
  const w = String(word ?? "").trim();
  if (!w) return "";
  if (w.length <= 2) return w[0] ?? "";
  return `${w[0]}${"·".repeat(Math.max(1, w.length - 2))}${w[w.length - 1]}`;
}
