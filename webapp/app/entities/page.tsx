"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Sparkles, Search } from "lucide-react";

import { db } from "@/lib/db";
import { ENTITY_TYPE_LABELS, type Entity, type EntityType } from "@/lib/entities";
import { EntityBadge } from "@/components/entity-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { Input } from "@/components/ui/input";

const PER_TYPE_LIMIT = 40;

const TYPE_ORDER: EntityType[] = ["github", "huggingface", "project", "concept", "url"];

interface AggEntity {
  type: EntityType;
  value: string;
  label: string;
  count: number;
  chatIds: Set<string>;
}

export default function EntitiesPage() {
  return (
    <Suspense
      fallback={<div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>}
    >
      <EntitiesView />
    </Suspense>
  );
}

function EntitiesView() {
  const params = useSearchParams();
  const selType = (params.get("type") as EntityType | null) ?? null;
  const selValue = params.get("value");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<EntityType>>(new Set());

  const entities = useLiveQuery(() => db.entities.toArray(), [], [] as Entity[]);
  const chats = useLiveQuery(() => db.chats.toArray(), [], []);

  const chatTitle = useMemo(() => {
    const m = new Map<string, string>();
    (chats ?? []).forEach((c) => m.set(c.id, c.title));
    return m;
  }, [chats]);

  // Aggregate occurrences across turns into one row per (type, value).
  const grouped = useMemo(() => {
    const agg = new Map<string, AggEntity>();
    for (const e of entities ?? []) {
      const k = `${e.type}::${e.value}`;
      const cur = agg.get(k);
      if (cur) {
        cur.count += e.count;
        cur.chatIds.add(e.chatId);
      } else {
        agg.set(k, {
          type: e.type,
          value: e.value,
          label: e.label,
          count: e.count,
          chatIds: new Set([e.chatId]),
        });
      }
    }
    const byType = new Map<EntityType, AggEntity[]>();
    for (const a of agg.values()) {
      if (!byType.has(a.type)) byType.set(a.type, []);
      byType.get(a.type)!.push(a);
    }
    for (const list of byType.values()) {
      list.sort((a, b) => b.chatIds.size - a.chatIds.size || b.count - a.count);
    }
    return byType;
  }, [entities]);

  // For the selected entity: the turns that mention it, grouped by chat.
  const selectedMentions = useMemo(() => {
    if (!selType || !selValue) return null;
    const rows = (entities ?? []).filter((e) => e.type === selType && e.value === selValue);
    const byChat = new Map<string, number[]>();
    for (const e of rows) {
      if (!byChat.has(e.chatId)) byChat.set(e.chatId, []);
      byChat.get(e.chatId)!.push(e.turnIndex);
    }
    for (const arr of byChat.values()) arr.sort((a, b) => a - b);
    return byChat;
  }, [entities, selType, selValue]);

  const hasEntities = (entities?.length ?? 0) > 0;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="grid size-9 place-items-center rounded-lg border hover:bg-secondary"
            aria-label="Back to archive"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex-1">
            <h1 className="text-base font-semibold leading-tight">
              Entities &amp; <span className="gemini-text">concepts</span>
            </h1>
            <p className="text-xs text-muted-foreground">
              Detected across your chats — click any to see where it's mentioned
            </p>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-6">
          {hasEntities && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter entities & concepts…"
                className="pl-9"
              />
            </div>
          )}
          {!hasEntities ? (
            <div className="rounded-xl border border-dashed p-10 text-center">
              <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl gemini-gradient text-white">
                <Sparkles className="size-6" />
              </div>
              <h3 className="text-lg font-semibold">No entities yet</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Import a chat to detect GitHub repos, Hugging Face models, links, and projects.
                Build the semantic index to add ranked concepts.
              </p>
            </div>
          ) : (
            (() => {
              const f = filter.trim().toLowerCase();
              const sections = TYPE_ORDER.filter((t) => grouped.has(t))
                .map((type) => {
                  const all = grouped.get(type)!;
                  const list = f
                    ? all.filter(
                        (a) => a.value.toLowerCase().includes(f) || a.label.toLowerCase().includes(f),
                      )
                    : all;
                  return { type, list };
                })
                .filter((s) => s.list.length > 0);

              if (!sections.length) {
                return (
                  <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                    Nothing matches “{filter}”.
                  </p>
                );
              }

              return sections.map(({ type, list }) => {
                const isOpen = expanded.has(type) || !!f;
                const shown = isOpen ? list : list.slice(0, PER_TYPE_LIMIT);
                return (
                  <div key={type} className="rounded-xl border bg-card p-4">
                    <h2 className="mb-3 text-sm font-semibold">
                      {ENTITY_TYPE_LABELS[type]}{" "}
                      <span className="text-muted-foreground">({list.length})</span>
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {shown.map((a) => (
                        <span key={a.value} className="inline-flex items-center">
                          <EntityBadge
                            type={a.type}
                            value={a.value}
                            label={`${a.label} · ${a.chatIds.size}`}
                            className={
                              selType === a.type && selValue === a.value
                                ? "ring-2 ring-primary"
                                : undefined
                            }
                          />
                        </span>
                      ))}
                    </div>
                    {!f && list.length > PER_TYPE_LIMIT && (
                      <button
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(type)) next.delete(type);
                            else next.add(type);
                            return next;
                          })
                        }
                        className="mt-3 text-xs text-primary underline"
                      >
                        {isOpen ? "Show fewer" : `Show all ${list.length}`}
                      </button>
                    )}
                  </div>
                );
              });
            })()
          )}
        </section>

        {/* Filter / detail rail */}
        <aside className="space-y-3">
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">
              {selType && selValue ? "Mentions" : "Select an entity"}
            </h2>
            {!selType || !selValue ? (
              <p className="text-xs text-muted-foreground">
                Click an entity to list the chats and turns that mention it.
              </p>
            ) : !selectedMentions || selectedMentions.size === 0 ? (
              <p className="text-xs text-muted-foreground">No current mentions.</p>
            ) : (
              <div className="space-y-3">
                <p className="break-words text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{selValue}</span>
                </p>
                <ul className="space-y-2">
                  {[...selectedMentions.entries()].map(([chatId, turns]) => (
                    <li key={chatId} className="rounded-lg border p-2.5">
                      <Link
                        href={`/chat/${chatId}`}
                        className="block truncate text-sm font-medium hover:text-primary"
                      >
                        {chatTitle.get(chatId) ?? chatId}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {turns.map((t) => (
                          <Link
                            key={t}
                            href={`/chat/${chatId}#turn-${t}`}
                            className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground hover:text-primary"
                          >
                            turn {t + 1}
                          </Link>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
                <Link href="/entities" className="inline-block text-xs text-primary underline">
                  Clear filter
                </Link>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
