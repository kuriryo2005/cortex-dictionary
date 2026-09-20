import { SavedWord } from "../types";

/**
 * 単語のつながり図（KnowledgeMap）のデータ作成。
 *
 * 描画から切り離してここに置く。理由は二つある。
 *   - canvas 描画のコードに混ざっていると、線が引かれない原因を追えない
 *   - scripts/verify-graph.ts から素の関数として検証できる
 */

export type GraphLayer = "etymology" | "synonym" | "antonym";

export type NodeKind = "word" | "root" | "ghost";

export interface MapNode {
  id: string;
  kind: NodeKind;
  /** 画面に出す文字。語根ノードは語根そのもの */
  label: string;
  meaning: string;
  /** 語根ノードだけ持つ。展開 API に渡す */
  root?: string;
  /** 0..1。語ノードは importanceScore、それ以外は隣接数から決める */
  importance: number;
  /** 隣接する「保存済みの語」の数。語根とゴーストの大きさに使う */
  degree: number;
  /** 復習の遅れ。0 なら遅れていない */
  daysOverdue: number;
  /**
   * 連結成分の番号。同じ房に属するノードは同じ番号を持つ。
   * 房ごとに色を変えるために使う（線を目で追わなくても仲間が分かる）。
   */
  cluster: number;
  data?: SavedWord;
}

export interface MapLink {
  source: string;
  target: string;
  kind: "root" | "direct" | "synonym" | "antonym";
  /** 線に添える語根。direct / synonym / antonym では空 */
  label: string;
}

export interface MapGraph {
  nodes: MapNode[];
  links: MapLink[];
  /** 房の一覧。大きい順 */
  clusters: Cluster[];
  /** ノード id → 隣接ノード id。焦点表示とハイライトで使う */
  adjacency: Map<string, Set<string>>;
}

export interface Cluster {
  id: number;
  /** その房に含まれる保存済みの語 */
  words: SavedWord[];
  /** 房の中心にある語根（語源レイヤーのとき）。無ければ空 */
  roots: string[];
  size: number;
}

const DAY = 1000 * 60 * 60 * 24;

/**
 * 語根を突き合わせる用の鍵に直す。
 *
 * AI は "spect", "spect (to look)", "-spect-", "SPECT" のように揺れた形で返す。
 * 揺れたままだと同じ語根が別ノードに割れて、房ができない。
 */
