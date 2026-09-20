/**
 * 語源ページを作る対象の語根リスト（手で選んだもの）。
 *
 * Firestore の `etymologyNodes[].root` は AI が自由に書いているため、
 * "ulterior/ultimus" のようなラテン語原形だったり "16世紀英語" のような
 * 分類語だったりして、そのままでは束ねられなかった。
 *
 * そこで、英語の中で実際に生産的に働いている語根だけを人手で選び、
 * 「綴りに含まれる」かつ「語源の説明文に出典が現れる」の両方を満たす語だけを
 * そのルートに集める。この二重条件により、"portion" を port（運ぶ）に
 * 誤って入れるような取り違えを防ぐ。
 *
 * - `root`    … ページの見出しになる語根（URL にもなる）
 * - `meaning` … 日本語の意味
 * - `forms`   … 綴りの上で現れる異形。どれか1つを含めば候補になる
 * - `sources` … 語源の説明文に現れるべき語（ラテン語・ギリシャ語の原形など）
 */

export interface RootEntry {
  root: string;
  meaning: string;
  forms: string[];
  sources: string[];
}

export const ROOTS: RootEntry[] = [
  { root: "spect", meaning: "見る", forms: ["spect", "spic"], sources: ["specere", "spectare", "spectus"] },
  { root: "dict", meaning: "言う", forms: ["dict"], sources: ["dicere", "dictus"] },
  { root: "duc", meaning: "導く", forms: ["duc", "duct"], sources: ["ducere", "ductus"] },
  { root: "fer", meaning: "運ぶ", forms: ["fer"], sources: ["ferre"] },
  { root: "port", meaning: "運ぶ", forms: ["port"], sources: ["portare"] },
  { root: "ject", meaning: "投げる", forms: ["ject", "jac"], sources: ["iacere", "jacere", "jactus"] },
  { root: "mit", meaning: "送る", forms: ["mit", "miss"], sources: ["mittere", "missus"] },
  { root: "pon", meaning: "置く", forms: ["pon", "pos"], sources: ["ponere", "positus"] },
  { root: "tend", meaning: "伸ばす・張る", forms: ["tend", "tens"], sources: ["tendere", "tensus"] },
  { root: "ten", meaning: "保つ", forms: ["ten", "tain", "tin"], sources: ["tenere"] },
  { root: "cap", meaning: "取る・つかむ", forms: ["cap", "cept", "cip"], sources: ["capere", "captus"] },
  { root: "struct", meaning: "積み上げる", forms: ["struct", "stru"], sources: ["struere", "structus"] },
  { root: "scrib", meaning: "書く", forms: ["scrib", "script"], sources: ["scribere", "scriptus"] },
  { root: "vert", meaning: "向きを変える", forms: ["vert", "vers"], sources: ["vertere", "versus"] },
  { root: "ced", meaning: "行く・譲る", forms: ["ced", "cess", "ceed"], sources: ["cedere", "cessus"] },
  { root: "flu", meaning: "流れる", forms: ["flu", "flux"], sources: ["fluere", "fluxus"] },
  { root: "greg", meaning: "群れ", forms: ["greg"], sources: ["grex", "gregis"] },
  { root: "vid", meaning: "見る", forms: ["vid", "vis"], sources: ["videre", "visus"] },
  { root: "aud", meaning: "聞く", forms: ["aud"], sources: ["audire"] },
  { root: "sent", meaning: "感じる", forms: ["sent", "sens"], sources: ["sentire", "sensus"] },
  { root: "cogn", meaning: "知る", forms: ["cogn", "gnos"], sources: ["cognoscere", "gnoscere", "noscere"] },
  { root: "sci", meaning: "知る", forms: ["sci"], sources: ["scire"] },
  { root: "cred", meaning: "信じる", forms: ["cred"], sources: ["credere"] },
  { root: "fid", meaning: "信頼する", forms: ["fid"], sources: ["fides", "fidere"] },
  { root: "volv", meaning: "回る・巻く", forms: ["volv", "volut"], sources: ["volvere", "volutus"] },
  { root: "rupt", meaning: "破れる", forms: ["rupt"], sources: ["rumpere", "ruptus"] },
  { root: "tract", meaning: "引く", forms: ["tract", "trah"], sources: ["trahere", "tractus"] },
  { root: "press", meaning: "押す", forms: ["press", "prim"], sources: ["premere", "pressus"] },
  { root: "pel", meaning: "駆り立てる", forms: ["pel", "puls"], sources: ["pellere", "pulsus"] },
  { root: "sist", meaning: "立つ", forms: ["sist", "stan", "stat"], sources: ["sistere", "stare", "status"] },
  { root: "sequ", meaning: "従う", forms: ["sequ", "secut", "sue"], sources: ["sequi", "secutus"] },
  { root: "plic", meaning: "折る・畳む", forms: ["plic", "plex", "ply"], sources: ["plicare", "plexus"] },
  { root: "lig", meaning: "結ぶ", forms: ["lig", "leag"], sources: ["ligare"] },
  { root: "solv", meaning: "解く", forms: ["solv", "solut"], sources: ["solvere", "solutus"] },
  { root: "grad", meaning: "歩む・段階", forms: ["grad", "gress"], sources: ["gradi", "gressus", "gradus"] },
  { root: "ven", meaning: "来る", forms: ["ven", "vent"], sources: ["venire", "ventus"] },
  { root: "curr", meaning: "走る", forms: ["curr", "curs", "cour"], sources: ["currere", "cursus"] },
  { root: "leg", meaning: "選ぶ・読む", forms: ["leg", "lect"], sources: ["legere", "lectus"] },
  { root: "fac", meaning: "作る・なす", forms: ["fac", "fect", "fic"], sources: ["facere", "factus"] },
  { root: "gen", meaning: "生む・種", forms: ["gen"], sources: ["genus", "gignere", "generare"] },
  { root: "mor", meaning: "死", forms: ["mor", "mort"], sources: ["mors", "mori", "mortis"] },
  { root: "vit", meaning: "生命", forms: ["vit", "viv"], sources: ["vita", "vivere"] },
  { root: "man", meaning: "手", forms: ["man", "manu"], sources: ["manus"] },
  { root: "ped", meaning: "足", forms: ["ped"], sources: ["pes", "pedis"] },
  { root: "corp", meaning: "体", forms: ["corp"], sources: ["corpus"] },
  { root: "anim", meaning: "心・息", forms: ["anim"], sources: ["animus", "anima"] },
  { root: "temp", meaning: "時", forms: ["temp"], sources: ["tempus", "temporis"] },
  { root: "loc", meaning: "場所", forms: ["loc"], sources: ["locus"] },
  { root: "terr", meaning: "地", forms: ["terr"], sources: ["terra"] },
  { root: "aqu", meaning: "水", forms: ["aqu"], sources: ["aqua"] },
  { root: "lum", meaning: "光", forms: ["lum", "lustr"], sources: ["lumen", "lux", "lucere"] },
  { root: "therm", meaning: "熱", forms: ["therm"], sources: ["thermos", "θερμ"] },
  { root: "dynam", meaning: "力", forms: ["dynam"], sources: ["dynamis"] },
  { root: "morph", meaning: "形", forms: ["morph"], sources: ["morphe"] },
  { root: "graph", meaning: "書く・描く", forms: ["graph", "gram"], sources: ["graphein", "gramma"] },
  { root: "log", meaning: "言葉・理", forms: ["log"], sources: ["logos"] },
  { root: "path", meaning: "感情・苦しみ", forms: ["path"], sources: ["pathos"] },
  { root: "phon", meaning: "音", forms: ["phon"], sources: ["phone"] },
  { root: "chron", meaning: "時", forms: ["chron"], sources: ["chronos"] },
  { root: "meter", meaning: "測る", forms: ["meter", "metr"], sources: ["metron"] },
  { root: "scop", meaning: "見る", forms: ["scop"], sources: ["skopein"] },
  { root: "photo", meaning: "光", forms: ["photo", "phos"], sources: ["phos", "photos"] },
  { root: "hydr", meaning: "水", forms: ["hydr"], sources: ["hydor"] },
  { root: "geo", meaning: "地球", forms: ["geo"], sources: ["ge", "geo"] },
  { root: "bio", meaning: "生命", forms: ["bio"], sources: ["bios"] },
];
