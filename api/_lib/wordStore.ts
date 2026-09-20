/**
 * `words` コレクションへの保存（サーバー専用）。
 *
 * 無料プランの保存語数を本当に制限するには、ここを通すしかない。
 * Firestore のセキュリティルールには**コレクション内の件数を数える機能が無い**ため、
 * クライアントから直接 addDoc させている限り「30語まで」は強制できない。
 * ルール側で `words` の作成を禁止し、サービスアカウントを持つこのモジュール
 * だけが書き込む。
 *
 * 読み取りと更新・削除はこれまで通りクライアントが直接行う（onSnapshot の
 * 購読をそのまま使いたいため）。制限に関わるのは「増やす」操作だけなので、
 * 作成経路だけを塞げば足りる。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };
import { getServiceAccessToken } from "./googleAuth.js";

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const DB_PATH = `projects/${PROJECT_ID}/databases/${DATABASE_ID}`;

/** JS の値を Firestore REST の表現に変換する。 */
export function toFirestoreValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  if (typeof v === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(val);
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

/**
 * その人が今いくつ保存しているかを数える。
 *
 * 全件取得すると語数が増えるほど重くなるので、集計クエリ（COUNT）を使う。
 * 読み取り課金も1件分で済む。
 */
export async function countSavedWords(uid: string): Promise<number> {
  const token = await getServiceAccessToken();
  const res = await fetch(`https://firestore.googleapis.com/v1/${DB_PATH}/documents:runAggregationQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: {
          from: [{ collectionId: "words" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "userId" },
              op: "EQUAL",
              value: { stringValue: uid },
            },
          },
        },
        aggregations: [{ alias: "total", count: {} }],
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`保存語数の集計に失敗しました: ${res.status} ${await res.text()}`);
  }

  const rows = (await res.json()) as { result?: { aggregateFields?: { total?: { integerValue?: string } } } }[];
  const total = rows.find((r) => r.result?.aggregateFields?.total)?.result?.aggregateFields?.total;
  return Number(total?.integerValue ?? 0);
}

/**
 * 複数の単語をまとめて作成する。
 *
 * Firestore の commit は1回500件まで。呼び出し側で上限を守る前提だが、
 * 念のためここでも分割する。
 */
export async function createWords(uid: string, docs: Record<string, unknown>[]): Promise<number> {
  if (docs.length === 0) return 0;
  const token = await getServiceAccessToken();
  let written = 0;

  for (let i = 0; i < docs.length; i += 400) {
    const chunk = docs.slice(i, i + 400);
    const writes = chunk.map((doc) => {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries({ ...doc, userId: uid })) {
        fields[k] = toFirestoreValue(v);
      }
      // ドキュメント ID は Firestore に採番させる（クライアントの addDoc と同じ挙動）
      return {
        update: {
          name: `${DB_PATH}/documents/words/${crypto.randomUUID().replace(/-/g, "")}`,
          fields,
        },
        currentDocument: { exists: false },
      };
    });

    const res = await fetch(`https://firestore.googleapis.com/v1/${DB_PATH}/documents:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes }),
    });
    if (!res.ok) {
      throw new Error(`単語の保存に失敗しました: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    written += chunk.length;
  }

  return written;
}