export function rootKey(raw: unknown): string {
  const text = String(raw ?? "").toLowerCase();
  // 括弧の中は語根ではなく語義なので落とす
  const head = text.split(/[(（]/)[0];
  const letters = head.replace(/[^a-z]/g, "");
  // 1文字は語根として意味を成さない（ノイズで房が繋がってしまう）
  return letters.length >= 2 ? letters : "";
}

function wordKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

function overdueDays(word: SavedWord): number {
  if (!word.nextReviewAt) return 0;
  return Math.max(0, (Date.now() - word.nextReviewAt) / DAY);
}

/**
 * 語源レイヤーは「語 → 語根 → 語」で組む。
 *
 * 以前は語 A の etymologyNodes に語 B が載っているときだけ A—B を結んでいた。
 * これは AI がその語を挙げたかどうかに依存するので、同じ語根を持つ inspect と
 * respect を両方保存していても線が出ないことがあった。語根を中間ノードにすると、
 * 同じ語根の語は列挙の有無に関係なく必ず一つの房に集まる。
 */
export function buildGraph(words: SavedWord[], layers: GraphLayer | GraphLayer[]): MapGraph {
  // レイヤーは重ねられる。語源だけでは孤立して見える語も、類義語を重ねると
  // どこかの房につながることがある。「つながり」を見る図なので、
  // 排他のタブより重ね合わせのほうが目的に合う。
  const active = new Set<GraphLayer>(Array.isArray(layers) ? layers : [layers]);

  const nodes: MapNode[] = [];
  const byId = new Map<string, MapNode>();
  /** 保存済みの語だけを引く索引。ゴーストは入れない */
  const savedByWord = new Map<string, MapNode>();
  const links: MapLink[] = [];
  const seenLink = new Set<string>();
  /** 語根/ゴーストごとの、隣接する保存済み語の集合 */
  const neighbors = new Map<string, Set<string>>();

  const push = (node: MapNode): MapNode => {
    const existing = byId.get(node.id);
    if (existing) return existing;
    nodes.push(node);
    byId.set(node.id, node);
    return node;
  };

  const connect = (from: MapNode, to: MapNode, kind: MapLink["kind"], label: string) => {
    if (from.id === to.id) return;
    // 向きは意味を持たないので、両向きの重複を一つにまとめる
    const key = [from.id, to.id].sort().join("|");
    if (seenLink.has(key)) return;
    seenLink.add(key);
    links.push({ source: from.id, target: to.id, kind, label });

    for (const [a, b] of [
      [from, to],
      [to, from],
    ] as const) {
      if (a.kind !== "word") continue;
      const set = neighbors.get(b.id) ?? new Set<string>();
      set.add(a.id);
      neighbors.set(b.id, set);
    }
  };

  for (const word of words) {
    if (!word.word) continue;
    const node = push({
      id: word.id,
      kind: "word",
      label: word.word,
      meaning: word.meaning ?? "",
      importance: typeof word.importanceScore === "number" ? word.importanceScore : 0.5,
      degree: 0,
      daysOverdue: overdueDays(word),
      cluster: -1,
      data: word,
    });
    savedByWord.set(wordKey(word.word), node);
  }

  /** 未保存の関連語。押せば検索に回せるので、行き止まりにはしない */
  const ghostFor = (label: string, meaning: string): MapNode =>
    push({
      id: `ghost:${wordKey(label)}`,
      kind: "ghost",
      label,
      meaning,
      importance: 0.3,
      degree: 0,
      daysOverdue: 0,
      cluster: -1,
    });

  if (active.has("etymology")) {
    for (const word of words) {
      const self = byId.get(word.id);
      if (!self) continue;

      for (const ref of word.etymologyNodes ?? []) {
        if (!ref?.word) continue;
        const rk = rootKey(ref.root);
        const refKey = wordKey(ref.word);
        const target =
          savedByWord.get(refKey) ?? (refKey === wordKey(word.word) ? self : ghostFor(ref.word, ref.meaning ?? ""));

        if (!rk) {
          // 語根が取れないデータは、従来どおり語どうしを直接結ぶ
          connect(self, target, "direct", "");
          continue;
        }

        const root = push({
          id: `root:${rk}`,
          kind: "root",
          label: ref.root ? String(ref.root).split(/[(（]/)[0].trim() : rk,
          meaning: ref.relation ?? "",
          root: rk,
          importance: 0.5,
          degree: 0,
          daysOverdue: 0,
          cluster: -1,
        });
        // 語義の説明は、空でない最初のものを採用する
        if (!root.meaning && ref.relation) root.meaning = ref.relation;

        connect(self, root, "root", root.label);
        connect(target, root, "root", root.label);
      }
    }
  }

  if (active.has("synonym")) {
    for (const word of words) {
      const self = byId.get(word.id);
      if (!self) continue;
      for (const syn of word.synonyms ?? []) {
        if (!syn?.word) continue;
        const target =
          savedByWord.get(wordKey(syn.word)) ??
          ghostFor(syn.word, syn.translation ?? "");
        connect(self, target, "synonym", "");
      }
    }
  }

  if (active.has("antonym")) {
    for (const word of words) {
      const self = byId.get(word.id);
      if (!self) continue;
      for (const ant of word.antonyms ?? []) {
        if (!ant?.word) continue;
        const target =
          savedByWord.get(wordKey(ant.word)) ??
          ghostFor(ant.word, ant.translation ?? "");
        connect(self, target, "antonym", "");
      }
    }
  }

  for (const node of nodes) {
    node.degree = neighbors.get(node.id)?.size ?? 0;
    if (node.kind !== "word") {
      // 保存済みの語をたくさん抱える語根ほど大きく描く
      node.importance = Math.min(1, 0.2 + node.degree * 0.2);
    }
  }

  const adjacency = buildAdjacency(nodes, links);
  const clusters = assignClusters(nodes, adjacency);

  return { nodes, links, clusters, adjacency };
}

/** ノード id → 隣接ノード id。ゴーストも語根も含む素の隣接関係。 */
function buildAdjacency(nodes: MapNode[], links: MapLink[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const link of links) {
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }
  return adjacency;
}

/**
 * 連結成分に番号を振る。
 *
 * 房ごとに色を変えるのが目的。線の色だけで区別させると、線が交差した
 * 瞬間にどれが同じ仲間か分からなくなる。
 */
function assignClusters(nodes: MapNode[], adjacency: Map<string, Set<string>>): Cluster[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clusters: Cluster[] = [];
  let next = 0;

  for (const start of nodes) {
    if (start.cluster !== -1) continue;

    const id = next++;
    const members: MapNode[] = [];
    const stack = [start];
    start.cluster = id;

    while (stack.length > 0) {
      const node = stack.pop()!;
      members.push(node);
      for (const neighborId of adjacency.get(node.id) ?? []) {
        const neighbor = byId.get(neighborId);
        if (!neighbor || neighbor.cluster !== -1) continue;
        neighbor.cluster = id;
        stack.push(neighbor);
      }
    }

    clusters.push({
      id,
      words: members.filter((n) => n.kind === "word" && n.data).map((n) => n.data!),
      roots: members.filter((n) => n.kind === "root").map((n) => n.label),
      size: members.length,
    });
  }

  clusters.sort((a, b) => b.words.length - a.words.length || b.size - a.size);
  return clusters;
}

/**
 * どこともつながっていない語。
 *
 * 図の端に点として散っているだけで見落とされるが、実際にはいちばん
 * 手が届いていない語でもある。一覧にして取り出せるようにする。
 */
export function isolatedWords(graph: MapGraph): SavedWord[] {
  return graph.nodes
    .filter((n) => n.kind === "word" && n.degree === 0 && (graph.adjacency.get(n.id)?.size ?? 0) === 0)
    .map((n) => n.data!)
    .filter(Boolean);
}

/**
 * ある節点から n 歩でたどり着ける範囲。焦点表示に使う。
 */
export function neighborhood(graph: MapGraph, rootId: string, depth = 2): Set<string> {
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];

  for (let d = 0; d < depth; d++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      for (const neighborId of graph.adjacency.get(id) ?? []) {
        if (seen.has(neighborId)) continue;
        seen.add(neighborId);
        nextFrontier.push(neighborId);
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return seen;
}

/** 語根ノードのうち、まだ1語しか押さえていないもの。次に伸ばす余地がある */
export function thinRoots(graph: MapGraph): MapNode[] {
  return graph.nodes
    .filter((n) => n.kind === "root" && n.degree === 1)
    .sort((a, b) => a.label.localeCompare(b.label));
}
