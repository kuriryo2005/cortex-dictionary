/**
 * 課金プランの判定。
 *
 * 契約状態は Firestore の `subscriptions/{uid}` に置く。書き込みは Stripe
 * Webhook（サービスアカウント経由）だけが行い、`firestore.rules` 側で
 * ユーザーからの書き込みを全面禁止しているため、本人が自分を Pro に
 * 書き換えることはできない。読み取りは本人に許可しているので、ここでは
 * quota.ts と同じく「検証済みの本人 ID トークン」をそのまま使い回す。
 *
 * 読み取りに失敗したときは free として扱う（上限が厳しくなる側に倒す）。
 */

import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

export type PlanId = "free" | "pro";

/**
 * 実費が発生する AI 呼び出しの種類。エンドポイントごとにカウンタを分ける。
 * - `lookup`  … 単語検索（/api/lookup）
 * - `extract` … 英文からの一括抽出（/api/extract）。最大8,000字を処理するので最も高い
 * - `story`   … 語源ストーリー（/api/story, /api/expand-root）
 * - `review`  … 復習コメントと発音記号の補完（/api/review-analysis, /api/phonetic）。軽い
 */
export type QuotaBucket = "lookup" | "extract" | "story" | "review";

export interface QuotaLimit {
  day: number;
  week: number;
  month: number;
}

/**
 * プラン × 種類ごとの上限。
 *
 * 上限は「気分」ではなく原価から逆算している。出力 $3.75/1M トークン
 * （2026年末までの導入価格。2027/01 から $7.50）。
 *
 * 2026-09-20 に実測したところ、1回の検索の出力は thinking 込みで
 * **971 トークン / 0.67円**だった（turbulence・学術モード・3.6-flash）。
 * それ以前は3,000トークン＝1.8円と見積もっていたが、実際は3分の1。
 * 以下の上限はこの見積もり時代に決めたもので、実測に照らすと保守的すぎる
 * 可能性がある。利用が増えて平均値が取れたら見直す。
 *
 * 当初は Pro の検索を日300語にしていたが、それだと月9,000語 ≒ 原価16,000円で、
 * 月額600円では桁違いの赤字になる。dictionary_cache は全ユーザー共有なので
 * 実際には多くがキャッシュヒットするが、それに賭けた上限設定は危険。
 *
 * そこで Pro の検索は日100語・月1,500語に抑えた（学習者としては十分に多い）。
 *
 * 無料の検索は日30語にしてある。課金の壁は「保存30語」が担うので、検索側は
 * 試している人を邪魔しない範囲で原価を抑えられればよい。保存が30語で止まる
 * 以上、何百語も検索し続ける動機は薄く、数字も保存上限と揃えて覚えやすくした。
 * 実効ヒット率8割を見込むと原価は月540円程度に収まる。ここを実測で詰めるまでは
 * この保守的な上限を動かさないこと（実測は api/_lib/costLog.ts のログから）。
 *
 * extract は LP と課金画面で Pro 限定と謳っている機能なので、free は 0 にして
 * サーバー側で確実に止める。
 */
export const PLAN_QUOTA: Record<PlanId, Record<QuotaBucket, QuotaLimit>> = {
  free: {
    lookup: { day: 30, week: 120, month: 300 },
    extract: { day: 0, week: 0, month: 0 },
    story: { day: 3, week: 10, month: 20 },
    review: { day: 20, week: 80, month: 300 },
  },
  pro: {
    lookup: { day: 100, week: 400, month: 1500 },
    extract: { day: 10, week: 40, month: 100 },
    story: { day: 20, week: 80, month: 300 },
    review: { day: 100, week: 400, month: 1500 },
  },
};

