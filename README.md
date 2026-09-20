# Cortex Dictionary

AI（Gemini）で英単語を引き、意味・文法・語源・ニュアンス・専門分野ごとの用法までをまとめて生成する英単語学習アプリ。保存した単語はフラッシュカードで復習でき、語源の共通ルートをたどる「語彙ナレッジマップ」で単語同士のつながりを可視化する。

- 本番: https://lexi-log-puce.vercel.app/
- 技術構成: React 19 / Vite / Tailwind CSS 4 / Firebase (Auth + Firestore) / Google Gemini / Vercel
- AI Studio 由来: https://ai.studio/apps/f55ff9db-e50f-4a01-bdbe-7636a1265750

> リポジトリは `cortex-dictionary`（旧 `LexiLog`）。古いリモート URL でも push はできるが、
> Vercel などの連携は新しい名前を指しているか確認すること。

## 主な機能

| 機能 | 概要 |
|---|---|
| スタートアップガイド | 初回ログイン時に一度だけ 6 段の説明を出す。スキップ / Esc / 背景クリックでいつでも中断でき、サイドバー下の「使い方」から開き直せる |
| 単語検索 | 一般 / 学術の2モード。意味・文法・語源・ニュアンス・専門文脈3視点・例文・類義語/対義語・コロケーションを構造化生成 |
| 単語の保存 | Googleログインした自分のリストに保存。日付ごとにグルーピング |
| フラッシュカード | AGAIN / HARD / GOOD / EASY の4段階評価で復習。次回いつ出るかをボタンに予告表示 |
| 想起テスト | 日本語を見て綴りを打つ。綴りのずれは「正解 / おしい / 不正解」で機械判定する |
| 復習間隔 | SM-2 系のローカル計算（`src/lib/srs.ts`）。新規語は 1分 → 10分 → 1日 の学習ステップを踏み、当日中に 3 回出る |
| 今日のサイクル | 導入 → 想起 → 定着 の 3 段。今日どこまでやれば終わりかを示す |
| 抜けない語 | AGAIN が 6 回を超えた語を拾い、AI に苦手の原因を書かせる |
| 語彙ナレッジマップ | 語源・類義語・対義語のレイヤを**重ねて**表示。房ごとに色分けし、焦点表示・図内検索・語根の拡張・房ごとの復習ができる |
| データの書き出し / 復元 | JSON（完全バックアップ）/ CSV / Anki TSV。JSON からの復元にも対応 |

## ローカルでの起動

**前提:** Node.js 20 以上

```bash
npm install
```

`.env.local` を作成し、Gemini API キーを設定する（`.env.example` を参照）。

```
GEMINI_API_KEY=your_api_key_here
```

```bash
npm run dev      # http://localhost:3000
npm run build    # 本番ビルド
npm run lint     # 型チェック（tsc --noEmit）
npm run verify   # 純粋ロジックの検証（Firestore / Gemini に接続しない）
```

## データ

ユーザーの単語は Firestore の `words` コレクションに保存される。スキーマを変更する際は、
実装仕様書の「データ保護方針」に従うこと（既存フィールドを変更しない / 新フィールドは
すべて optional / 読み取り時に正規化 / `firestore.rules` の更新許可キーを同時に更新）。

**変更作業の前には、アプリ内の「データの書き出し / 復元」から JSON バックアップを取得すること。**

## セキュリティ

- Firestore のセキュリティルールは `firestore.rules`、想定する攻撃と不変条件は `security_spec.md` を参照。
- `firebase-applet-config.json` の `apiKey` は Firebase Web API キーであり、公開されて問題ないもの（アクセス制御はセキュリティルール側で行う）。**Gemini API キーはこれとは別物で、クライアントに含めてはならない。**
