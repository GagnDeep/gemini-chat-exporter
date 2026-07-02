import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SearchHit, SearchMode } from "@/lib/types";
import { displayTitle } from "@/lib/meta";
import { useChats, useChatMeta, useSettings } from "./store";
import { segmentsFromChats, shortDate, relativeTime } from "./segments";
import { useSemanticIndex } from "./useSemanticIndex";
import { SearchIndex, segmentsSignature } from "./searchIndex";
import { parseQuery } from "./query";
import { runSearch, highlight, highlightMatched, isApproxHit, groupByChat, type ResultGroup, type SearchContext } from "./search";
import { JobBanner } from "./JobBanner";
import { VectorPrompt } from "./VectorPrompt";
import { navigate, chatLink } from "./App";
import * as I from "./icons";

const MODES: { id: SearchMode; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: "hybrid", label: "Smart", icon: <I.Sparkle size={14} />, hint: "Search everything — meaning + exact words. Try \"quotes\", -exclude, chat:title, has:code…" },
  { id: "keyword", label: "Keyword", icon: <I.Type size={14} />, hint: "Search exact words…" },
  { id: "fuzzy", label: "Fuzzy", icon: <I.Wave size={14} />, hint: "Typo-tolerant search…" },
  { id: "semantic", label: "Semantic", icon: <I.Brain size={14} />, hint: "Ask by meaning, e.g. “how do drones stay airborne?”" },
];

type DateFilter = "any" | "7d" | "30d" | "year";
type Sort = "relevance" | "recent";
type RoleFacet = "" | "question" | "answer";

