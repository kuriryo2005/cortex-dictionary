/**
 * 英文ペーストから未知語を一括抽出するモーダル（実装仕様書 F5）。
 *
 * 保存は「単語 + 短い意味」だけの軽量ドキュメントで即座に行い、詳細は
 * useEnrichQueue がバックグラウンドで埋める。1語ずつフル生成すると
 * 30語で数分待たされて実用にならないため。
 */

import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, X, ClipboardPaste, Check } from "lucide-react";
import { Input } from "./ui/input";
import { toast } from "sonner";
import { DictionaryMode, Deck, ExtractedCandidate, SavedWord } from "../types";
import { extractCandidates } from "../services/geminiService";
import { saveWords, SaveLimitError } from "../services/wordService";
import { dedupeTags } from "../lib/filter";
import { toWordLower } from "../lib/normalize";

const MAX_TEXT = 8000;
const MAX_SAVE = 50;

interface Props {
  open: boolean;
  onClose: () => void;
  uid: string;
  words: SavedWord[];
  decks: Deck[];
  mode: DictionaryMode;
}

/** 難易度は文字色だけで区別する（背景で塗り分けると囲みに見えるため） */
const LEVEL_STYLE: Record<string, string> = {
  B2: "text-[#8A9199]",
  C1: "text-[#2A5CFF]",
  C2: "text-[#7C3AED]",
  technical: "text-[#EA580C]",
};

