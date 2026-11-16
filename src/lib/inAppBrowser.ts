/**
 * SNS アプリ内ブラウザの判定（2026-11-17 追加）。
 *
 * Google は WebView（アプリ内ブラウザ）でのログインを認めておらず、
 * Instagram・Threads・Facebook などのリンクから開くと Google ログインが
 * `403 disallowed_useragent` で失敗する（Google の公式文書）。
 * SNS からの流入はほぼこの経路なので、ここで見分けて外部ブラウザへ案内する。
 *
 * 判定は User-Agent の目印だけ。外れても案内が出ないだけで、ログイン自体は従来どおり試せる。
 */

export type InAppName = "Instagram" | "Threads" | "Facebook" | "LINE" | "TikTok" | "X";

export interface InAppInfo {
  app: InAppName;
  os: "ios" | "android" | "other";
}

export function detectInApp(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): InAppInfo | null {
  // 開発時だけ見た目を確かめる切り替え: http://localhost:3100/?inapp=ios （android も可）。本番のバンドルには入らない
  if (import.meta.env?.DEV && typeof location !== "undefined") {
    const f = new URLSearchParams(location.search).get("inapp");
    if (f === "ios" || f === "android") return { app: "Instagram", os: f };
  }
  const os: InAppInfo["os"] = /iPhone|iPad|iPod/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "other";
  let app: InAppName | null = null;
  if (/Barcelona/i.test(ua)) app = "Threads"; // Threads アプリの UA の目印
  else if (/Instagram/i.test(ua)) app = "Instagram";
  else if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) app = "Facebook";
  else if (/\bLine\//i.test(ua)) app = "LINE";
  else if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) app = "TikTok";
  else if (/Twitter/i.test(ua) && os === "android") app = "X";
  return app ? { app, os } : null;
}

/** Android で Chrome（無ければ既定のブラウザ）に開き直す URL。 */
export function androidExternalUrl(href: string = location.href): string {
  const u = new URL(href);
  return `intent://${u.host}${u.pathname}${u.search}${u.hash}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`;
}

/**
 * LINE は URL に openExternalBrowser=1 を付けると外部ブラウザで開き直してくれる（LINE の公式仕様）。
 * 1回だけ試す（戻ってきたときに繰り返さない）。
 */
export function redirectLineToExternal(): boolean {
  try {
    const info = detectInApp();
    if (info?.app !== "LINE") return false;
    const u = new URL(location.href);
    if (u.searchParams.has("openExternalBrowser")) return false;
    u.searchParams.set("openExternalBrowser", "1");
    location.replace(u.toString());
    return true;
  } catch {
    return false;
  }
}
