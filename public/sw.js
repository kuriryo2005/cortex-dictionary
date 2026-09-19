/**
 * Service Worker。
 *
 * 目的は「ホーム画面に追加したときアプリらしく立ち上がること」と
 * 「電波が悪いときに真っ白にならないこと」の2つだけ。凝ったオフライン
 * 同期はしない（学習データは Firestore 側の永続化に任せる）。
 *
 * 絶対にキャッシュしてはいけないもの:
 *  - /api/*        … 認証つき。使い回すと他人の結果やプラン状態が混ざる
 *  - Firebase / Google の通信 … 認証とリアルタイム購読
 *
 * ビルドのたびにアセット名が変わるので、古いキャッシュは activate で捨てる。
 */

const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add("/")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== SHELL && n !== ASSETS).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!isCacheable(url)) return;

  // ビルド済みアセットは内容がハッシュ名に紐づくのでキャッシュ優先でよい
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(ASSETS).then((c) => c.put(request, copy));
            return res;
          })
      )
    );
    return;
  }

  // 画面遷移はネットワーク優先。落ちていたらキャッシュした「/」を出す
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error()))
    );
  }
});