/**
 * プランごとの保存語数の上限。null は無制限。
 *
 * 無料は30語。削除すれば枠は戻る（入れ替えは自由）。
 *
 * この数字は「語彙マップが面白くなり始めるのが20〜40語」というところから
 * 決めている。30語まで貯めるとマップにつながりが見え始め、そこで上限に当たる。
 * 一番続きが欲しくなった瞬間に Pro の話が出るようにしたい。
 *
 * ⚠️ この制限は `api/save-words.ts` 経由でしか強制できない。Firestore の
 * セキュリティルールにはコレクションの件数を数える機能が無いため、
 * クライアントから直接 `words` に書ける状態に戻してはいけない。
 */
export const PLAN_WORD_LIMIT: Record<PlanId, number | null> = {
  free: 30,
  pro: null,
};

/** Pro 限定の機能キー。クライアントの表示制御と共有する。 */
export const PRO_FEATURES = [
  "knowledgeMap",
  "bulkExtract",
  "tts",
  "stats",
  "ankiExport",
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export interface PlanState {
  plan: PlanId;
  /** 有効期限（epoch ms）。Pro のときのみ入る。 */
  currentPeriodEnd?: number;
  /** Stripe 側で解約予約済みか（期末まで Pro のまま）。 */
  cancelAtPeriodEnd?: boolean;
  /**
   * 上限を一切かけない。運営者本人だけ。
   *
   * 開発と動作確認のたびに自分の枠を使い切ってしまうと、本番の状態を
   * 確かめられなくなる。実際、障害対応中に何度も上限に当たった。
   */
  unlimited?: boolean;
}

const FREE: PlanState = { plan: "free" };

/**
 * 上限をかけない運営者のメールアドレス（カンマ区切り、環境変数 OWNER_EMAILS）。
 *
 * ソースに直接書かない。リポジトリが公開された場合に個人のメールアドレスが
 * そのまま残るため。設定が無ければ誰も該当しない（安全側に倒す）。
 */
function ownerEmails(): string[] {
  return (process.env.OWNER_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * このメールアドレスは運営者か。
 *
 * ID トークンは jose の jwtVerify で署名・iss・aud を検証済み（api/_lib/auth.ts）
 * なので、そこから取り出した email は詐称できない。ただし Google 以外の
 * プロバイダを将来足したときのために、検証済みフラグも要求する。
 */
export function isOwner(email: string | undefined, emailVerified: boolean | undefined): boolean {
  if (!email || emailVerified === false) return false;
  const list = ownerEmails();
  return list.length > 0 && list.includes(email.toLowerCase());
}

/**
 * `subscriptions/{uid}` を読んで現在のプランを返す。
 *
 * ドキュメントが無い / 読めない / status が有効でない / 期限切れ の場合は free。
 * 期限には Stripe の請求失敗を考慮して 3 日の猶予を持たせる（webhook の
 * 取りこぼしでいきなり止まるのを防ぐ）。
 */
export async function resolvePlan(
  idToken: string,
  uid: string,
  owner?: { email?: string; emailVerified?: boolean }
): Promise<PlanState> {
  // 運営者は Stripe を見るまでもなく無制限。契約が無くても上限にかからない。
  if (isOwner(owner?.email, owner?.emailVerified)) {
    return { plan: "pro", unlimited: true };
  }

  const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

  let fields: Record<string, any> | undefined;
  try {
    const res = await fetch(`${BASE_URL}/subscriptions/${uid}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return FREE;
    fields = ((await res.json()) as { fields?: Record<string, any> }).fields;
  } catch (e) {
    console.warn("[plan] subscriptions read error:", e);
    return FREE;
  }
  if (!fields) return FREE;

  const status = fields.status?.stringValue as string | undefined;
  // Stripe の subscription.status のうち利用を許すもの
  if (status !== "active" && status !== "trialing" && status !== "past_due") return FREE;

  const end = Number(fields.currentPeriodEnd?.integerValue ?? 0);
  if (end && Date.now() > end + GRACE_MS) return FREE;

  return {
    plan: "pro",
    currentPeriodEnd: end || undefined,
    cancelAtPeriodEnd: fields.cancelAtPeriodEnd?.booleanValue === true,
  };
}
