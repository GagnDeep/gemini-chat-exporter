"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  FileDown,
  FileText,
  ExternalLink,
  Sparkles,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Tags,
  Copy,
  Check,
  ArrowUp,
  List,
} from "lucide-react";

import { db } from "@/lib/db";
import { buildEpub } from "@/lib/epub";
import { chatsToMarkdown } from "@/lib/markdown";
import { downloadBlob, slugify } from "@/lib/download";
import { chatWordCount, readingTime, relativeTime } from "@/lib/text-stats";
import { ENTITY_TYPE_LABELS, type Entity, type EntityType } from "@/lib/entities";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { AnswerHtml } from "@/components/answer-html";
import { EntityBadge } from "@/components/entity-badge";

const TYPE_ORDER: EntityType[] = ["github", "huggingface", "project", "concept", "url"];

export default function ChatPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const chat = useLiveQuery(() => db.chats.get(id), [id]);
  const entities = useLiveQuery(
    () => db.entities.where("chatId").equals(id).toArray(),
    [id],
    [] as Entity[],
  );
  // Lightweight neighbor list for prev/next navigation (scrapedAt desc order).
  const nav = useLiveQuery(
    async () => {
      const all = await db.chats.orderBy("scrapedAt").reverse().toArray();
      return all.map((c) => ({ id: c.id, title: c.title }));
    },
    [],
    [] as { id: string; title: string }[],
  );

  const [showSummary, setShowSummary] = useState(true);
  const [showToc, setShowToc] = useState(false);
  const [showTop, setShowTop] = useState(false);

  // Entities grouped by the turn they appear in (for inline badges).
  const byTurn = useMemo(() => {
    const m = new Map<number, Entity[]>();
    for (const e of entities ?? []) {
      if (!m.has(e.turnIndex)) m.set(e.turnIndex, []);
      m.get(e.turnIndex)!.push(e);
    }
    return m;
  }, [entities]);

  // De-duplicated entities for the per-chat summary, grouped by type.
  const summary = useMemo(() => {
    const seen = new Map<string, Entity>();
    for (const e of entities ?? []) {
      const k = `${e.type}::${e.value}`;
      if (!seen.has(k)) seen.set(k, e);
    }
    const byType = new Map<EntityType, Entity[]>();
    for (const e of seen.values()) {
      if (!byType.has(e.type)) byType.set(e.type, []);
      byType.get(e.type)!.push(e);
    }
    return byType;
  }, [entities]);

  const stats = useMemo(() => {
    if (!chat) return { words: 0, time: "" };
    const words = chatWordCount(chat);
    return { words, time: readingTime(words) };
  }, [chat]);

  const neighbors = useMemo(() => {
    const i = nav.findIndex((c) => c.id === id);
    return {
      prev: i > 0 ? nav[i - 1] : null,
      next: i >= 0 && i < nav.length - 1 ? nav[i + 1] : null,
    };
  }, [nav, id]);

  // Scroll to the turn referenced in the hash (from a search result click).
  useEffect(() => {
    if (!chat) return;
    const hash = window.location.hash;
    if (hash.startsWith("#turn-")) {
      const el = document.getElementById(hash.slice(1));
      if (el) setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }, [chat]);

  // Show the back-to-top button after scrolling down.
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 600);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function exportEpub() {
    if (!chat) return;
    const blob = await buildEpub([chat], { title: chat.title });
    downloadBlob(blob, `${slugify(chat.title)}.epub`);
  }

  function exportMarkdown() {
    if (!chat) return;
    downloadBlob(new Blob([chatsToMarkdown([chat])], { type: "text/markdown" }), `${slugify(chat.title)}.md`);
  }

  if (chat === undefined) {
    return <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (chat === null) {
    return (
      <div className="mx-auto max-w-2xl p-10 text-center">
        <p className="text-sm text-muted-foreground">Chat not found. It may have been removed.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-primary underline">
          Back to archive
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/" aria-label="Back">
              <ArrowLeft />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{chat.title}</h1>
            <p className="text-xs text-muted-foreground">
              {chat.turns.length} Q&A · ~{stats.words.toLocaleString()} words · {stats.time} · scraped{" "}
              {relativeTime(chat.scrapedAt)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowToc((v) => !v)}
            aria-label="Table of contents"
            title="Table of contents"
          >
            <List />
          </Button>
          {chat.url && (
            <Button asChild variant="ghost" size="icon">
              <a href={chat.url} target="_blank" rel="noopener noreferrer" aria-label="Open in Gemini">
                <ExternalLink />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={exportMarkdown} aria-label="Export Markdown" title="Export Markdown">
            <FileText />
          </Button>
          <Button variant="gemini" size="sm" onClick={exportEpub}>
            <FileDown /> EPUB
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {showToc && (
        <div className="border-b bg-card/60">
          <nav className="mx-auto max-w-3xl px-4 py-3">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Jump to turn</p>
            <ol className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {chat.turns.map((t) => (
                <li key={t.index}>
                  <a
                    href={`#turn-${t.index}`}
                    onClick={() => setShowToc(false)}
                    className="block truncate rounded px-2 py-1 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    {t.index + 1}. {t.question || `Turn ${t.index + 1}`}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      )}

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
        {summary.size > 0 && (
          <div className="rounded-xl border bg-card">
            <button
              onClick={() => setShowSummary((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
            >
              <Tags className="size-4 text-accent" />
              <span className="text-sm font-semibold">In this conversation</span>
              <ChevronDown
                className={`ml-auto size-4 text-muted-foreground transition-transform ${showSummary ? "" : "-rotate-90"}`}
              />
            </button>
            {showSummary && (
              <div className="space-y-3 border-t px-4 py-3">
                {TYPE_ORDER.filter((t) => summary.has(t)).map((type) => (
                  <div key={type}>
                    <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                      {ENTITY_TYPE_LABELS[type]}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {summary.get(type)!.map((e) => (
                        <EntityBadge key={e.id} type={e.type} value={e.value} label={e.label} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {chat.turns.map((turn) => {
          const turnEntities = byTurn.get(turn.index) ?? [];
          return (
            <article key={turn.index} id={`turn-${turn.index}`} className="scroll-mt-20">
              <div className="mb-3 flex justify-end">
                <div className="group/q relative max-w-[85%] rounded-2xl rounded-tr-sm gemini-gradient px-4 py-2.5 text-white">
                  <p className="whitespace-pre-wrap text-sm">{turn.question}</p>
                  <CopyButton
                    text={turn.question}
                    className="absolute -left-9 top-1 opacity-0 group-hover/q:opacity-100"
                    label="Copy question"
                  />
                </div>
              </div>
              <div className="group/a flex gap-3">
                <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
                  <Sparkles className="size-4" />
                </div>
                <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border bg-card px-4 py-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Gemini · turn {turn.index + 1}
                    </span>
                    <CopyButton
                      text={turn.answerText}
                      className="opacity-0 group-hover/a:opacity-100"
                      label="Copy answer"
                    />
                  </div>
                  <AnswerHtml html={turn.answerHtml} text={turn.answerText} />
                  {turnEntities.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
                      {turnEntities.map((e) => (
                        <EntityBadge key={e.id} type={e.type} value={e.value} label={e.label} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </article>
          );
        })}

        {/* Prev / next chat navigation */}
        {(neighbors.prev || neighbors.next) && (
          <nav className="flex items-stretch gap-3 border-t pt-6">
            {neighbors.prev ? (
              <Link
                href={`/chat/${neighbors.prev.id}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border p-3 text-left hover:border-primary/50"
              >
                <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Newer</span>
                  <span className="block truncate text-sm">{neighbors.prev.title}</span>
                </span>
              </Link>
            ) : (
              <span className="flex-1" />
            )}
            {neighbors.next ? (
              <Link
                href={`/chat/${neighbors.next.id}`}
                className="flex min-w-0 flex-1 items-center justify-end gap-2 rounded-xl border p-3 text-right hover:border-primary/50"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Older</span>
                  <span className="block truncate text-sm">{neighbors.next.title}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            ) : (
              <span className="flex-1" />
            )}
          </nav>
        )}
      </main>

      {showTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-6 z-30 grid size-11 place-items-center rounded-full border bg-card shadow-lg transition-colors hover:border-primary"
          aria-label="Back to top"
        >
          <ArrowUp className="size-5" />
        </button>
      )}
    </div>
  );
}

function CopyButton({
  text,
  className = "",
  label = "Copy",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text || "");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      aria-label={label}
      title={label}
      className={`grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground ${className}`}
    >
      {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}
