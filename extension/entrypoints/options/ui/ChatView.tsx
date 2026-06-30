import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatTurn, SearchMode } from "@/lib/types";
import { togglePin, setChatMeta, displayTitle } from "@/lib/meta";
import { useChats, useChatMeta } from "./store";
import { sanitizeAnswerHtml } from "./sanitize";
import { useInChatFind, type FindMode } from "./useInChatFind";
import { salientTerms } from "./findHighlight";
import { InsightsPanel } from "./InsightsPanel";
import { ChatSearchOverlay } from "./ChatSearchOverlay";
import { Outline } from "./Outline";
import { enrichAnswerHtml } from "./enrichHtml";
import { annotateSections, type OutlineSection } from "./outlineSections";
import { useChatSearch } from "./useChatSearch";
import { useSemanticIndex } from "./useSemanticIndex";
import { VectorPrompt } from "./VectorPrompt";
import { segmentsFromChats } from "./segments";
import { exportEpub, exportMarkdown } from "./exporters";
import { cosineSim } from "./embeddings";
import { JobBanner } from "./JobBanner";
import { navigate, chatLink } from "./App";
import * as I from "./icons";

/** Dock default: remembered choice, else collapsed (false) on every viewport. */
function dockDefault(key: string): boolean {
  return localStorage.getItem(key) === "1";
}

/** Map a global/overlay SearchMode to the quick-find mode used in the reader. */
function modeToFind(mode?: string): FindMode {
  if (mode === "semantic") return "meaning";
  if (mode === "fuzzy") return "fuzzy";
  return "exact";
}
function findToMode(mode: FindMode): SearchMode {
  if (mode === "meaning") return "semantic";
  if (mode === "fuzzy") return "fuzzy";
  return "keyword";
}

