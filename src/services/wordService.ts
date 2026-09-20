/**
 * 単語の保存。
 *
 * 以前はクライアントから Firestore に直接 addDoc していたが、それでは
 * 無料プランの「保存は30語まで」を守らせられない（セキュリティルールでは
 * コレクションの件数を数えられないため）。保存だけサーバー経由にした。
 * 読み取り・更新・削除はこれまで通りクライアントから直接行う。
 */

import { auth } from "../firebase";

export class SaveLimitError extends Error {
  readonly upgradable: boolean;
  constructor(message: string, upgradable: boolean) {
    super(message);
    this.name = "SaveLimitError";
    this.upgradable = upgradable;
  }
}

export type SaveSource = "search" | "extract" | "restore";

export interface SaveResult {
  written: number;
  /** 保存後の総数。Pro（無制限）のときは null。 */
  saved: number | null;
  limit: number | null;
}

export async function saveWords(
  words: Record<string, unknown>[],
  source: SaveSource = "search"
): Promise<SaveResult> {
  const user = auth.currentUser;
  if (!user) throw new Error("ログインが必要です。");

  const res = await fetch("/api/save-words", {
    method: "POST",
    headers: {
      authorization: `Bearer ${await user.getIdToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ words, source }),
  });

  const detail = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    upgradable?: boolean;
    written?: number;
    saved?: number | null;
    limit?: number | null;
  };

  if (!res.ok) {
    const message = String(detail.error ?? "保存に失敗しました。");
    // 403 は上限か Pro 限定。呼び出し側でアップグレード画面を出せるようにする
    if (res.status === 403) throw new SaveLimitError(message, detail.upgradable === true);
    throw new Error(message);
  }

  return {
    written: detail.written ?? words.length,
    saved: detail.saved ?? null,
    limit: detail.limit ?? null,
  };
}
