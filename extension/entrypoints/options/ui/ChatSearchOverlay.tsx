import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Chat, SearchHit, SearchMode } from "@/lib/types";
import { useChatSearch } from "./useChatSearch";
import { highlightMatched, isApproxHit } from "./search";
import * as I from "./icons";

const MODES: { id: SearchMode; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: "hybrid", label: "Smart", icon: <I.Sparkle size={13} />, hint: "Meaning + exact words" },
  { id: "keyword", label: "Keyword", icon: <I.Type size={13} />, hint: "Exact words" },
  { id: "fuzzy", label: "Fuzzy", icon: <I.Wave size={13} />, hint: "Typo-tolerant" },
  { id: "semantic", label: "Meaning", icon: <I.Brain size={13} />, hint: "By meaning" },
];

/** The advanced in-chat search: a centered overlay that runs the full ranking
 *  engine (keyword / fuzzy / semantic / smart) scoped to this one chat and lists
 *  matched turns with rich context. Jumping closes it, scrolls to the turn, and
 *  highlights the matched part in the reader. */
export function ChatSearchOverlay({
  chat, initialQuery, initialMode = "hybrid", onJump, onClose,
}: {
  chat: Chat;
  initialQuery: string;
  initialMode?: SearchMode;
  /** The full hit is passed in-process (no URL length limit) so the destination
   *  can highlight exactly what matched — matchedTerms + field included. */
  onJump: (hit: SearchHit, mode: SearchMode, query: string) => void;
  onClose: () => void;
}) {
  const cs = useChatSearch(chat);
  const [mode, setMode] = useState<SearchMode>(initialMode);
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [rankedBy, setRankedBy] = useState("");
  const [semanticUsed, setSemanticUsed] = useState(false);
  const [timingMs, setTimingMs] = useState(0);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const usesVectors = mode === "hybrid" || mode === "semantic";

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // Debounced, cancellable scoped search.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setRankedBy(""); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const started = performance.now();
      try {
        const out = await cs.search(mode, q);
        if (cancelled) return;
        setHits(out.hits);
        setRankedBy(out.rankedBy);
        setSemanticUsed(out.semanticUsed);
        setTimingMs(Math.round(performance.now() - started));
        setSel(0);
      } catch {
        if (!cancelled) { setHits([]); setRankedBy(""); }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, mode, cs.search]); // eslint-disable-line react-hooks/exhaustive-deps

  const showPct = mode === "semantic" || mode === "hybrid";

  const jump = (h: SearchHit) => onJump(h, mode, query.trim());

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { const h = hits[sel] || hits[0]; if (h) jump(h); }
  };

  const rankLabel = rankedBy === "smart" ? (semanticUsed ? "meaning + words" : "words")
    : rankedBy === "semantic" ? "meaning" : rankedBy === "fuzzy" ? "fuzzy" : rankedBy === "keyword" ? "keywords" : "";

  const sortedHits = useMemo(() => hits, [hits]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cs-modal" role="dialog" aria-modal="true" aria-label="Search this chat" onClick={(e) => e.stopPropagation()}>
        <div className="cs-search">
          <I.Search size={18} />
          <input ref={inputRef} value={query} placeholder="Search this conversation — meaning, keywords, or typos…"
            autoComplete="off" spellCheck={false} aria-label="Search this conversation"
            onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          {query && <button className="iconbtn" title="Clear" aria-label="Clear" onClick={() => { setQuery(""); inputRef.current?.focus(); }}><I.Close size={16} /></button>}
          <button className="iconbtn" title="Close (Esc)" aria-label="Close" onClick={onClose}><I.Close size={18} /></button>
        </div>

        <div className="cs-modes" role="tablist">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} title={m.hint}
              className={"mode-chip" + (mode === m.id ? " active" : "")} onClick={() => setMode(m.id)}>
              {m.icon} {m.label}
            </button>
          ))}
        </div>

        {usesVectors && !cs.vectorsReady && (
          <div className="cs-note">
            <I.Brain size={14} /> Vector index not built — showing word/fuzzy results. Build it in Settings for true meaning search.
          </div>
        )}

        <div className="cs-meta">
          {searching ? "Searching…" : query.trim()
            ? <>{sortedHits.length} match{sortedHits.length === 1 ? "" : "es"}{rankLabel && <span className="rank-badge">ranked by {rankLabel} · {timingMs}ms</span>}</>
            : "Type to search this conversation."}
        </div>

        <div className="cs-results">
          {!searching && query.trim() && sortedHits.length === 0 && (
            <div className="empty" style={{ padding: 28 }}>No matches. Try Smart or Meaning mode for broader results.</div>
          )}
          {sortedHits.map((h, i) => {
            const approx = isApproxHit(h, query);
            return (
            <button key={h.segment.id} className={"cs-card" + (i === sel ? " on" : "")}
              onMouseEnter={() => setSel(i)} onClick={() => jump(h)}>
              <div className="cs-card-head">
                <span className="cs-turn">#{h.segment.turnIndex + 1}</span>
                {h.segment.question && (
                  <span className="cs-q" dangerouslySetInnerHTML={{ __html: highlightMatched(clip(h.segment.question, 140), h, query) }} />
                )}
                {h.field && <span className={"gh-field " + h.field} title={h.field === "answer" ? "Matched in the answer" : "Matched in the question"}>{h.field === "answer" ? "A" : "Q"}</span>}
                {approx && <span className="gh-approx" title="Matched by meaning, not exact words">≈ meaning</span>}
                {showPct && <span className="cs-score">{Math.round(h.score * 100)}%</span>}
              </div>
              <div className="cs-snip" dangerouslySetInnerHTML={{ __html: highlightMatched(h.snippet, h, query) }} />
            </button>
            );
          })}
        </div>

        <div className="modal-foot">
          <span className="dim">↑/↓ to move · Enter to open · Esc to close</span>
        </div>
      </div>
    </div>
  );
}

function clip(s: string, n: number): string {
  s = s.trim();
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}
