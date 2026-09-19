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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      // 登録に失敗してもアプリは普通に動く
      console.warn('Service Worker の登録に失敗しました:', e);
    });
  });
}
