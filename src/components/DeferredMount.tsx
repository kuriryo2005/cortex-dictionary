/**
 * 画面に入るまで中身を組み立てない入れ物。
 *
 * 単語の詳細ページには力学グラフ（d3）が載っている。これが重く、
 * 次の単語を検索したときの最初の描画がグラフの破棄と組み直しに引きずられて
 * 数百ミリ秒遅れていた（実測 689ms）。意味や語源はページの上のほうにあって
 * 先に読まれるのに、下にあるグラフの都合で全体の表示が待たされるのは逆さまだ。
 *
 * そこで、その位置までスクロールされるまでは場所だけ確保して中身を作らない。
 * 上から読んでいる人には何も変わらず、上の段が出るのは速くなる。
 */

import React, { useEffect, useRef, useState } from "react";

interface Props {
  /** 中身を作る前に確保しておく高さ。ここがずれると読んでいる最中に飛ぶ */
  minHeight: number;
  /**
   * 画面の何ピクセル手前で作り始めるか。
   *
   * 余裕を持たせすぎると「まだ見ていないのに組む」ことになり、遅延させた
   * 意味が薄れる。実測では 300px 先読みにすると、詳細ページを開いただけで
   * 語源グラフが組まれ、d3 の計算が約 1 秒メインスレッドを占有していた。
   * 既定は 0 にして、本当に見えたときだけ組む。
   */
  rootMargin?: string;
  children: React.ReactNode;
}

export const DeferredMount: React.FC<Props> = ({
  minHeight,
  rootMargin = "0px",
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const node = ref.current;
    if (!node) return;

    // IntersectionObserver が無い環境では素直に出す（出さないより出すほうがまし）
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown(true);
      },
      { rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, rootMargin]);

  return (
    <div ref={ref} style={shown ? undefined : { minHeight }}>
      {shown ? children : null}
    </div>
  );
};