export const BulkExtractModal: React.FC<Props> = ({ open, onClose, uid, words, decks, mode }) => {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<ExtractedCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deckId, setDeckId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  const knownSet = useMemo(
    () => new Set(words.map((w) => w.wordLower ?? toWordLower(w.word))),
    [words]
  );

  const reset = () => {
    setText("");
    setTitle("");
    setCandidates(null);
    setSelected(new Set());
    setTagInput("");
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleExtract = async () => {
    const body = text.trim();
    if (!body) {
      toast.error("英文を貼り付けてください。");
      return;
    }

    setBusy(true);
    try {
      const known = [...knownSet].slice(0, 2000);
      const result = await extractCandidates(body.slice(0, MAX_TEXT), known);
      const fresh = result.filter((c) => !knownSet.has(toWordLower(c.word)));

      setCandidates(result);
      // 既定の選択は C1 以上と technical、かつ未保存のもの
      setSelected(
        new Set(fresh.filter((c) => c.level !== "B2").map((c) => toWordLower(c.word)))
      );

      if (result.length === 0) toast.info("抽出できる単語がありませんでした。");
      else toast.success(`${result.length} 語の候補が見つかりました（未保存 ${fresh.length} 語）`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "抽出に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (word: string) => {
    const key = toWordLower(word);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    if (!candidates) return;
    const picked = candidates.filter(
      (c) => selected.has(toWordLower(c.word)) && !knownSet.has(toWordLower(c.word))
    );

    if (picked.length === 0) {
      toast.error("保存する単語を選んでください。");
      return;
    }
    if (picked.length > MAX_SAVE) {
      toast.error(`一度に保存できるのは ${MAX_SAVE} 語までです。`);
      return;
    }

    setBusy(true);
    try {
      const tags = dedupeTags(tagInput.split(",").map((t) => t.trim()).filter(Boolean));
      const now = Date.now();
      const excerpt = text.trim().slice(0, 200);
      // 保存はサーバー経由（無料プランの上限を強制するため）
      const rows: Record<string, unknown>[] = [];

      for (const c of picked) {
        // 空文字にできるのは grammar 以下だけ。meaning が空だと
        // セキュリティルールの isValidWord を通らない。
        rows.push({
          word: c.word,
          wordLower: toWordLower(c.word),
          meaning: c.meaningShort,
          grammar: "",
          category: "",
          etymology: "",
          nuance: "",
          specializedContexts: [],
          examples: [],
          collocations: [],
          synonyms: [],
          antonyms: [],
          etymologyNodes: [],
          importanceScore: 0.5,
          userId: uid,
          timestamp: now,
          mode,
          tags,
          deckId,
          schemaVersion: 2,
          enrichStatus: "pending",
          source: { title: title.trim().slice(0, 100), excerpt, importedAt: now },
          updatedAt: now,
        });
      }

      await saveWords(rows, "extract");
      toast.success(`${picked.length} 語を保存しました。詳細は順次生成されます。`);
      reset();
      onClose();
    } catch (e) {
      console.error(e);
      // 上限や Pro 限定は理由が分かるメッセージが来るので、そのまま見せる
      toast.error(e instanceof SaveLimitError ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const selectableCount = candidates
    ? candidates.filter((c) => selected.has(toWordLower(c.word)) && !knownSet.has(toWordLower(c.word)))
        .length
    : 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] bg-black/30 flex items-center justify-center p-4"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[88vh] bg-white flex flex-col overflow-hidden"
          >
            <div className="flex items-start justify-between gap-4 px-8 pt-8 pb-6">
              <div>
                <h2 className="text-lg font-black text-[#1A1C1E]">英文から単語を追加</h2>
                <p className="text-xs text-[#8A9199] mt-1">
                  英文を貼り付けると、保存していない語を抽出します。
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="w-8 h-8 shrink-0 flex items-center justify-center text-[#8A9199] hover:text-[#1A1C1E]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-8 border-t border-[#EAECEF] pt-6">
              {!candidates ? (
                <>
                  <Input
                    placeholder="出典タイトル（任意）"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="field h-10 text-sm mb-6"
                  />
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT))}
                    placeholder="ここに英文を貼り付けてください"
                    className="w-full h-64 bg-transparent border-0 border-b border-[#E5E7EB] rounded-none px-0 py-2 focus:border-[#1A1C1E] outline-none text-sm leading-loose resize-none"
                  />
                  <div className="flex justify-between items-center text-[11px] text-[#8A9199] mt-3">
                    <span className="tabular-nums">
                      {text.length} / {MAX_TEXT} 文字
                    </span>
                    <span>保存済みの {knownSet.size} 語は候補から除外されます</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap gap-x-6 gap-y-2 items-end mb-6">
                    <select
                      value={deckId ?? ""}
                      onChange={(e) => setDeckId(e.target.value || null)}
                      className="h-9 bg-transparent border-0 border-b border-[#E5E7EB] rounded-none text-xs font-bold focus:outline-none"
                    >
                      <option value="">未分類</option>
                      {decks.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <Input
                      placeholder="タグ（カンマ区切り・任意）"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      className="field h-9 flex-1 min-w-[160px] text-xs"
                    />
                  </div>

                  <div>
                    {candidates.map((c) => {
                      const key = toWordLower(c.word);
                      const saved = knownSet.has(key);
                      const checked = selected.has(key) && !saved;

                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={saved}
                          onClick={() => toggle(c.word)}
                          title={c.sentence}
                          className={`w-full text-left py-3 border-t border-[#F1F3F5] first:border-t-0 flex items-start gap-3 transition-opacity ${
                            saved ? "opacity-35 cursor-not-allowed" : ""
                          }`}
                        >
                          <span
                            className={`w-4 h-4 mt-1 shrink-0 border flex items-center justify-center ${
                              checked ? "bg-[#1A1C1E] border-[#1A1C1E]" : "border-[#C9CDD2]"
                            }`}
                          >
                            {checked && <Check className="w-3 h-3 text-white" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <span className="font-bold text-sm text-[#1A1C1E]">{c.word}</span>
                              <span
                                className={`text-[10px] font-bold uppercase tracking-wider ${
                                  LEVEL_STYLE[c.level] ?? LEVEL_STYLE.C1
                                }`}
                              >
                                {c.level}
                              </span>
                              {saved && <span className="text-[10px] text-[#8A9199]">保存済み</span>}
                            </div>
                            <p className="text-[11px] text-[#656E77] mt-0.5">{c.meaningShort}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="px-8 pt-6 pb-8 border-t border-[#EAECEF] flex items-center gap-8">
              {!candidates ? (
                <button
                  type="button"
                  onClick={handleExtract}
                  disabled={busy || !text.trim()}
                  className="btn-primary"
                >
                  {busy ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      抽出中
                    </>
                  ) : (
                    <>
                      <ClipboardPaste className="w-4 h-4" />
                      単語を抽出
                    </>
                  )}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={busy || selectableCount === 0}
                    className="btn-primary"
                  >
                    {busy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      `${selectableCount} 語を保存`
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCandidates(null)}
                    disabled={busy}
                    className="text-sm font-bold text-[#8A9199] hover:text-[#1A1C1E] disabled:opacity-30"
                  >
                    戻る
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
