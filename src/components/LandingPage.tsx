/**
 * 未ログイン時に出すランディングページ。
 *
 * 以前はここが「アプリ名 + 2文 + ログインボタン」だけで、初めて来た人に
 * 何ができるのかも、なぜ他の単語帳アプリでないのかも伝わらなかった。
 * 流入をアカウント登録に変える役割を持つ唯一の画面なので、価値・差別化・
 * 価格・よくある質問までを1枚に収める。
 *
 * デザインは本体と同じく、囲みではなく罫線と余白で区切る。
 */

import React from "react";
import { motion } from "motion/react";
import { LogIn, Check } from "lucide-react";

interface Props {
  onLogin: () => void;
}

const FEATURES: { title: string; body: string }[] = [
  {
    title: "1回引けば、辞書10冊分",
    body: "意味・品詞と語法・語源・ニュアンス・分野ごとの用法・例文・類義語と対義語・コロケーションまでを、AI が一度に構造化して返します。タブを行き来する必要がありません。",
  },
  {
    title: "語源でつながる語彙マップ",
    body: "覚えた単語は孤立した点ではなく、語源・コロケーション・類義語の3層でつながったネットワークとして描かれます。まだ知らない語は「シルエット」として現れ、次に覚えるべき単語が見えます。",
  },
  {
    title: "専門分野の英語に強い",
    body: "学術モードでは、同じ単語が工学・医学・法学などの文脈でどう使われるかを分けて提示します。論文や技術文書を読む人のための辞書です。",
  },
  {
    title: "英文を貼るだけで単語帳ができる",
    body: "論文や記事をそのまま貼り付けると、あなたがまだ保存していない語だけを抜き出します。読みながら単語を拾う作業がなくなります。",
  },
  {
    title: "間隔反復で忘れない",
    body: "保存した単語はフラッシュカードに並びます。4段階の手応え評価に応じて次に出る日が決まるので、あやふやな語ほど多く出会えます。",
  },
  {
    title: "データはいつでも持ち出せる",
    body: "JSON・CSV・Anki 形式で全件を書き出せます。ロックインしません。",
  },
];

const FREE_POINTS = ["検索 1日10語", "保存 200語まで", "フラッシュカード復習", "データの書き出し"];
const PRO_POINTS = [
  "検索 1日100語（月1,500語）",
  "保存 無制限",
  "語彙ナレッジマップ 全開放",
  "英文から未知語を一括抽出",
  "発音（TTS）と発音記号",
  "学習統計とダッシュボード",
  "Anki 形式でのエクスポート",
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "無料でどこまで使えますか？",
    a: "1日10語の検索と200語の保存まで無料で使えます。クレジットカードの登録は不要です。",
  },
  {
    q: "既存の単語帳から移行できますか？",
    a: "JSON からの復元に対応しています。Anki 形式での書き出しもできるので、行き来も自由です。",
  },
  {
    q: "解約はすぐできますか？",
    a: "アプリ内からいつでも解約でき、日割りの手続きも不要です。解約後も保存した単語は残り、書き出せます。",
  },
  {
    q: "英検・TOEIC・IELTS の対策にも使えますか？",
    a: "使えます。デッキ（単語帳）を試験別に分けられるので、試験用の語彙と専門分野の語彙を混ぜずに管理できます。",
  },
];

const Rule: React.FC = () => <div className="border-t border-[#EDEFF1]" />;

