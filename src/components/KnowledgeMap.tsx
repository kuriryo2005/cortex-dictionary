/**
 * 単語のつながり図。
 *
 * 作り直しの理由。
 *
 *   - レイヤーが排他だった。語源で孤立して見える語も、類義語を重ねれば
 *     どこかの房につながる。「つながり」を見る図なのに、一度に一種類の
 *     つながりしか見られないのは目的に合っていなかった。
 *   - 房が色で区別されておらず、線が交差した瞬間に仲間が分からなくなっていた。
 *   - 語数が増えると全体が毛玉になり、一語を選んでも周りが見えなかった。
 *   - どこともつながっていない語が端に散るだけで、取り出す手段が無かった。
 *   - 語根を伸ばす API（/api/expand-root）が実装済みなのに、画面から
 *     呼ぶ経路が無く使われていなかった。
 *
 * いまは「重ねる / 色で分ける / 絞って見る / 伸ばす / そこから復習する」の
 * 5 つで構成している。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { SavedWord } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { X, Search, Loader2, Sparkles, Maximize2, BrainCircuit } from "lucide-react";
import { getEtymologyStory, expandEtymologyRoot, type RootRelative } from "../services/geminiService";
import {
  buildGraph,
  GraphLayer,
  MapNode,
  isolatedWords,
  neighborhood,
} from "../lib/graph";

interface Props {
  words: SavedWord[];
  onWordClick?: (word: SavedWord) => void;
  /** 未保存の関連語を押したとき。検索に回す */
  onSearchWord?: (word: string) => void;
  /** 生成した語源の解説を保存する。呼び出し側が Firestore に書き戻す */
  onStoryGenerated?: (wordId: string, story: string) => Promise<void> | void;
  /** 房や孤立語をそのまま復習に回す */
  onReviewWords?: (words: SavedWord[]) => void;
}

// ---- 色。アプリのデザイントークンに合わせる -------------------------
// primary  #2A5CFF = rgba(42,  92, 255, ...)  類義線
// ink      #1A1C1E = rgba(26,  28,  30, ...)  語根輪郭・ラベル
// muted    #8A9199 = rgba(138,145, 153, ...)  ghost・対義線
// border   #EAECEF = rgba(234,236, 239, ...)  ghost 塗り
const APP = {
  primary: "42, 92, 255",   // #2A5CFF
  ink:     "26, 28, 30",    // #1A1C1E
  muted:   "138, 145, 153", // #8A9199
  border:  "234, 236, 239", // #EAECEF
} as const;

/**
 * 房の色。
 *
 * 8 色の固定順。scripts/validate_palette.js（dataviz）で明度帯・彩度下限・
 * 色覚多様性での隣接分離・地色とのコントラストを検証済み。9 個目以降は
 * 色を生成せず灰へ落とす（増やすほど隣が見分けられなくなるため）。
 * どのノードにも語のラベルが付いているので、色は補助でしかない。
 */
const CLUSTER_COLORS = [
  "42, 92, 255",   // #2A5CFF
  "194, 65, 12",   // #C2410C
  "13, 148, 136",  // #0D9488
  "190, 24, 93",   // #BE185D
  "161, 98, 7",    // #A16207
  "124, 58, 237",  // #7C3AED
  "77, 124, 15",   // #4D7C0F
  "8, 145, 178",   // #0891B2
] as const;

const NEUTRAL = "107, 114, 128";

const LAYER_TABS: { key: GraphLayer; label: string }[] = [
  { key: "etymology", label: "語源" },
  { key: "synonym",  label: "類義語" },
  { key: "antonym",  label: "対義語" },
];

/**
 * 房を表す不変の文字列。語根名（無ければ最初の語）を使う。
 * 房の大小が入れ替わっても変わらない。
 */
function clusterSignature(roots: string[], words: { word: string }[], id: number): string {
  return (
    [...roots].sort()[0] ??
    [...words.map((w) => w.word)].sort()[0] ??
    String(id)
  );
}