const RECENTS_KEY = "recent-searches";
function loadRecents(): string[] { try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); } catch { return []; } }
function saveRecent(q: string) {
  q = q.trim(); if (q.length < 2) return;
  const next = [q, ...loadRecents().filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

function withinFilter(iso: string, f: DateFilter): boolean {
  if (f === "any") return true;
  const t = Date.parse(iso); if (!Number.isFinite(t)) return true;
  const days = f === "7d" ? 7 : f === "30d" ? 30 : 365;
  return Date.now() - t <= days * 86_400_000;
}

export function SearchView() {
  const chats = useChats();
  const meta = useChatMeta();
  const [settings] = useSettings();
  const rawSegments = useMemo(() => segmentsFromChats(chats), [chats]);
  const index = useSemanticIndex(rawSegments);

  // Prebuilt lexical index — rebuilt only when the segment SET changes.
  const sig = segmentsSignature(rawSegments);
  const lexIndex = useMemo(() => new SearchIndex(rawSegments), [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const pinnedIds = useMemo(() => new Set(chats.filter((c) => meta[c.id]?.pinned).map((c) => c.id)), [chats, meta]);

  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [rankedBy, setRankedBy] = useState<string>("");
  const [semanticUsed, setSemanticUsed] = useState(false);
  const [semanticError, setSemanticError] = useState<string>("");
  const [timingMs, setTimingMs] = useState(0);
  const [dateFilter, setDateFilter] = useState<DateFilter>("any");
  const [sort, setSort] = useState<Sort>("relevance");
  const [facetCode, setFacetCode] = useState(false);
  const [facetPinned, setFacetPinned] = useState(false);
  const [facetRole, setFacetRole] = useState<RoleFacet>("");
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const usesVectors = mode === "hybrid" || mode === "semantic";

  const parsed = useMemo(() => {
    const p = parseQuery(query);
    if (facetCode) p.hasCode = true;
    if (facetPinned) p.isPinned = true;
    if (facetRole) p.role = facetRole;
    p.filtersOnly = !p.terms.length && !p.phrases.length &&
      (p.chat != null || p.before != null || p.after != null || !!p.hasCode || !!p.isPinned || !!p.role);
    return p;
  }, [query, facetCode, facetPinned, facetRole]);

  const hasQuery = query.trim().length > 0 || parsed.filtersOnly;

  useEffect(() => {
    inputRef.current?.focus();
    const onFocus = () => { setQuery(""); inputRef.current?.focus(); };
    const onSet = (e: Event) => { setQuery((e as CustomEvent<string>).detail || ""); inputRef.current?.focus(); };
    window.addEventListener("focus-search", onFocus);
    window.addEventListener("set-search", onSet);
    return () => { window.removeEventListener("focus-search", onFocus); window.removeEventListener("set-search", onSet); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (e.key === "/" && !typing) { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Warm the model when a vector mode is active, and optionally auto-build.
  useEffect(() => {
    if (!usesVectors || !index.total) return;
    if (settings.autoBuildIndex && !index.upToDate && !index.building) void index.buildIndex();
  }, [usesVectors, index.total, index.upToDate, settings.autoBuildIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced, cancellable search.
  useEffect(() => {
    if (!hasQuery) { setResults([]); setSearching(false); setRankedBy(""); return; }
    let cancelled = false;
    setSearching(true);
    setSemanticError("");
    const t = setTimeout(async () => {
      const started = performance.now();
      const ctx: SearchContext = {
        index: lexIndex,
        vectorSegments: index.segments,
        pinnedIds,
        hasVectors: usesVectors && index.embedded > 0,
        onSemanticError: (m) => { if (!cancelled) setSemanticError(m); },
      };
      try {
        const out = await runSearch(mode, parsed, ctx);
        if (cancelled) return;
        setResults(out.hits);
        setRankedBy(out.rankedBy);
        setSemanticUsed(out.semanticUsed);
        setTimingMs(Math.round(performance.now() - started));
        setSelected(0);
      } catch {
        if (!cancelled) { setResults([]); setRankedBy(""); }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [parsed, mode, lexIndex, index.segments, index.embedded, pinnedIds, usesVectors, hasQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (chatId: string, turn?: number, terms?: string[]) => {
    saveRecent(query);
    setRecents(loadRecents());
    navigate(chatLink(chatId, turn, parsed.text, mode, terms));
  };

  // Filter + group + sort.
  const groups = useMemo(() => {
    const hits = results.filter((h) => withinFilter(h.segment.scrapedAt, dateFilter));
    let g = groupByChat(hits);
    if (sort === "recent") g = [...g].sort((a, b) => (b.scrapedAt || "").localeCompare(a.scrapedAt || ""));
    return g;
  }, [results, dateFilter, sort]);

  // Keyboard nav over result groups: ↑/↓ select, Enter opens.
  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(groups.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") {
      const g = groups[selected] || groups[0];
      const top = g?.hits[0];
      if (top) open(top.segment.chatId, top.segment.turnIndex, top.matchedTerms);
    }
  };

  const pinnedChats = useMemo(
    () => chats.filter((c) => meta[c.id]?.pinned)
      .sort((a, b) => (meta[b.id]?.pinnedAt || "").localeCompare(meta[a.id]?.pinnedAt || "")),
    [chats, meta],
  );
  const recentChats = useMemo(
    () => [...chats].filter((c) => !meta[c.id]?.pinned)
      .sort((a, b) => (b.scrapedAt || "").localeCompare(a.scrapedAt || "")).slice(0, 40),
    [chats, meta],
  );

  const placeholder = MODES.find((m) => m.id === mode)!.hint;
  const totalMatches = groups.reduce((n, g) => n + g.hits.length, 0);
  const rankLabel = rankedBy === "smart" ? (semanticUsed ? "smart · meaning+words" : "smart · words")
    : rankedBy === "semantic" ? "meaning" : rankedBy === "fuzzy" ? "fuzzy" : rankedBy === "keyword" ? "keywords" : "";

  return (
    <>
      <JobBanner />
      <div className="col search-wrap">
        {!hasQuery && (
          <h1 className="greeting">Search your <span className="grad">Gemini archive</span></h1>
        )}

        <div className="searchbox">
          <span className="icn"><I.Search size={20} /></span>
          <input ref={inputRef} value={query} placeholder={placeholder} autoComplete="off" spellCheck={false}
            aria-label="Search archive"
            onChange={(e) => setQuery(e.target.value)} onKeyDown={onInputKey} />
          {query && (
            <button className="iconbtn" title="Clear" aria-label="Clear search" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
              <I.Close size={18} />
            </button>
          )}
        </div>

        <div className="modes">
          {MODES.map((m) => (
            <button key={m.id} className={"mode-chip" + (mode === m.id ? " active" : "")} onClick={() => setMode(m.id)} title={m.label}>
              {m.icon} {m.label}
            </button>
          ))}
        </div>

        {hasQuery && (
          <div className="filters">
            <div className="seg">
              {(["any", "7d", "30d", "year"] as DateFilter[]).map((f) => (
                <button key={f} className={dateFilter === f ? "on" : ""} onClick={() => setDateFilter(f)}>
                  {f === "any" ? "Any time" : f === "7d" ? "7 days" : f === "30d" ? "30 days" : "1 year"}
                </button>
              ))}
            </div>
            <div className="seg">
              {(["relevance", "recent"] as Sort[]).map((s) => (
                <button key={s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>
                  {s === "relevance" ? "Relevance" : "Recent"}
                </button>
              ))}
            </div>
            <button className={"facet-chip" + (facetCode ? " on" : "")} onClick={() => setFacetCode((v) => !v)} title="Only answers with code">
              <I.Type size={13} /> code
            </button>
            <button className={"facet-chip" + (facetPinned ? " on" : "")} onClick={() => setFacetPinned((v) => !v)} title="Only pinned chats">
              <I.Pin size={13} /> pinned
            </button>
            <div className="seg">
              {([["", "Q&A"], ["question", "Questions"], ["answer", "Answers"]] as [RoleFacet, string][]).map(([r, lbl]) => (
                <button key={r || "all"} className={facetRole === r ? "on" : ""} onClick={() => setFacetRole(r)}>{lbl}</button>
              ))}
            </div>
            <span className="spacer" />
            {usesVectors && index.embedded > 0 && (
              <span style={{ fontSize: 12, color: "var(--text-mute)" }}>{index.embedded}/{index.total} vectorized</span>
            )}
          </div>
        )}

        {semanticError && (
          <div className="notice warn">
            <I.Brain size={16} /> Semantic search unavailable — showing keyword results. <span className="dim">{semanticError}</span>
          </div>
        )}

        {usesVectors && !index.upToDate && index.total > 0 && <VectorPrompt index={index} />}

        {hasQuery ? (
          <>
            <div className="section-label">
              <span>
                {searching ? "Searching…" : `${groups.length} chat${groups.length === 1 ? "" : "s"} · ${totalMatches} match${totalMatches === 1 ? "" : "es"}`}
                {!searching && groups.length > 0 && rankLabel && (
                  <span className="rank-badge">ranked by {rankLabel} · {timingMs}ms</span>
                )}
              </span>
            </div>
            {groups.map((g, i) => (
              <GroupCard key={g.chatId} group={g} query={parsed.text} mode={mode} selected={i === selected}
                title={displayTitle(meta, g.chatId, g.chatTitle)} onOpen={open} />
            ))}
            {!searching && !groups.length && (
              <div className="empty">No matches.{mode !== "semantic" && mode !== "hybrid" ? " Try Smart or Semantic mode for broader results." : ""}</div>
            )}
          </>
        ) : (
          <>
            {recents.length > 0 && (
              <>
                <div className="section-label"><span>Recent searches</span>
                  <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }}
                    onClick={() => { localStorage.removeItem(RECENTS_KEY); setRecents([]); }}>Clear</button>
                </div>
                <div className="filters">
                  {recents.map((r) => (
                    <button key={r} className="recent-chip" onClick={() => { setQuery(r); inputRef.current?.focus(); }}>
                      <I.Search size={13} /> {r}
                    </button>
                  ))}
                </div>
              </>
            )}

            {pinnedChats.length > 0 && (
              <>
                <div className="section-label"><span>Pinned</span></div>
                <div className="result-list">
                  {pinnedChats.map((c) => (
                    <ChatRow key={c.id} title={displayTitle(meta, c.id, c.title)} sub={`${c.turns.length} Q&A`}
                      date={shortDate(c.scrapedAt)} pinned onOpen={() => navigate(chatLink(c.id))} />
                  ))}
                </div>
              </>
            )}

            <div className="section-label"><span>Recent</span></div>
            {recentChats.length || pinnedChats.length ? (
              <div className="result-list">
                {recentChats.map((c) => (
                  <ChatRow key={c.id} title={displayTitle(meta, c.id, c.title)} sub={`${c.turns.length} Q&A`}
                    date={shortDate(c.scrapedAt)} onOpen={() => navigate(chatLink(c.id))} />
                ))}
              </div>
            ) : (
              <div className="empty">
                <div className="big"><I.Sparkle size={22} /></div>
                <p>No chats yet. Open a conversation on gemini.google.com and capture it from the extension popup —
                  it'll appear here, fully searchable.</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ChatRow({ title, sub, date, pinned, onOpen }: { title: string; sub: string; date: string; pinned?: boolean; onOpen: () => void }) {
  return (
    <button className="result" onClick={onOpen}>
      <span style={{ color: pinned ? "var(--accent)" : "var(--text-mute)", marginTop: 2 }}>
        {pinned ? <I.Pin size={18} /> : <I.Msg size={18} />}
      </span>
      <div className="body">
        <div className="r-title">{title}</div>
        <div className="r-snip">{sub}</div>
      </div>
      <div className="r-meta">{date}</div>
    </button>
  );
}

function clip(s: string, n: number): string {
  s = s.trim();
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

function GroupCard({
  group, query, mode, title, selected, onOpen,
}: { group: ResultGroup; query: string; mode: SearchMode; title: string; selected?: boolean; onOpen: (chatId: string, turn: number, terms?: string[]) => void }) {
  const [showAll, setShowAll] = useState(false);
  // Title uses the raw query; per-hit q/snippet bold the hit's own matched terms
  // (== what the reader marks on arrival).
  const hlTitle = (text: string) => highlight(text, query);
  const showPct = mode === "semantic" || mode === "hybrid";
  const CAP = 5;
  const visible = showAll ? group.hits : group.hits.slice(0, CAP);
  const hidden = group.hits.length - visible.length;
  return (
    <div className={"group" + (selected ? " selected" : "")}>
      <div className="group-head2">
        <button className="g-title-btn" onClick={() => onOpen(group.chatId, group.hits[0]!.segment.turnIndex, group.hits[0]!.matchedTerms)}>
          <I.Msg size={15} />
          <span className="g-title" dangerouslySetInnerHTML={{ __html: hlTitle(title) }} />
        </button>
        <span className="g-meta">
          {showPct && <span className="badge">{Math.round(group.score * 100)}%</span>}
          {group.hits.length} match{group.hits.length === 1 ? "" : "es"} · {relativeTime(group.scrapedAt)}
        </span>
      </div>
      <div className="g-hits">
        {visible.map((h) => {
          const approx = isApproxHit(h, query);
          return (
          <button key={h.segment.id} className="g-hit" onClick={() => onOpen(group.chatId, h.segment.turnIndex, h.matchedTerms)}>
            <span className="gh-badge">#{h.segment.turnIndex + 1}</span>
            <span className="gh-body">
              {h.segment.question && (
                <span className="gh-q" dangerouslySetInnerHTML={{ __html: highlightMatched(clip(h.segment.question, 110), h, query) }} />
              )}
              <span className="gh-snip" dangerouslySetInnerHTML={{ __html: highlightMatched(h.snippet, h, query) }} />
              <span className="gh-tags">
                {h.field && <span className={"gh-field " + h.field} title={h.field === "answer" ? "Matched in the answer" : "Matched in the question"}>{h.field === "answer" ? "A" : "Q"}</span>}
                {approx && <span className="gh-approx" title="Matched by meaning, not exact words">≈ meaning</span>}
              </span>
            </span>
            {showPct && <span className="gh-score">{Math.round(h.score * 100)}%</span>}
          </button>
          );
        })}
        {(hidden > 0 || showAll) && group.hits.length > CAP && (
          <button className="group-expand" onClick={() => setShowAll((v) => !v)}>
            <I.ChevDown size={14} /> {showAll ? "Show fewer" : `Show ${hidden} more match${hidden === 1 ? "" : "es"}`}
          </button>
        )}
      </div>
    </div>
  );
}