export function ChatView({ chatId, turn, query, mode }: { chatId: string; turn?: number; query?: string; mode?: string }) {
  const chats = useChats();
  const meta = useChatMeta();
  const chat = useMemo(() => chats.find((c) => c.id === chatId), [chats, chatId]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const cs = useChatSearch(chat);
  // Owns the buildable vector index (all chats — the hook prunes vectors outside
  // its segment set, so it must see every chat, not just this one).
  const allSegments = useMemo(() => segmentsFromChats(chats), [chats]);
  const vindex = useSemanticIndex(allSegments);
  // id → vector for this view's "find similar" (refreshes after a build).
  const vecById = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const s of vindex.segments) if (s.embedding && s.embedding.length) m.set(s.id, s.embedding);
    return m;
  }, [vindex.segments]);

  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState(query || "");
  const [findMode, setFindMode] = useState<FindMode>(() => modeToFind(mode));
  const [includeCode, setIncludeCode] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findInitRef = useRef(false);
  // Turn to land on when matches/hits next populate (set by overlay jumps).
  const jumpTurnRef = useRef<number | null>(null);
  // Meaning-mode (semantic) navigation targets — ranked turns, set async.
  const [meaningHits, setMeaningHits] = useState<{ turnIndex: number; score: number }[]>([]);

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Docks default ON for desktop, OFF for mobile; the user's choice is remembered.
  const [showInsights, setShowInsights] = useState(() => dockDefault("dock-insights"));
  const [showOutline, setShowOutline] = useState(() => dockDefault("dock-outline"));
  useEffect(() => { localStorage.setItem("dock-insights", showInsights ? "1" : "0"); }, [showInsights]);
  useEffect(() => { localStorage.setItem("dock-outline", showOutline ? "1" : "0"); }, [showOutline]);
  const [readPct, setReadPct] = useState(0);
  const [showVectorPanel, setShowVectorPanel] = useState(false);
  const [vectorDismissed, setVectorDismissed] = useState(false);
  const [similar, setSimilar] = useState<{ from: number; hits: { turnIndex: number; score: number }[] } | null>(null);

  const findSimilar = (turnIndex: number) => {
    const myVec = vecById.get(`${chatId}#${turnIndex}`);
    if (!myVec) { setVectorDismissed(false); setShowVectorPanel(true); return; } // offer to build right here
    const hits = (chat?.turns ?? [])
      .filter((t) => t.index !== turnIndex)
      .map((t) => ({ turnIndex: t.index, score: cosineSim(myVec, vecById.get(`${chatId}#${t.index}`) || []) }))
      .filter((h) => h.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    setSimilar({ from: turnIndex, hits });
  };

  // Sanitize + syntax/math-enrich + section-anchor each answer ONCE per chat
  // (memoized). The same annotated HTML feeds rendering, find-highlight and the
  // outline, so the anchor ids the outline links to always exist in the DOM.
  const { enrichedAnswers, outlineData } = useMemo(() => {
    const html = new Map<number, string>();
    const sections = new Map<number, OutlineSection[]>();
    if (chat) {
      for (const t of chat.turns) {
        if (!t.answerHtml) continue;
        const enriched = enrichAnswerHtml(sanitizeAnswerHtml(t.answerHtml));
        const ann = annotateSections(enriched, t.index);
        html.set(t.index, ann.html);
        if (ann.sections.length) sections.set(t.index, ann.sections);
      }
    }
    return { enrichedAnswers: html, outlineData: sections };
  }, [chat?.id, chat?.turns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const isMeaning = findMode === "meaning";
  // In meaning mode we still mark salient query words inline (so context is
  // visible), but navigation/stepping is driven by the semantic hit turns below.
  const findQuery = findOpen && findTerm.trim()
    ? (isMeaning ? salientTerms(findTerm).join(" ") : findTerm)
    : "";
  // Match state is derived from chat *content* (not live DOM), so it survives
  // re-renders and chat navigation. Empty query when closed → no work done.
  const find = useInChatFind(chat, findQuery, includeCode, enrichedAnswers, isMeaning ? "exact" : findMode);
  // Navigation targets: literal marks (exact/fuzzy) or ranked turns (meaning).
  const matches = find.matches;
  const navLen = isMeaning ? meaningHits.length : matches.length;

  // Meaning mode: rank turns semantically (debounced); reuses the shared engine.
  useEffect(() => {
    if (!isMeaning || !findOpen || !findTerm.trim()) { setMeaningHits([]); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      // True meaning search when vectors exist; otherwise hybrid degrades to
      // fuzzy+keyword so the mode still returns relevant turns.
      cs.search(cs.vectorsReady ? "semantic" : "hybrid", findTerm)
        .then((out) => { if (!cancelled) setMeaningHits(out.hits.map((h) => ({ turnIndex: h.segment.turnIndex, score: h.score }))); })
        .catch(() => { if (!cancelled) setMeaningHits([]); });
    }, 180);
    return () => { cancelled = true; clearTimeout(id); };
  }, [isMeaning, findOpen, findTerm, cs.search, cs.vectorsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Performance for huge chats ---
  // Every turn stays in the DOM (so find marks, outline anchors, copy buttons and
  // scroll-to-id all just work), but for long chats we let the browser skip
  // rendering/layout of off-screen turns via CSS `content-visibility: auto`. This
  // is far more robust than JS windowing (no blank-screen / measurement bugs) and
  // keeps every scroll target reachable by id.
  const turnCount = chat?.turns.length ?? 0;
  const optimize = turnCount > 30;

  // Scroll to a turn by id (browser renders content-visibility turns on demand).
  const scrollToTurn = useCallback((turnIndex: number, flash = false) => {
    const el = document.getElementById(`turn-${turnIndex}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    if (flash) { el.classList.add("target"); setTimeout(() => el.classList.remove("target"), 1400); }
  }, []);

  // Scroll to a specific answer section (outline jump).
  const scrollToSection = useCallback((_turnIndex: number, sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    el.classList.add("target");
    setTimeout(() => el.classList.remove("target"), 1400);
  }, []);

  // Neighbour chats (for prev/next), in recency order.
  const ordered = useMemo(
    () => [...chats].sort((a, b) => (b.scrapedAt || "").localeCompare(a.scrapedAt || "")),
    [chats],
  );
  const myIdx = ordered.findIndex((c) => c.id === chatId);
  const prevChat = myIdx > 0 ? ordered[myIdx - 1] : undefined;
  const nextChat = myIdx >= 0 && myIdx < ordered.length - 1 ? ordered[myIdx + 1] : undefined;

  // Always scroll to + flash the deep-linked turn once on arrival. Flashing even
  // when find is open confirms the location for semantic/fuzzy hits whose literal
  // term may not appear in the turn (so nothing would otherwise highlight).
  useEffect(() => {
    if (!chat || turn == null || scrolledRef.current) return;
    scrolledRef.current = true;
    // Small defer so the turns have painted before we scroll.
    const id = setTimeout(() => scrollToTurn(turn, true), 60);
    return () => clearTimeout(id);
  }, [chat, turn, scrollToTurn]);

  // If we arrived from a search, open find pre-filled with the query + mode.
  useEffect(() => {
    if (query && query.trim()) { setFindOpen(true); setFindTerm(query); setFindMode(modeToFind(mode)); }
  }, [query, mode]);

  // Keep `cur` within range as the navigation set changes.
  useEffect(() => {
    if (!navLen) { setCur(0); return; }
    setCur((c) => Math.min(c, navLen - 1));
  }, [navLen]);

  // Hide the inline vector-build panel once the index is complete.
  useEffect(() => { if (vindex.upToDate) setShowVectorPanel(false); }, [vindex.upToDate]);

  // When matches/hits first populate after a deep-link or an overlay jump, move
  // `cur` to the hit in the target turn (jumpTurnRef takes priority over the
  // deep-linked turn). One-shot via findInitRef until the next target is set.
  useEffect(() => {
    if (findInitRef.current) return;
    const target = jumpTurnRef.current ?? turn ?? null;
    if (isMeaning) {
      if (!meaningHits.length) return;
      findInitRef.current = true;
      if (target != null) { const i = meaningHits.findIndex((h) => h.turnIndex === target); if (i >= 0) setCur(i); }
      jumpTurnRef.current = null;
      return;
    }
    if (!matches.length) return;
    findInitRef.current = true;
    if (target != null) { const i = matches.findIndex((m) => m.turnIndex === target); if (i >= 0) setCur(i); }
    jumpTurnRef.current = null;
  }, [matches, meaningHits, turn, isMeaning]);

  // Move the "current" highlight + scroll it into view.
  //  • exact/fuzzy: toggle a class on the rendered <mark data-fi> node (no node
  //    creation, so React's DOM is never clobbered).
  //  • meaning: scroll to the ranked turn and flash it (salient words are already
  //    marked inline by the find pass).
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    container.querySelectorAll("mark.find-cur").forEach((m) => m.classList.remove("find-cur"));
    if (isMeaning) {
      const h = meaningHits[cur];
      if (h) scrollToTurn(h.turnIndex, true);
      return;
    }
    if (!matches.length) return;
    const m = matches[cur];
    if (!m) return;
    const target = container.querySelector<HTMLElement>(`mark.find-hit[data-fi="${cur}"]`);
    if (target) { target.classList.add("find-cur"); target.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }, [cur, matches, meaningHits, isMeaning, find.perTurn, scrollToTurn]);

  // Shift the reading column so open docks don't overlap it (desktop only; CSS
  // media query gates the actual padding).
  useEffect(() => {
    const main = bodyRef.current?.closest(".main");
    if (!main) return;
    main.classList.toggle("dock-l", showOutline);
    main.classList.toggle("dock-r", showInsights);
    return () => { main.classList.remove("dock-l", "dock-r"); };
  }, [showOutline, showInsights]);

  // Reading-progress bar driven by the scroll container.
  useEffect(() => {
    const scroller = bodyRef.current?.closest(".main");
    if (!scroller) return;
    const onScroll = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      setReadPct(max > 0 ? Math.min(100, (scroller.scrollTop / max) * 100) : 0);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [chat?.id]);

  // Inject copy buttons into code blocks.
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-copy")) return;
      const btn = document.createElement("button");
      btn.className = "code-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        void navigator.clipboard.writeText(code);
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 1200);
      });
      pre.appendChild(btn);
    });
    // Re-run when the rendered answer HTML swaps (find highlight on/off/term),
    // since React replaces <pre> nodes and drops the injected buttons.
  }, [chat?.turns.length, findOpen, findTerm, includeCode, find.perTurn]);

  // Keyboard: F opens find, N/Shift+N step matches, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (e.key.toLowerCase() === "f" && !typing) {
        e.preventDefault();
        if (e.shiftKey) { setOverlayOpen(true); }
        else { setFindOpen(true); setTimeout(() => findInputRef.current?.focus(), 0); }
      }
      else if (e.key === "Escape" && findOpen) { setFindOpen(false); }
      else if (e.key.toLowerCase() === "n" && !typing && navLen) {
        e.preventDefault();
        setCur((c) => (e.shiftKey ? (c - 1 + navLen) % navLen : (c + 1) % navLen));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findOpen, navLen]);

  if (!chat) {
    return (
      <>
        <JobBanner />
        <div className="col" style={{ paddingTop: 40 }}>
          <button className="btn ghost" onClick={() => navigate("#/search")}><I.Back size={16} /> Back to search</button>
          <div className="empty">This chat isn't in your archive yet. If a capture is running, it'll appear here when it finishes.</div>
        </div>
      </>
    );
  }

  const title = displayTitle(meta, chat.id, chat.title);
  const pinned = !!meta[chat.id]?.pinned;

  const startRename = () => { setTitleDraft(title); setRenaming(true); };
  const commitRename = async () => {
    const t = titleDraft.trim();
    await setChatMeta(chat.id, { title: t && t !== chat.title ? t : undefined });
    setRenaming(false);
  };

  const stepMatch = (dir: 1 | -1) =>
    setCur((c) => (navLen ? (c + dir + navLen) % navLen : 0));

  const renderTurn = (t: ChatTurn) => {
    const hl = find.active ? find.perTurn.get(t.index) : undefined;
    return (
      <div className={"turn" + (optimize ? " cv" : "")} id={`turn-${t.index}`}>
        <div className="turn-actions">
          <button title="Find similar turns in this chat" aria-label="Find similar turns" onClick={() => void findSimilar(t.index)}><I.Brain size={15} /></button>
          <button title="Copy answer" aria-label="Copy answer" onClick={() => void navigator.clipboard.writeText(t.answerText || "")}><I.Copy size={15} /></button>
        </div>
        {t.question && (
          <div className="q-row">
            {hl?.questionHtml
              ? <div className="q-bubble" dangerouslySetInnerHTML={{ __html: hl.questionHtml }} />
              : <div className="q-bubble">{t.question}</div>}
          </div>
        )}
        {t.answerHtml ? (
          <div className="answer" dangerouslySetInnerHTML={{ __html: hl?.answerHtml ?? enrichedAnswers.get(t.index) ?? sanitizeAnswerHtml(t.answerHtml) }} />
        ) : hl?.answerHtml ? (
          <div className="answer" style={{ whiteSpace: "pre-wrap" }} dangerouslySetInnerHTML={{ __html: hl.answerHtml }} />
        ) : (
          <div className="answer" style={{ whiteSpace: "pre-wrap" }}>{t.answerText}</div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="read-progress" style={{ width: `${readPct}%` }} aria-hidden="true" />
      <JobBanner />
      <div className="chat-head">
        <div className="chat-head-inner">
          <button className="iconbtn" title="Back to search" onClick={() => navigate("#/search")}><I.Back size={20} /></button>
          {renaming ? (
            <input className="title-input" autoFocus value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void commitRename(); if (e.key === "Escape") setRenaming(false); }}
              onBlur={() => void commitRename()} />
          ) : (
            <div className="ct" title={title} onDoubleClick={startRename}>{title}</div>
          )}
          <button className={"iconbtn" + (pinned ? " pin-on" : "")} title={pinned ? "Unpin" : "Pin"} onClick={() => void togglePin(chat.id)}>
            {pinned ? <I.Pin size={18} /> : <I.PinOff size={18} />}
          </button>
          <button className="iconbtn" title="Rename" onClick={startRename}><I.Edit size={18} /></button>
          <button className="iconbtn" title="Find in chat (F)" aria-label="Find in chat" onClick={() => { setFindOpen(true); setTimeout(() => findInputRef.current?.focus(), 0); }}><I.Search size={18} /></button>
          <button className="iconbtn" title="Advanced search this chat (Shift+F)" aria-label="Advanced search" onClick={() => setOverlayOpen(true)}><I.List size={18} /></button>
          <button className={"iconbtn" + (showOutline ? " pin-on" : "")} title="Outline" aria-label="Outline" aria-pressed={showOutline} onClick={() => setShowOutline((v) => !v)}><I.Outline size={18} /></button>
          <button className={"iconbtn" + (showInsights ? " pin-on" : "")} title="Insights (topics, people, links)" aria-label="Insights" aria-pressed={showInsights} onClick={() => setShowInsights((v) => !v)}><I.Bulb size={18} /></button>
          {chat.url && (
            <a className="iconbtn" href={chat.url} target="_blank" rel="noopener noreferrer" title="Open original in Gemini"><I.Open size={18} /></a>
          )}
          <button className="iconbtn" title="Export Markdown" aria-label="Export Markdown" onClick={() => exportMarkdown([chat])}><I.Markdown size={18} /></button>
          <button className="iconbtn" title="Export EPUB" onClick={() => void exportEpub([chat])}><I.Download size={18} /></button>
        </div>
      </div>

      {findOpen && (
        <div className="findbar">
          <I.Search size={16} />
          <input ref={findInputRef} value={findTerm}
            placeholder={isMeaning ? "Find by meaning…" : findMode === "fuzzy" ? "Find (typo-tolerant)…" : "Find in conversation…"}
            aria-label="Find in conversation"
            onChange={(e) => setFindTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") stepMatch(e.shiftKey ? -1 : 1); if (e.key === "Escape") setFindOpen(false); }} />
          <div className="fb-modes" role="tablist" aria-label="Find mode">
            {(["exact", "fuzzy", "meaning"] as FindMode[]).map((m) => (
              <button key={m} role="tab" aria-selected={findMode === m}
                className={"fb-mode" + (findMode === m ? " on" : "")}
                title={m === "exact" ? "Exact match" : m === "fuzzy" ? "Typo-tolerant" : "By meaning (vectors)"}
                onClick={() => setFindMode(m)}>
                {m === "exact" ? "Exact" : m === "fuzzy" ? "Fuzzy" : "Meaning"}
              </button>
            ))}
          </div>
          <span className="fb-count">{navLen ? `${cur + 1}/${navLen}` : "0/0"}{isMeaning && navLen ? " passages" : ""}</span>
          <button title="Previous (Shift+N)" aria-label="Previous match" onClick={() => stepMatch(-1)}><I.Back size={14} /></button>
          <button title="Next (N)" aria-label="Next match" onClick={() => stepMatch(1)} style={{ transform: "rotate(180deg)" }}><I.Back size={14} /></button>
          {!isMeaning && (
            <label className="fb-toggle" title="Also search inside code blocks">
              <input type="checkbox" checked={includeCode} onChange={(e) => setIncludeCode(e.target.checked)} /> code
            </label>
          )}
          <button title="Advanced search (rich results)" aria-label="Advanced search" onClick={() => setOverlayOpen(true)}><I.List size={14} /></button>
          <button title="Close (Esc)" aria-label="Close find" onClick={() => setFindOpen(false)}><I.Close size={14} /></button>
        </div>
      )}

      {findOpen && navLen > 0 && (
        <div className="find-minimap" aria-hidden="true">
          {(isMeaning ? meaningHits.map((h, i) => ({ key: i, turnIndex: h.turnIndex, idx: i })) : matches.map((m) => ({ key: m.index, turnIndex: m.turnIndex, idx: m.index }))).map((t) => (
            <button key={t.key} className={"fm-tick" + (t.idx === cur ? " on" : "")}
              style={{ top: `${((t.turnIndex + 0.5) / Math.max(1, chat.turns.length)) * 100}%` }}
              title={`Turn ${t.turnIndex + 1}`} onClick={() => setCur(t.idx)} />
          ))}
        </div>
      )}

      {overlayOpen && (
        <ChatSearchOverlay chat={chat} initialQuery={findTerm} initialMode={findToMode(findMode)}
          onJump={(turnIndex, m, q) => {
            setOverlayOpen(false);
            setFindTerm(q);
            setFindMode(modeToFind(m));
            setFindOpen(true);
            // Re-arm the target effect so `cur` lands on the jumped turn once
            // matches/hits recompute for the new term/mode.
            jumpTurnRef.current = turnIndex;
            findInitRef.current = false;
            setTimeout(() => scrollToTurn(turnIndex, true), 40);
          }}
          onClose={() => setOverlayOpen(false)} />
      )}

      {similar && (
        <div className="find-results similar" role="list" aria-label="Similar turns">
          <div className="ins-head">
            <strong><I.Brain size={14} /> Similar to #{similar.from + 1}</strong>
            <button className="iconbtn" title="Close" aria-label="Close similar" onClick={() => setSimilar(null)}><I.Close size={16} /></button>
          </div>
          {similar.hits.length === 0 ? (
            <div className="fr-empty">No closely related turns found.</div>
          ) : similar.hits.map((h) => {
            const tt = chat.turns.find((x) => x.index === h.turnIndex);
            return (
              <button key={h.turnIndex} role="listitem" className="fr-row"
                onClick={() => scrollToTurn(h.turnIndex, true)}>
                <span className="fr-badge answer">{Math.round(h.score * 100)}</span>
                <span className="fr-turn">#{h.turnIndex + 1}</span>
                <span className="fr-ctx">{tt?.question?.trim() || tt?.answerText?.slice(0, 80) || "(turn)"}</span>
              </button>
            );
          })}
        </div>
      )}

      {showInsights && <InsightsPanel chat={chat} onClose={() => setShowInsights(false)} />}
      {showOutline && (
        <Outline chat={chat} sectionsByTurn={outlineData} onClose={() => setShowOutline(false)}
          onJumpTurn={(i) => scrollToTurn(i, true)} onJumpSection={scrollToSection} />
      )}

      <div className="col" style={{ paddingTop: 8, paddingBottom: 60 }} ref={bodyRef}>
        {(showVectorPanel || (isMeaning && findOpen && findTerm.trim().length > 0 && !cs.vectorsReady && !vindex.upToDate && vindex.total > 0)) && !vectorDismissed && (
          <VectorPrompt index={vindex} onClose={() => { setShowVectorPanel(false); setVectorDismissed(true); }} />
        )}
        {chat.turns.map((t) => <React.Fragment key={t.key || t.index}>{renderTurn(t)}</React.Fragment>)}

        <div className="toolbar" style={{ marginTop: 24, justifyContent: "space-between" }}>
          {prevChat ? (
            <button className="btn ghost" onClick={() => navigate(chatLink(prevChat.id))} title={displayTitle(meta, prevChat.id, prevChat.title)}>
              <I.Back size={16} /> Newer
            </button>
          ) : <span />}
          {nextChat ? (
            <button className="btn ghost" onClick={() => navigate(chatLink(nextChat.id))} title={displayTitle(meta, nextChat.id, nextChat.title)}>
              Older <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}><I.Back size={16} /></span>
            </button>
          ) : <span />}
        </div>
      </div>

      <button className="fab-top" title="Scroll to top" onClick={() => bodyRef.current?.closest(".main")?.scrollTo({ top: 0, behavior: "smooth" })}>
        <I.Top size={18} />
      </button>
    </>
  );
}
