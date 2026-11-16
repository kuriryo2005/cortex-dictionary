/**
 * 検索ログの送信（匿名。サーバー側は api/_lib/searchLog.ts）。
 * 失敗しても検索には影響させない。
 */

type Source = "local" | "firestore" | "ai" | "guest-hit" | "guest-miss";

/** 最初に来たときの utm_source（同じタブの間だけ覚える）。 */
function landingRef(): string {
  try {
    const now = new URLSearchParams(location.search).get("utm_source");
    if (now) sessionStorage.setItem("cx_ref", now);
    return now ?? sessionStorage.getItem("cx_ref") ?? "";
  } catch {
    return "";
  }
}

export function logSearch(word: string, source: Source, mode: "gen" | "aca", guest: boolean): void {
  try {
    const body = JSON.stringify({ word, source, mode, guest, ref: landingRef() });
    const url = "/api/lookup?log=1";
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
    void fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
  } catch {
    // 計測の失敗で検索を止めない
  }
}