export const LandingPage: React.FC<Props> = ({ onLogin }) => {
  const LoginButton: React.FC<{ label?: string }> = ({ label = "Google で無料ではじめる" }) => (
    <button type="button" onClick={onLogin} className="btn-primary">
      <LogIn className="w-4 h-4" />
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-white text-[#1A1C1E] overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-16 md:py-24">
        {/* Hero */}
        <motion.header initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-xs font-bold tracking-widest text-[#2A5CFF]">CORTEX DICTIONARY</p>
          <h1 className="mt-4 text-4xl md:text-5xl font-black tracking-tight leading-[1.15]">
            英単語を、
            <br />
            バラバラに覚えるのをやめる。
          </h1>
          <p className="mt-6 text-[15px] leading-relaxed text-[#656E77]">
            意味・語源・ニュアンス・専門分野ごとの用法を AI が一度に解説し、覚えた単語を語源で
            つながったマップとして描き出す英単語アプリ。単語を1つ覚えるたびに、その周りの
            知らない単語まで見えるようになります。
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <LoginButton />
            <span className="text-xs text-[#8A9199]">クレジットカード不要 / 1日10語まで無料</span>
          </div>
        </motion.header>

        <div className="mt-20">
          <Rule />
        </div>

        {/* できること */}
        <section className="pt-16">
          <h2 className="text-xs font-bold tracking-widest text-[#8A9199]">できること</h2>
          <div className="mt-8 space-y-10">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <h3 className="text-base font-black">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#656E77]">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-20">
          <Rule />
        </div>

        {/* 料金 */}
        <section className="pt-16">
          <h2 className="text-xs font-bold tracking-widest text-[#8A9199]">料金</h2>
          <div className="mt-8 flex flex-col gap-10 sm:flex-row">
            <div className="flex-1">
              <p className="text-xs font-bold tracking-wide text-[#8A9199]">FREE</p>
              <p className="mt-1 text-3xl font-black">¥0</p>
              <p className="mt-1 text-xs text-[#8A9199]">ずっと無料</p>
              <ul className="mt-5 space-y-2">
                {FREE_POINTS.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#C4C9CE]" />
                    <span className="text-[#656E77]">{p}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex-1">
              <p className="text-xs font-bold tracking-wide text-[#2A5CFF]">PRO</p>
              <p className="mt-1 text-3xl font-black">
                ¥400
                <span className="text-sm font-bold text-[#8A9199]"> / 月</span>
              </p>
              <p className="mt-1 text-xs text-[#8A9199]">年額 ¥4,800（月払いなら ¥600）</p>
              <ul className="mt-5 space-y-2">
                {PRO_POINTS.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#2A5CFF]" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-8 text-xs leading-relaxed text-[#8A9199]">
            決済は Stripe が処理します。カード情報がこのアプリに保存されることはありません。
            まず無料で試してから、足りなくなったときに切り替えられます。
          </p>
        </section>

        <div className="mt-20">
          <Rule />
        </div>

        {/* よくある質問 */}
        <section className="pt-16">
          <h2 className="text-xs font-bold tracking-widest text-[#8A9199]">よくある質問</h2>
          <div className="mt-8 space-y-8">
            {FAQ.map((item) => (
              <div key={item.q}>
                <h3 className="text-sm font-black">{item.q}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#656E77]">{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-20">
          <Rule />
        </div>

        {/* 締め */}
        <section className="pt-16">
          <h2 className="text-2xl font-black tracking-tight">まず1語、引いてみてください。</h2>
          <p className="mt-3 text-sm leading-relaxed text-[#656E77]">
            Google アカウントでログインするだけで始められます。保存した単語はあなただけのもので、
            他のユーザーからは見えません。
          </p>
          <div className="mt-8">
            <LoginButton />
          </div>
        </section>

        <footer className="mt-24 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[#EDEFF1] pt-6 text-[11px] text-[#8A9199]">
          <span>Cortex Dictionary</span>
          <a href="/legal/terms.html" className="hover:text-[#1A1C1E]">
            利用規約
          </a>
          <a href="/legal/privacy.html" className="hover:text-[#1A1C1E]">
            プライバシーポリシー
          </a>
          <a href="/legal/tokushoho.html" className="hover:text-[#1A1C1E]">
            特定商取引法に基づく表記
          </a>
        </footer>
      </div>
    </div>
  );
};
