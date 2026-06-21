"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Search,
  Sparkles,
  FileDown,
  FileJson,
  FileText,
  Trash2,
  BrainCircuit,
  Loader2,
  MessageSquare,
  Type,
  Waypoints,
  Tags,
  X,
  RotateCcw,
  ArrowUpDown,
} from "lucide-react";

import {
  db,
  clearAll,
  clearConcepts,
  deleteChat,
  saveEmbeddings,
  unembeddedSegments,
  buildEntityIndex,
} from "@/lib/db";
import { runSearch, highlight, highlightSemantic } from "@/lib/search";
import { buildEpub } from "@/lib/epub";
import { chatsToJson } from "@/lib/import-export";
import { chatsToMarkdown } from "@/lib/markdown";
import { getEmbeddings } from "@/lib/embeddings";
import { downloadBlob, slugify } from "@/lib/download";
import { chatWordCount, relativeTime } from "@/lib/text-stats";
import { ENTITY_TYPE_LABELS, type Entity, type EntityType } from "@/lib/entities";
import type { Chat, SearchHit, SearchMode } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";
import { ImportPanel } from "@/components/import-panel";

type ChatSort = "recent" | "title" | "size";

export default function Home() {
  const router = useRouter();
  const chats = useLiveQuery(() => db.chats.orderBy("scrapedAt").reverse().toArray(), [], []);
  const segments = useLiveQuery(() => db.segments.toArray(), [], []);
  const stats = useLiveQuery(
    async () => {
      const all = await db.segments.toArray();
      const embedded = all.filter((s) => s.embedding && s.embedding.length);
      const conceptKeys = new Set(
        (await db.entities.where("type").equals("concept").toArray()).map(
          (e) => `${e.chatId}#${e.turnIndex}`,
        ),
      );
      const withConcepts = embedded.filter((s) =>
        conceptKeys.has(`${s.chatId}#${s.turnIndex}`),
      ).length;
      return {
        total: all.length,
        embedded: embedded.length,
        conceptsPending: embedded.length - withConcepts,
      };
    },
    [],
    { total: 0, embedded: 0, conceptsPending: 0 },
  );

  const entities = useLiveQuery(() => db.entities.toArray(), [], [] as Entity[]);

  const [mode, setMode] = useState<SearchMode>("keyword");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [facet, setFacet] = useState<{ type: EntityType; value: string } | null>(null);
  const [chatFilter, setChatFilter] = useState("");
  const [chatSort, setChatSort] = useState<ChatSort>("recent");
  const searchRef = useRef<HTMLInputElement>(null);

  // Archive-wide totals for the dashboard.
  const dashboard = useMemo(() => {
    const list = chats ?? [];
    let turns = 0;
    let words = 0;
    for (const c of list) {
      turns += c.turns.length;
      words += chatWordCount(c);
    }
    return { chats: list.length, turns, words };
  }, [chats]);

  // Filtered + sorted chat list for the sidebar.
  const visibleChats = useMemo(() => {
    const f = chatFilter.trim().toLowerCase();
    let list = (chats ?? []).filter((c) => !f || c.title.toLowerCase().includes(f));
    list = [...list];
    if (chatSort === "title") list.sort((a, b) => a.title.localeCompare(b.title));
    else if (chatSort === "size") list.sort((a, b) => b.turns.length - a.turns.length);
    // "recent" keeps the query's scrapedAt-desc order.
    return list;
  }, [chats, chatFilter, chatSort]);

  // Most-mentioned entities, offered as one-click search facets.
  const facetList = useMemo(() => {
    const agg = new Map<string, { type: EntityType; value: string; label: string; chats: Set<string> }>();
    for (const e of entities ?? []) {
      const k = `${e.type}::${e.value}`;
      const cur = agg.get(k);
      if (cur) cur.chats.add(e.chatId);
      else agg.set(k, { type: e.type, value: e.value, label: e.label, chats: new Set([e.chatId]) });
    }
    return [...agg.values()]
      .sort((a, b) => b.chats.size - a.chats.size)
      .slice(0, 16);
  }, [entities]);

  // Set of `${chatId}#${turnIndex}` keys for the selected facet.
  const facetKeys = useMemo(() => {
    if (!facet) return null;
    const s = new Set<string>();
    for (const e of entities ?? []) {
      if (e.type === facet.type && e.value === facet.value) s.add(`${e.chatId}#${e.turnIndex}`);
    }
    return s;
  }, [entities, facet]);

  const [indexing, setIndexing] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Debounced search whenever the query, mode, or underlying data changes.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await runSearch(mode, segments, q);
        if (!cancelled) setResults(r.slice(0, 60));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, mode, segments]);

  // Keyboard: "/" focuses search, Escape clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && target === searchRef.current) {
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function buildIndex() {
    setIndexing(true);
    setModelMsg("Loading model…");
    const emb = getEmbeddings();
    const off = emb.onProgress((p) => {
      if (p.status === "progress" && typeof p.progress === "number") {
        setModelMsg(`Downloading model… ${p.progress}%`);
      } else if (p.status === "ready" || p.status === "done") {
        setModelMsg("Embedding chats…");
      }
    });
    try {
      const todo = await unembeddedSegments();
      if (todo.length) {
        setProgress({ done: 0, total: todo.length });
        const BATCH = 16;
        for (let i = 0; i < todo.length; i += BATCH) {
          const slice = todo.slice(i, i + BATCH).map((s) => ({ id: s.id, text: s.text.slice(0, 2000) }));
          const res = await emb.embedBatch(slice);
          await saveEmbeddings(res);
          setProgress({ done: Math.min(todo.length, i + BATCH), total: todo.length });
        }
      }
      // Rank concepts now that embeddings exist (KeyBERT-style, reuses the model).
      setModelMsg("Ranking concepts…");
      setProgress(null);
      await buildEntityIndex((done, total) => setProgress({ done, total }));
      setModelMsg(todo.length ? "Semantic index ready." : "Index up to date.");
    } catch (e) {
      setModelMsg("Indexing failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      off();
      setIndexing(false);
      setProgress(null);
    }
  }

  async function regenerateConcepts() {
    if (!confirm("Clear and rebuild ranked concepts for every turn?")) return;
    await clearConcepts();
    await buildIndex();
  }

  async function exportAllEpub() {
    const all = await db.chats.toArray();
    if (!all.length) return;
    const blob = await buildEpub(all, { title: all.length === 1 ? all[0]!.title : "Gemini Chats" });
    downloadBlob(blob, all.length === 1 ? `${slugify(all[0]!.title)}.epub` : "gemini-chats.epub");
  }

  async function exportAllJson() {
    const all = await db.chats.toArray();
    if (!all.length) return;
    downloadBlob(new Blob([chatsToJson(all)], { type: "application/json" }), "gemini-chats.json");
  }

  async function exportAllMarkdown() {
    const all = await db.chats.toArray();
    if (!all.length) return;
    const md = chatsToMarkdown(all);
    downloadBlob(
      new Blob([md], { type: "text/markdown" }),
      all.length === 1 ? `${slugify(all[0]!.title)}.md` : "gemini-chats.md",
    );
  }

  async function exportChatEpub(chat: Chat) {
    const blob = await buildEpub([chat], { title: chat.title });
    downloadBlob(blob, `${slugify(chat.title)}.epub`);
  }

  const hasChats = (chats?.length ?? 0) > 0;
  const needsIndex = mode === "semantic" && stats.embedded < stats.total;
  const indexUpToDate = stats.embedded === stats.total && stats.conceptsPending === 0;
  const indexedPct = stats.total ? Math.round((stats.embedded / stats.total) * 100) : 0;

  // Apply the selected entity facet on top of search (or browse by facet alone).
  const visible = useMemo(() => {
    if (query.trim()) {
      return facetKeys
        ? results.filter((h) => facetKeys.has(`${h.segment.chatId}#${h.segment.turnIndex}`))
        : results;
    }
    if (facetKeys) {
      return (segments ?? [])
        .filter((s) => facetKeys.has(`${s.chatId}#${s.turnIndex}`))
        .map((s) => ({ segment: s, score: 1, snippet: s.text.slice(0, 200) }));
    }
    return [];
  }, [query, results, facetKeys, segments]);

  function openTopResult() {
    const top = visible[0];
    if (top) router.push(`/chat/${top.segment.chatId}#turn-${top.segment.turnIndex}`);
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <div className="grid size-9 place-items-center rounded-lg gemini-gradient text-white">
            <Sparkles className="size-5" />
          </div>
          <div className="flex-1">
            <h1 className="text-base font-semibold leading-tight">
              Gemini Chat <span className="gemini-text">Archive</span>
            </h1>
            <p className="text-xs text-muted-foreground">Import · read · search · export to EPUB</p>
          </div>
          {hasChats && (
            <div className="hidden gap-2 sm:flex">
              <Button asChild variant="outline" size="sm">
                <Link href="/entities">
                  <Tags /> Entities
                </Link>
              </Button>
              <Button variant="outline" size="sm" onClick={exportAllMarkdown} title="Export all as Markdown">
                <FileText /> MD
              </Button>
              <Button variant="outline" size="sm" onClick={exportAllJson} title="Export all as JSON">
                <FileJson /> JSON
              </Button>
              <Button variant="gemini" size="sm" onClick={exportAllEpub}>
                <FileDown /> Export all EPUB
              </Button>
            </div>
          )}
          <ThemeToggle />
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[300px_1fr]"
      >
        {/* Sidebar */}
        <aside className="space-y-4">
          <ImportPanel />

          {hasChats && (
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Chats" value={dashboard.chats} />
              <Stat label="Q&A" value={dashboard.turns} />
              <Stat label="Words" value={compact(dashboard.words)} />
            </div>
          )}

          <div className="rounded-xl border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                Chats <span className="text-muted-foreground">({chats?.length ?? 0})</span>
              </h2>
              {hasChats && (
                <button
                  onClick={() => confirm("Remove all imported chats?") && clearAll()}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Clear
                </button>
              )}
            </div>

            {!hasChats ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                No chats yet. Use the Gemini Chat Exporter extension to scrape a conversation,
                export JSON, then drop it above.
              </p>
            ) : (
              <>
                {(chats?.length ?? 0) > 4 && (
                  <div className="mb-2 flex items-center gap-1.5">
                    <Input
                      value={chatFilter}
                      onChange={(e) => setChatFilter(e.target.value)}
                      placeholder="Filter chats…"
                      className="h-8 text-xs"
                    />
                    <button
                      title={`Sort: ${chatSort}`}
                      onClick={() =>
                        setChatSort((s) => (s === "recent" ? "title" : s === "title" ? "size" : "recent"))
                      }
                      className="flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <ArrowUpDown className="size-3.5" />
                      {chatSort}
                    </button>
                  </div>
                )}
                <ul className="space-y-1.5">
                  {visibleChats.map((c) => (
                    <li key={c.id} className="group flex items-center gap-1 rounded-lg px-1 hover:bg-secondary">
                      <Link href={`/chat/${c.id}`} className="flex min-w-0 flex-1 items-center gap-2 py-2">
                        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{c.title}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {c.turns.length} Q&A · {relativeTime(c.scrapedAt)}
                          </span>
                        </span>
                      </Link>
                      <button
                        title="Export this chat as EPUB"
                        onClick={() => exportChatEpub(c)}
                        className="rounded p-1 text-muted-foreground opacity-0 hover:text-primary group-hover:opacity-100"
                      >
                        <FileDown className="size-4" />
                      </button>
                      <button
                        title="Remove"
                        onClick={() => deleteChat(c.id)}
                        className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  ))}
                  {!visibleChats.length && (
                    <li className="px-1 py-2 text-xs text-muted-foreground">No chats match “{chatFilter}”.</li>
                  )}
                </ul>
              </>
            )}
          </div>

          {hasChats && (
            <div className="rounded-xl border bg-card p-4">
              <div className="mb-2 flex items-center gap-2">
                <BrainCircuit className="size-4 text-accent" />
                <h2 className="text-sm font-semibold">Semantic index</h2>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                {stats.embedded}/{stats.total} turns embedded ({indexedPct}%)
                {stats.conceptsPending > 0 ? `, ${stats.conceptsPending} awaiting concepts` : ""}. Runs
                on-device — nothing leaves your browser.
              </p>
              {progress && (
                <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full gemini-gradient transition-all"
                    style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                  />
                </div>
              )}
              {modelMsg && <p className="mb-2 text-[11px] text-muted-foreground">{modelMsg}</p>}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={indexing || indexUpToDate}
                onClick={buildIndex}
              >
                {indexing ? <Loader2 className="animate-spin" /> : <BrainCircuit />}
                {indexUpToDate ? "Index up to date" : "Build semantic index"}
              </Button>
              {stats.embedded > 0 && (
                <button
                  onClick={regenerateConcepts}
                  disabled={indexing}
                  className="mt-2 flex w-full items-center justify-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <RotateCcw className="size-3" /> Regenerate concepts
                </button>
              )}
            </div>
          )}
        </aside>

        {/* Main column */}
        <section className="space-y-4">
          <div className="rounded-xl border bg-card p-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as SearchMode)}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && openTopResult()}
                    placeholder={
                      mode === "semantic"
                        ? "Ask by meaning, e.g. “how do drones stay airborne?”"
                        : mode === "fuzzy"
                          ? "Typo-tolerant search…  ( press / to focus )"
                          : "Search exact words…  ( press / to focus )"
                    }
                    className="pl-9"
                  />
                </div>
                <TabsList>
                  <TabsTrigger value="keyword"><Type className="size-3.5" /> Keyword</TabsTrigger>
                  <TabsTrigger value="fuzzy"><Waypoints className="size-3.5" /> Fuzzy</TabsTrigger>
                  <TabsTrigger value="semantic"><BrainCircuit className="size-3.5" /> Semantic</TabsTrigger>
                </TabsList>
              </div>
            </Tabs>

            {needsIndex && (
              <div className="mt-3 rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs">
                Semantic search needs an index. {stats.embedded}/{stats.total} turns embedded —{" "}
                <button onClick={buildIndex} className="font-medium text-accent underline" disabled={indexing}>
                  {indexing ? "building…" : "build it now"}
                </button>
                .
              </div>
            )}

            {facetList.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Tags className="size-3.5 text-muted-foreground" />
                {facetList.map((f) => {
                  const active = facet?.type === f.type && facet?.value === f.value;
                  return (
                    <button
                      key={`${f.type}::${f.value}`}
                      onClick={() => setFacet(active ? null : { type: f.type, value: f.value })}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground hover:brightness-110"
                      }`}
                      title={`${ENTITY_TYPE_LABELS[f.type]}: ${f.value}`}
                    >
                      <span className="max-w-[160px] truncate">{f.label}</span>
                      <span className="opacity-70">{f.chats.size}</span>
                      {active && <X className="size-3" />}
                    </button>
                  );
                })}
                {facet && (
                  <button
                    onClick={() => setFacet(null)}
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    clear
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Results */}
          {query.trim() || facet ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <p className="text-sm text-muted-foreground">
                  {searching
                    ? "Searching…"
                    : `${visible.length} result${visible.length === 1 ? "" : "s"}`}
                  {facet && (
                    <span className="text-muted-foreground">
                      {" "}
                      · filtered by <span className="text-foreground">{facet.value}</span>
                    </span>
                  )}
                </p>
                {searching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              </div>
              {visible.map((hit) => (
                <ResultCard key={hit.segment.id} hit={hit} query={query} mode={mode} />
              ))}
              {!searching && !visible.length && (
                <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  No matches.{" "}
                  {facet
                    ? "Try clearing the entity filter."
                    : mode !== "semantic" && "Try Fuzzy or Semantic mode for broader results."}
                </p>
              )}
            </div>
          ) : (
            <EmptyState hasChats={hasChats} />
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2 text-center">
      <div className="text-lg font-semibold leading-tight">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function ResultCard({ hit, query, mode }: { hit: SearchHit; query: string; mode: SearchMode }) {
  const { segment, score, snippet } = hit;
  const renderQ =
    mode === "semantic" ? highlightSemantic(segment.question, query) : highlight(segment.question, query);
  const renderS = mode === "semantic" ? highlightSemantic(snippet, query) : highlight(snippet, query);
  return (
    <Link
      href={`/chat/${segment.chatId}#turn-${segment.turnIndex}`}
      className="block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Badge variant={mode === "semantic" ? "accent" : "default"}>
          {mode === "semantic" ? `${Math.round(score * 100)}% match` : "match"}
        </Badge>
        <span className="truncate text-xs text-muted-foreground">{segment.chatTitle}</span>
      </div>
      <p className="mb-1 font-medium" dangerouslySetInnerHTML={{ __html: renderQ }} />
      <p className="text-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderS }} />
    </Link>
  );
}

function EmptyState({ hasChats }: { hasChats: boolean }) {
  return (
    <div className="rounded-xl border border-dashed p-10 text-center">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl gemini-gradient text-white">
        <Sparkles className="size-6" />
      </div>
      <h3 className="text-lg font-semibold">
        {hasChats ? "Search your Gemini chats" : "Import your Gemini chats"}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {hasChats
          ? "Type above to search by keyword, fuzzy match, or meaning — press / to jump here, Enter to open the top result. Click any chat in the sidebar to read or export it."
          : "Install the Gemini Chat Exporter extension, scrape a conversation, export the JSON, and drop it into the sidebar to get started."}
      </p>
    </div>
  );
}
