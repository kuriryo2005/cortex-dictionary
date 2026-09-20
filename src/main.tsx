import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Analytics} from '@vercel/analytics/react';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Analytics />
  </StrictMode>,
);

/**
 * Service Worker の登録。ホーム画面に追加したときアプリらしく立ち上がり、
 * 電波が悪くても真っ白にならないようにするためだけのもの（public/sw.js）。
 * 開発中は登録しない（キャッシュで古い画面が出ると混乱するため）。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  /**
   * 新しい Service Worker が主導権を取ったら一度だけ再読み込みする。
   *
   * これが無いと、古いビルドを掴んだ端末はタブを閉じるまで更新されない。
   * 実際に「無料は1日10語」と書かれていた頃の画面を出し続けた端末があった。
   * 一度きりにしないと、更新のたびに再読み込みを繰り返す恐れがある。
   */
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // 起動のたびに更新を確認する（既定では最大24時間に1回しか見に行かない）
        void reg.update();
      })
      .catch((e) => {
        // 登録に失敗してもアプリは普通に動く
        console.warn('Service Worker の登録に失敗しました:', e);
      });
  });
}
