import React, { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { EtymologyNode } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { Maximize2, Minimize2, ZoomIn, ZoomOut, Loader2 } from "lucide-react";
import { expandEtymologyRoot } from "../services/geminiService";

interface Props {
  mainWord: string;
  nodes: EtymologyNode[];
}

export const EtymologyGraph: React.FC<Props> = ({ mainWord, nodes }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<any>(null);
  
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [graphData, setGraphData] = useState<{ nodes: any[], links: any[] }>({ nodes: [], links: [] });
  const [isExpanding, setIsExpanding] = useState(false);

  // Initialize graph data
  useEffect(() => {
    // 同じ語が二重に並ばないようにする。
    //
    // AI は etymologyNodes に検索語そのものを混ぜてくることがある（大文字小文字
    // 違いも含む）。そのまま渡すと id が重複し、d3.forceLink は **後勝ち**で
    // id を引くので、リンクが白いほうのノードに付き、主役の青いノードだけが
    // どことも繋がらずに浮く。実際に lexi でその状態が出た。
    const seen = new Set<string>();
    const key = (w: string) => w.trim().toLowerCase();

    const initialNodes: any[] = [
      { id: mainWord, group: 1, label: mainWord, isMain: true, meaning: "Current Word" },
    ];
    seen.add(key(mainWord));

    for (const n of nodes) {
      if (!n.word) continue;
      const k = key(n.word);
      if (seen.has(k)) {
        // 検索語と同じ語なら、主役ノードに語根の情報だけ移して捨てる。
        if (k === key(mainWord) && n.root && !initialNodes[0].root) {
          initialNodes[0].root = n.root;
        }
        continue;
      }
      seen.add(k);
      initialNodes.push({
        id: n.word,
        group: 2,
        label: n.word,
        meaning: n.meaning,
        root: n.root,
        relation: n.relation,
        isMain: false,
      });
    }

    const initialLinks = initialNodes
      .filter((n) => !n.isMain)
      .map((n) => ({ source: mainWord, target: n.id }));

    setGraphData({ nodes: initialNodes, links: initialLinks });
  }, [mainWord, nodes]);

  const handleExpandRoot = useCallback(async (root: string, sourceWord: string) => {
    if (isExpanding) return;
    setIsExpanding(true);

    try {
      // API キーはサーバー側にのみ存在するため、自前の API 経由で取得する
      const newWords = await expandEtymologyRoot(root);

      setGraphData(prev => {
        const existingNodeIds = new Set(prev.nodes.map(n => String(n.id).trim().toLowerCase()));
        const addedNodes = newWords
          .filter((nw: any) => {
            const k = String(nw.word ?? "").trim().toLowerCase();
            if (!k || existingNodeIds.has(k)) return false;
            // 同じ呼び出しの中にも同語が複数返ることがある
            existingNodeIds.add(k);
            return true;
          })
          .map((nw: any) => ({
            id: nw.word,
            group: 3,
            label: nw.word,
            meaning: nw.meaning,
            root: nw.root,
            relation: `Expanded from root '${root}' via ${sourceWord}`,
            isMain: false,
            x: Math.random() * 600,
            y: Math.random() * 400
          }));

        const addedLinks = addedNodes.map((an: any) => ({
          source: sourceWord,
          target: an.id
        }));

        return {
          nodes: [...prev.nodes, ...addedNodes],
          links: [...prev.links, ...addedLinks]
        };
      });
    } catch (err) {
      console.error("Expansion failed:", err);
    } finally {
      setIsExpanding(false);
    }
  }, [isExpanding]);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || graphData.nodes.length === 0) return;

    let simulation: d3.Simulation<any, undefined>;

    const drawGraph = () => {
      if (!svgRef.current || !containerRef.current) return;
      
      const width = containerRef.current.clientWidth;
      const height = (window.innerWidth < 768 ? 300 : 400);

      const svg = d3.select(svgRef.current);
      svg.selectAll("*").remove();

      const g = svg.append("g");

      /**
       * 描画の直前に、もう一度だけ重複を落とす。
       *
       * データ側（初期化と展開）でも弾いているのに、展開を挟むと同じ語が
       * 二重に入り込むことが実際にあった。d3.forceLink は同じ id のうち
       * **後のノード**に線を結ぶので、そうなると主役の青いノードだけが
       * どこともつながらずに浮いて見える（obliviate で再発）。
       *
       * 原因を一つずつ潰すより、描く直前に必ず一意にしてしまうほうが確実。
       * リンクも id 文字列ではなく**ノードの実体**に解決してから渡すので、
       * d3 側の引き当てに委ねる余地がなくなる。
       */
      const nodeById = new Map<string, any>();
      for (const n of graphData.nodes) {
        const k = String(n.id).trim().toLowerCase();
        // 同じ語が二つあるときは主役（青）を優先して残す
        if (!nodeById.has(k) || n.isMain) nodeById.set(k, n);
      }
      const drawNodes = Array.from(nodeById.values());

      const resolve = (v: any) =>
        nodeById.get(String(v && v.id !== undefined ? v.id : v).trim().toLowerCase());
      const drawLinks = graphData.links
        .map((l: any) => ({ source: resolve(l.source), target: resolve(l.target) }))
        // 行き先を失ったリンクと自分自身へのリンクは描かない
        .filter((l: any) => l.source && l.target && l.source !== l.target);

      const zoom = d3.zoom()
        .scaleExtent([0.3, 4])
        .on("zoom", (event) => g.attr("transform", event.transform));
      svg.call(zoom as any);

      simulation = d3.forceSimulation(drawNodes)
        .force("link", d3.forceLink(drawLinks).id((d: any) => d.id).distance(window.innerWidth < 768 ? 80 : 100))
        .force("charge", d3.forceManyBody().strength(window.innerWidth < 768 ? -200 : -300))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("collision", d3.forceCollide().radius(window.innerWidth < 768 ? 35 : 45))
        // 既定のままだと落ち着くまで 300 ティック（約 1 秒）回り続け、その間
        // メインスレッドを握る。実測で、グラフを出した直後の操作が 1 秒遅れていた。
        // ここに並ぶのはせいぜい十数個のノードなので、そこまで時間をかける必要がない。
        .alphaDecay(0.06)
        .velocityDecay(0.5);

      simulationRef.current = simulation;

      // Links
      const linkPath = g.append("g")
        .selectAll(".link-path")
        .data(drawLinks)
        .join("g")
        .attr("class", "link-path");

      const linkLine = linkPath.append("line")
        .attr("stroke", "#2A5CFF")
        .attr("stroke-opacity", 0.15)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "4,4");

      const linkLabel = linkPath.append("g")
        .attr("class", "link-label")
        .attr("cursor", "pointer")
        .on("click", (event, d: any) => {
          // drawLinks の source / target は必ずノードの実体
          if (d.target?.root) handleExpandRoot(d.target.root, d.source.id);
        });

      linkLabel.append("rect")
        .attr("rx", 6)
        .attr("ry", 6)
        .attr("fill", "white")
        .attr("stroke", "#2A5CFF")
        .attr("stroke-opacity", 0.3)
        .attr("width", 50)
        .attr("height", 16)
        .attr("x", -25)
        .attr("y", -8);

      linkLabel.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.3em")
        .attr("font-size", "8px")
        .attr("font-weight", "900")
        .attr("fill", "#2A5CFF")
        .text((d: any) => d.target?.root || "");

      // Nodes
      const nodeGroup = g.append("g")
        .selectAll(".node")
        .data(drawNodes)
        .join("g")
        .attr("class", "node")
        .attr("cursor", "grab")
        .call(d3.drag()
          .on("start", (e, d: any) => {
            if (!e.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on("drag", (e, d: any) => {
            d.fx = e.x; d.fy = e.y;
          })
          .on("end", (e, d: any) => {
            if (!e.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          }) as any);

      nodeGroup.append("circle")
        .attr("r", (d: any) => d.isMain ? (window.innerWidth < 768 ? 28 : 32) : (window.innerWidth < 768 ? 22 : 26))
        .attr("fill", (d: any) => d.isMain ? "#2A5CFF" : d.group === 3 ? "#EBF1FF" : "#FFFFFF")
        .attr("stroke", "#2A5CFF")
        .attr("stroke-width", 2)
        .attr("stroke-opacity", (d: any) => d.isMain ? 1 : 0.3)
        .style("filter", (d: any) => d.isMain ? "drop-shadow(0 4px 12px rgba(42,92,255,0.4))" : "none");

      nodeGroup.append("text")
        .text((d: any) => d.label)
        .attr("text-anchor", "middle")
        .attr("dy", ".3em")
        .attr("fill", (d: any) => d.isMain ? "white" : "#1A1C1E")
        .attr("font-size", (d: any) => d.isMain ? (window.innerWidth < 768 ? "10px" : "12px") : (window.innerWidth < 768 ? "9px" : "10px"))
        .attr("font-weight", "900")
        .style("pointer-events", "none");

      nodeGroup.on("mouseenter", (event, d: any) => {
        setHoveredNode(d);
        setTooltipPos({ x: event.clientX, y: event.clientY });
        linkLine.transition().attr("stroke-opacity", (l: any) => 
          (l.source.id === d.id || l.target.id === d.id) ? 0.6 : 0.05
        );
      }).on("mouseleave", () => {
        setHoveredNode(null);
        linkLine.transition().attr("stroke-opacity", 0.15);
      });

      simulation.on("tick", () => {
        linkLine.attr("x1", (d:any)=>d.source.x).attr("y1", (d:any)=>d.source.y)
                .attr("x2", (d:any)=>d.target.x).attr("y2", (d:any)=>d.target.y);
        linkLabel.attr("transform", (d:any)=>`translate(${(d.source.x+d.target.x)/2},${(d.source.y+d.target.y)/2})`);
        nodeGroup.attr("transform", (d:any)=>`translate(${d.x},${d.y})`);
      });
    };

    drawGraph();

    const resizeObserver = new ResizeObserver(() => {
      drawGraph();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (simulation) simulation.stop();
      resizeObserver.disconnect();
    };
  }, [graphData, handleExpandRoot]);

  return (
    <div
      ref={containerRef}
      className="w-full h-[300px] md:h-[400px] border-t border-b border-[#EAECEF] overflow-hidden relative"
    >
      <div className="absolute top-4 left-0 z-10 pointer-events-none">
        <p className="text-[11px] text-[#8A9199]">語根をクリックすると関連する語を表示します</p>
      </div>

      {isExpanding && (
        <div className="absolute top-4 right-0 z-20 flex items-center gap-1.5 text-[11px] font-bold text-[#2A5CFF]">
          <Loader2 className="w-3 h-3 animate-spin" />
          読み込み中
        </div>
      )}

      <svg ref={svgRef} className="w-full h-full" />

      <AnimatePresence>
        {hoveredNode && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            style={{ position: 'fixed', left: tooltipPos.x + 15, top: tooltipPos.y - 100, zIndex: 1000 }}
            className="bg-[#1A1C1E] text-white p-4 shadow-lg w-[200px]"
          >
            <h5 className="text-sm font-black mb-1">{hoveredNode.label}</h5>
            <p className="text-xs text-blue-300 mb-2">{hoveredNode.meaning}</p>
            {hoveredNode.root && (
              <div className="pt-2 border-t border-white/10 text-[10px] text-gray-400">
                語根: <span className="text-white">{hoveredNode.root}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