export const KnowledgeMap: React.FC<Props> = ({
  words,
  onWordClick,
  onSearchWord,
  onStoryGenerated,
  onReviewWords,
}) => {
  /** 重ねて表示するレイヤー。既定は語源と類義語 */
  const [layers, setLayers] = useState<Set<GraphLayer>>(
    () => new Set<GraphLayer>(["etymology", "synonym"])
  );
  const [selected, setSelected]     = useState<MapNode | null>(null);
  const [hovered, setHovered]       = useState<string | null>(null);
  const [story, setStory]           = useState<string>("");
  const [isGenerating, setIsGen]    = useState(false);
  const [showOverdue, setShowOverdue] = useState(false);
  const [query, setQuery]           = useState("");

  /**
   * 焦点。ここが入ると 2 歩以内のノードだけを濃く描く。
   * 語数が増えたときに、毛玉のなかから一語の周りだけを取り出すための仕掛け。
   */
  const [focusId, setFocusId] = useState<string | null>(null);

  /** 語根を伸ばして得た候補（保存前）。ノード id をキーに持つ */
  const [expanded, setExpanded] = useState<Record<string, RootRelative[]>>({});
  const [expanding, setExpanding] = useState(false);

  const fgRef = useRef<any>(null);

  /**
   * 描画領域の実寸。
   *
   * ForceGraph2D に width / height を渡さないと、ライブラリは自分の
   * ラッパー div を測ろうとする。そのラッパーは高さ auto の素のブロックなので
   * 0 になり、親に min-h を効かせていても canvas が 0×0 のまま描かれない。
   * 親を自分で測って明示的に渡す。
   */
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () =>
      setSize({ width: box.clientWidth, height: box.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const layerList = useMemo(() => [...layers], [layers]);
  const graphData = useMemo(() => buildGraph(words, layerList), [words, layerList]);

  /**
   * 房 id → 色。
   *
   * 割り当ては「房の名前（語根名）の辞書順」で決める。大きさ順にすると、
   * 絞り込みで房の大小が入れ替わるたびに色が総入れ替えになって、
   * 前に見た図と照合できなくなる。名前順なら、房の集合が変わらない限り
   * 色も変わらず、しかも先頭 8 房は必ず違う色になる（単純なハッシュだと
   * 隣り合う房が同じ色に落ちることがある）。
   */
  const clusterColor = useMemo(() => {
    const map = new Map<number, string>();

    const colored = graphData.clusters
      // 1 語しかない房に色を割っても仲間を示せない
      .filter((c) => c.words.length >= 2)
      .map((c) => ({ id: c.id, sig: clusterSignature(c.roots, c.words, c.id) }))
      .sort((a, b) => a.sig.localeCompare(b.sig));

    colored.forEach((c, i) => {
      // 9 房目からは色を増やさず灰に落とす（増やすほど隣が見分けられない）
      map.set(c.id, i < CLUSTER_COLORS.length ? CLUSTER_COLORS[i] : NEUTRAL);
    });

    for (const cluster of graphData.clusters) {
      if (!map.has(cluster.id)) map.set(cluster.id, NEUTRAL);
    }
    return map;
  }, [graphData]);

  const isolated = useMemo(() => isolatedWords(graphData), [graphData]);

  /** 濃く描く範囲。焦点もホバーも無ければ全部 */
  const inFocus = useMemo(() => {
    const anchor = hovered ?? focusId;
    if (!anchor) return null;
    return neighborhood(graphData, anchor, hovered ? 1 : 2);
  }, [graphData, focusId, hovered]);

  const rootCount = useMemo(
    () => graphData.nodes.filter((n) => n.kind === "root").length,
    [graphData]
  );

  /** 検索に一致した保存済みの語。押すとそこへ焦点を移す */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];
    return graphData.nodes
      .filter((n) => n.label.toLowerCase().includes(q) || n.meaning.toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, graphData]);

  const closePanel = useCallback(() => {
    setSelected(null);
    setStory("");
  }, []);

  /** 焦点を合わせて、その位置まで寄せる。 */
  const focusOn = useCallback((node: MapNode) => {
    setSelected(node);
    setFocusId(node.id);
    setStory(node.kind === "word" ? node.data?.etymologyStory ?? "" : "");
    const live = node as MapNode & { x?: number; y?: number };
    if (fgRef.current && typeof live.x === "number" && typeof live.y === "number") {
      fgRef.current.centerAt(live.x, live.y, 500);
      fgRef.current.zoom(2.2, 500);
    }
  }, []);

  const handleNodeClick = useCallback((node: any) => focusOn(node as MapNode), [focusOn]);

  const resetView = useCallback(() => {
    setFocusId(null);
    setQuery("");
    closePanel();
    fitPending.current = false;
    fgRef.current?.zoomToFit(500, 60);
  }, [closePanel]);

  /**
   * 全体が入る倍率に戻すのを 1 回だけ予約しておく。
   *
   * 固定の setTimeout で zoomToFit を呼ぶと、力学計算が落ち着く前に測るので
   * ノードが数個のうちは極端に寄った絵になる。シミュレーションが止まった
   * タイミング（onEngineStop）に合わせて、予約が立っているときだけ寄せる。
   * こうしておけば、そのあと利用者が手で拡大した倍率を奪わない。
   */
  const fitPending = useRef(true);

  useEffect(() => {
    fitPending.current = true;
  }, [layerList.join(","), words.length, size.width, size.height]);

  const toggleLayer = (key: GraphLayer) => {
    setLayers((prev) => {
      const next = new Set(prev);
      // 全部外すと何も描かれない。最後の 1 枚は外させない
      if (next.has(key)) {
        if (next.size === 1) return prev;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    closePanel();
  };

  const generateStory = useCallback(async () => {
    const word = selected?.data;
    if (!word || isGenerating) return;
    setIsGen(true);
    try {
      const text = await getEtymologyStory(word.word, word.meaning, word.etymology);
      setStory(text);
      await onStoryGenerated?.(word.id, text);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGen(false);
    }
  }, [selected, isGenerating, onStoryGenerated]);

  /**
   * 語根を伸ばす。
   *
   * その語根を共有する語のうち、まだ持っていないものを AI に挙げさせる。
   * 1 語ずつ思いつきで検索するより、語根単位でまとめて広げるほうが速い。
   */
  const expandRoot = useCallback(async () => {
    const root = selected?.root;
    if (!root || expanding) return;
    setExpanding(true);
    try {
      const found = await expandEtymologyRoot(root);
      const known = new Set(words.map((w) => w.word.trim().toLowerCase()));
      setExpanded((prev) => ({
        ...prev,
        [selected!.id]: found.filter((r) => !known.has(r.word.trim().toLowerCase())),
      }));
    } catch (e) {
      console.error(e);
      setExpanded((prev) => ({ ...prev, [selected!.id]: [] }));
    } finally {
      setExpanding(false);
    }
  }, [selected, expanding, words]);

  /** 選んだノードが属する房の保存済みの語 */
  const selectedCluster = useMemo(() => {
    if (!selected) return null;
    return graphData.clusters.find((c) => c.id === selected.cluster) ?? null;
  }, [selected, graphData]);

  if (words.length === 0) {
    return (
      <div className="h-full flex flex-col justify-center max-w-xl mx-auto w-full">
        <h3 className="text-2xl font-black text-[#1A1C1E] mb-3">表示できる単語がありません</h3>
        <p className="text-sm text-[#656E77] leading-relaxed">
          単語を保存すると、語源や類義語のつながりを図として表示します。
        </p>
      </div>
    );
  }

  const linkedWordCount = graphData.nodes.filter(
    (n) => n.kind === "word" && n.degree + (graphData.adjacency.get(n.id)?.size ?? 0) > 0
  ).length;

  return (
    <div className="flex flex-col h-full">
      {/* ヘッダー */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h2 className="text-2xl font-black text-[#1A1C1E]">単語のつながり</h2>
          <p className="text-sm text-[#8A9199] mt-1">
            {linkedWordCount} / {words.length} 語がどこかにつながっています
            {layers.has("etymology") && ` · 語根 ${rootCount} 種類`}
            {` · 房 ${graphData.clusters.filter((c) => c.words.length >= 2).length}`}
          </p>
        </div>

        <div className="flex items-center gap-5 shrink-0 flex-wrap">
          <button
            onClick={() => setShowOverdue((v) => !v)}
            className={`text-xs font-bold pb-1 border-b-2 transition-colors ${
              showOverdue
                ? "text-[#1A1C1E] border-[#1A1C1E]"
                : "text-[#8A9199] border-transparent hover:text-[#1A1C1E]"
            }`}
          >
            復習の遅れ
          </button>

          <div className="w-px h-4 bg-[#EAECEF]" />

          {/* レイヤーは重ねられる。押すたびに足し引きする */}
          {LAYER_TABS.map((l) => (
            <button
              key={l.key}
              onClick={() => toggleLayer(l.key)}
              className={`text-xs font-bold pb-1 border-b-2 transition-colors ${
                layers.has(l.key)
                  ? "text-[#1A1C1E] border-[#1A1C1E]"
                  : "text-[#8A9199] border-transparent hover:text-[#1A1C1E]"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* 図のなかを探す。語数が増えると目で追えなくなる */}
      <div className="relative flex items-center gap-4 mb-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#C9CDD2]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="図のなかを探す"
            className="w-full h-8 pl-6 bg-transparent border-0 border-b border-[#EAECEF] rounded-none text-xs font-bold text-[#1A1C1E] focus:outline-none focus:border-[#1A1C1E] placeholder:font-normal placeholder:text-[#C9CDD2]"
          />

          {matches.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-30 bg-white shadow-lg py-1.5 mt-1">
              {matches.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setQuery("");
                    focusOn(n);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#F5F6F7] flex items-baseline justify-between gap-3"
                >
                  <span className="text-xs font-bold text-[#1A1C1E] truncate">{n.label}</span>
                  <span className="text-[10px] text-[#8A9199] truncate">
                    {n.kind === "root" ? "語根" : n.meaning.slice(0, 18)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {(focusId || query) && (
          <button
            onClick={resetView}
            className="text-[11px] font-bold text-[#8A9199] hover:text-[#1A1C1E] flex items-center gap-1.5 transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            全体に戻す
          </button>
        )}
      </div>

      <div
        ref={boxRef}
        className="relative flex-1 min-h-[600px] overflow-hidden border-t border-b border-[#EAECEF]"
      >
        <ForceGraph2D
          ref={fgRef}
          width={size.width || undefined}
          height={size.height || undefined}
          graphData={graphData as any}
          nodeLabel={(node: any) =>
            node.kind === "root" ? `語根 ${node.label}` : `${node.label}: ${node.meaning}`
          }
          onNodeClick={handleNodeClick}
          onNodeHover={(node: any) => setHovered(node ? (node as MapNode).id : null)}
          onEngineStop={() => {
            if (!fitPending.current) return;
            fitPending.current = false;
            fgRef.current?.zoomToFit(400, 60);
          }}
          onBackgroundClick={() => {
            setFocusId(null);
            closePanel();
          }}
          linkColor={(link: any) => {
            // 焦点の外の線は消さずに薄く残す。消すと図の形が変わって位置を見失う
            const inside =
              !inFocus ||
              (inFocus.has(typeof link.source === "object" ? link.source.id : link.source) &&
                inFocus.has(typeof link.target === "object" ? link.target.id : link.target));
            const alpha = inside ? 1 : 0.12;
            if (link.kind === "synonym") return `rgba(${APP.primary}, ${0.45 * alpha})`;
            if (link.kind === "antonym") return `rgba(${APP.muted}, ${0.55 * alpha})`;
            return `rgba(${APP.ink}, ${0.2 * alpha})`;
          }}
          linkWidth={(link: any) => {
            const inside =
              !inFocus ||
              (inFocus.has(typeof link.source === "object" ? link.source.id : link.source) &&
                inFocus.has(typeof link.target === "object" ? link.target.id : link.target));
            return inside && inFocus ? 2 : link.kind === "root" ? 1.2 : 1;
          }}
          linkLineDash={(link: any) => (link.kind === "antonym" ? [4, 3] : null)}
          nodeCanvasObject={(node: any, ctx, globalScale) => {
            const n = node as MapNode & { x: number; y: number };
            const radius = 4 + n.importance * 12;
            const fontSize = 12 / globalScale;

            // 焦点の外は薄くする。消さないのは、全体の形を保つため
            const dim = inFocus && !inFocus.has(n.id) ? 0.12 : 1;
            const tone = clusterColor.get(n.cluster) ?? NEUTRAL;

            ctx.beginPath();
            ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI, false);

            if (n.kind === "word") {
              // 復習の遅れは意味のつながりとは別の軸。オンのときだけ重ねる
              const overdueFade = showOverdue ? Math.max(0.3, 1 - n.daysOverdue / 14) : 1;
              ctx.fillStyle = `rgba(${tone}, ${overdueFade * dim})`;
              if (showOverdue && n.daysOverdue > 0) {
                ctx.strokeStyle = `rgba(220, 38, 38, ${0.8 * dim})`;
                ctx.setLineDash([2, 2]);
              } else {
                ctx.strokeStyle = `rgba(${tone}, ${0.4 * dim})`;
              }
            } else if (n.kind === "root") {
              // 語根は中抜き。語と同じ塗りにすると、どちらが自分の語か分からない
              ctx.fillStyle = `rgba(255, 255, 255, ${0.95 * dim})`;
              ctx.strokeStyle = `rgba(${tone}, ${0.85 * dim})`;
            } else {
              ctx.fillStyle = `rgba(${APP.border}, ${0.5 * dim})`;
              ctx.strokeStyle = `rgba(${APP.muted}, ${0.55 * dim})`;
              ctx.setLineDash([4, 4]);
            }

            ctx.lineWidth = (n.kind === "root" ? 1.8 : 1) / globalScale;
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);

            // 選んだノードには輪を足す。色だけだと焦点が分かりにくい
            if (selected?.id === n.id) {
              ctx.beginPath();
              ctx.arc(n.x, n.y, radius + 4 / globalScale, 0, 2 * Math.PI, false);
              ctx.strokeStyle = `rgba(${APP.ink}, 0.9)`;
              ctx.lineWidth = 1.5 / globalScale;
              ctx.stroke();
            }

            // ラベル: Inter ではなくアプリ既定の sans-serif を使う
            const sans = "'Helvetica Neue', Arial, sans-serif";
            ctx.font = `${n.kind === "root" ? "italic " : ""}${fontSize}px ${sans}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle =
              n.kind === "ghost"
                ? `rgba(${APP.muted}, ${dim})`
                : `rgba(${APP.ink}, ${dim})`;
            ctx.fillText(n.label, n.x, n.y + radius + fontSize + 2);
          }}
        />

        {/* 凡例 */}
        <div className="absolute top-5 left-5 flex flex-col gap-2.5 pointer-events-none">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#2A5CFF]" />
            <span className="text-[11px] font-bold text-[#656E77]">保存済み（色は房ごと）</span>
          </div>
          {layers.has("etymology") && (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full border-2 border-[#1A1C1E] bg-white" />
              <span className="text-[11px] font-bold text-[#656E77]">語根</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full border border-dashed border-[#8A9199]" />
            <span className="text-[11px] font-bold text-[#8A9199]">未保存の関連語</span>
          </div>
          {showOverdue && (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full border-2 border-dashed border-red-600" />
              <span className="text-[11px] font-bold text-[#656E77]">復習の期限超過</span>
            </div>
          )}
        </div>

        {/* どこともつながっていない語。端に散るだけで見落とされる */}
        {isolated.length > 0 && !selected && (
          <div className="absolute bottom-5 left-5 right-5 md:right-auto md:max-w-md bg-white/95 backdrop-blur-sm border-t-2 border-[#1A1C1E] px-5 py-4">
            <p className="text-[11px] font-bold text-[#1A1C1E] mb-1">
              つながりのない語 {isolated.length}
            </p>
            <p className="text-[11px] text-[#656E77] leading-relaxed mb-3">
              語源も類義語も他の語と重なっていません。孤立した語は手がかりが
              少なく、いちばん抜けやすい語でもあります。
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {isolated.slice(0, 8).map((w) => (
                <button
                  key={w.id}
                  onClick={() => onWordClick?.(w)}
                  className="text-[11px] font-bold text-[#656E77] hover:text-[#2A5CFF] transition-colors"
                >
                  {w.word}
                </button>
              ))}
              {isolated.length > 8 && (
                <span className="text-[11px] text-[#C9CDD2]">ほか {isolated.length - 8}</span>
              )}
            </div>
            {onReviewWords && (
              <button
                onClick={() => onReviewWords(isolated)}
                className="mt-4 text-[11px] font-bold text-[#2A5CFF] border-b border-[#2A5CFF] flex items-center gap-1.5"
              >
                <BrainCircuit className="w-3.5 h-3.5" />
                この {isolated.length} 語を復習する
              </button>
            )}
          </div>
        )}

        {/* 選んだノードのパネル */}
        <AnimatePresence>
          {selected && (
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.18 }}
              className="absolute top-0 right-0 h-full w-full max-w-sm bg-white border-l border-[#EAECEF] px-8 py-7 overflow-y-auto"
            >
              <button
                onClick={closePanel}
                className="absolute top-6 right-6 text-[#8A9199] hover:text-[#1A1C1E]"
                aria-label="閉じる"
              >
                <X className="w-4 h-4" />
              </button>

              {selected.kind === "root" ? (
                <>
                  <p className="section-label mb-2">語根</p>
                  <h3 className="text-2xl font-black text-[#1A1C1E] italic mb-4">{selected.label}</h3>
                  <p className="text-sm text-[#656E77] leading-loose">
                    {selected.meaning || "この語根を共有する単語がまとまっています。"}
                  </p>
                  <p className="text-xs font-bold text-[#8A9199] mt-6">保存済み {selected.degree} 語</p>

                  {/* 語根ごと広げる。1 語ずつ思いつきで引くより速い */}
                  <div className="mt-8 pt-6 border-t border-[#EAECEF]">
                    {expanded[selected.id] === undefined ? (
                      <button
                        onClick={expandRoot}
                        disabled={expanding}
                        className="btn-quiet px-0 text-sm"
                      >
                        {expanding ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4" />
                        )}
                        {expanding ? "探しています" : "この語根の仲間を探す"}
                      </button>
                    ) : expanded[selected.id].length === 0 ? (
                      <p className="text-xs text-[#8A9199]">
                        まだ持っていない仲間は見つかりませんでした。
                      </p>
                    ) : (
                      <>
                        <p className="section-label mb-3">まだ持っていない仲間</p>
                        <div className="space-y-3">
                          {expanded[selected.id].map((r) => (
                            <button
                              key={r.word}
                              onClick={() => {
                                onSearchWord?.(r.word);
                                closePanel();
                              }}
                              className="w-full text-left group"
                            >
                              <span className="text-sm font-bold text-[#1A1C1E] group-hover:text-[#2A5CFF] transition-colors">
                                {r.word}
                              </span>
                              <span className="block text-[11px] text-[#8A9199] leading-snug">
                                {r.meaning}
                              </span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : selected.kind === "ghost" ? (
                <>
                  <p className="section-label mb-2">未保存の関連語</p>
                  <h3 className="text-2xl font-black text-[#1A1C1E] mb-4">{selected.label}</h3>
                  {selected.meaning && (
                    <p className="text-sm text-[#656E77] leading-loose">{selected.meaning}</p>
                  )}
                  <p className="text-xs font-bold text-[#8A9199] mt-6">
                    つながる保存済みの語 {selected.degree} 語
                  </p>
                  <div className="mt-8 pt-6 border-t border-[#EAECEF]">
                    <button
                      onClick={() => { onSearchWord?.(selected.label); closePanel(); }}
                      className="btn-quiet px-0 text-sm"
                    >
                      <Search className="w-4 h-4" />
                      この単語を調べる
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="section-label mb-2">{selected.data?.grammar || "保存済み"}</p>
                  <h3 className="text-2xl font-black text-[#1A1C1E] mb-1">{selected.label}</h3>
                  <p className="text-sm text-[#1A1C1E] leading-relaxed mb-6">{selected.meaning}</p>

                  {selected.data?.etymology && (
                    <div className="mb-6">
                      <p className="section-label mb-2">語源</p>
                      <p className="text-sm text-[#656E77] leading-loose">{selected.data.etymology}</p>
                    </div>
                  )}

                  {selected.data?.nuance && (
                    <div className="mb-6">
                      <p className="section-label mb-2">ニュアンス</p>
                      <p className="text-sm text-[#656E77] leading-loose">{selected.data.nuance}</p>
                    </div>
                  )}

                  {story ? (
                    <div className="mb-6">
                      <p className="section-label mb-2">語源の解説</p>
                      <p className="text-sm text-[#656E77] leading-loose">{story}</p>
                    </div>
                  ) : (
                    <button
                      onClick={generateStory}
                      disabled={isGenerating}
                      className="btn-quiet px-0 text-sm mb-6"
                    >
                      {isGenerating && <Loader2 className="w-4 h-4 animate-spin" />}
                      {isGenerating ? "生成しています" : "語源の解説を生成"}
                    </button>
                  )}

                  <div className="pt-6 border-t border-[#EAECEF] flex flex-col items-start gap-4">
                    <button
                      onClick={() => selected.data && onWordClick?.(selected.data)}
                      className="btn-quiet px-0 text-sm"
                    >
                      詳細を開く
                    </button>
                  </div>
                </>
              )}

              {/*
                房ごと復習に回す。
                同じ語根や近い意味の語はまとめて出したほうが弁別が効く。
                「似ているけれど違う」を並べて確かめるのが、混同を潰す近道。
              */}
              {onReviewWords && selectedCluster && selectedCluster.words.length >= 2 && (
                <div className="mt-8 pt-6 border-t border-[#EAECEF]">
                  <p className="section-label mb-3">この房</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5 mb-4">
                    {selectedCluster.words.slice(0, 12).map((w) => (
                      <span key={w.id} className="text-[11px] font-bold text-[#656E77]">
                        {w.word}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => onReviewWords(selectedCluster.words)}
                    className="text-xs font-bold text-[#2A5CFF] border-b border-[#2A5CFF] flex items-center gap-1.5"
                  >
                    <BrainCircuit className="w-3.5 h-3.5" />
                    この房の {selectedCluster.words.length} 語をまとめて復習
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
