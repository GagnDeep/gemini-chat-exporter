import React, { useMemo, useState } from "react";
import type { Chat } from "@/lib/types";
import { chatInsights, type Entity } from "@/lib/insights";
import { searchFor } from "./App";
import { showToast } from "./toast";
import * as I from "./icons";

type Tab = "overview" | "links" | "people" | "orgs" | "places" | "topics" | "code" | "emails";

/** Per-chat insights as a docked side panel with tabs: stats overview plus
 *  dedicated tabs to browse links, typed named entities (People / Organizations /
 *  Places, via compromise), topics, code blocks and emails. Clicking an entity or
 *  topic highlights & scrolls to its occurrences IN THIS CHAT (primary); a small
 *  secondary control searches the whole archive. */
export function InsightsPanel({ chat, onClose, onJump }: { chat: Chat; onClose: () => void; onJump?: (term: string) => void }) {
  const ins = useMemo(() => chatInsights(chat), [chat]);
  const [tab, setTab] = useState<Tab>("overview");
  const [copied, setCopied] = useState<number | null>(null);

  const people = useMemo(() => ins.entities.filter((e) => e.kind === "person"), [ins.entities]);
  const orgs = useMemo(() => ins.entities.filter((e) => e.kind === "org"), [ins.entities]);
  const places = useMemo(() => ins.entities.filter((e) => e.kind === "place"), [ins.entities]);
  const other = useMemo(() => ins.entities.filter((e) => !e.kind || e.kind === "name"), [ins.entities]);
  // Uncategorized names fall under People so nothing is lost.
  const peopleAll = useMemo(() => [...people, ...other], [people, other]);

  const totalLinks = ins.links.reduce((n, g) => n + g.count, 0);
  const allTabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "links", label: "Links", count: totalLinks },
    { id: "people", label: "People", count: peopleAll.length },
    { id: "orgs", label: "Orgs", count: orgs.length },
    { id: "places", label: "Places", count: places.length },
    { id: "topics", label: "Topics", count: ins.topics.length },
    { id: "code", label: "Code", count: ins.code.length },
    { id: "emails", label: "Emails", count: ins.emails.length },
  ];
  const tabs = allTabs.filter((t) => t.count == null || t.count > 0 || t.id === "overview");
  // If the active tab has no items any more (e.g. content changed), fall back.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "overview";

  const copyCode = (i: number, code: string) => {
    navigator.clipboard.writeText(code).then(
      () => { setCopied(i); setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200); },
      () => showToast("Couldn't copy to clipboard", "err"),
    );
  };

  const jump = onJump ?? ((t: string) => searchFor(t));

  return (
    <aside className="insights dock" role="complementary" aria-label="Chat insights">
        <div className="ins-head">
          <strong><I.Bulb size={16} /> Insights</strong>
          <button className="iconbtn" title="Close insights" aria-label="Close insights" onClick={onClose}><I.Close size={16} /></button>
        </div>

        <div className="ins-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={activeTab === t.id}
              className={"ins-tab" + (activeTab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
              {t.label}{t.count != null && <span className="mt-count">{t.count}</span>}
            </button>
          ))}
        </div>

        <div className="ins-body">
          {activeTab === "overview" && (
            <>
              <div className="ins-stats">
                <Stat label="Q&A" value={ins.stats.turns} />
                <Stat label="Words" value={ins.stats.words.toLocaleString()} />
                <Stat label="~Tokens" value={ins.stats.tokens.toLocaleString()} />
                <Stat label="Reading" value={`${ins.stats.readingMinutes} min`} />
                <Stat label="Longest answer" value={`${ins.stats.longestAnswerWords.toLocaleString()} w`} />
                <Stat label="Code blocks" value={ins.code.length} />
                <Stat label="Links" value={totalLinks} />
                <Stat label="People" value={peopleAll.length} />
              </div>
              {ins.topics.length > 0 && (
                <Section title="Top topics">
                  <div className="chip-cloud sm">
                    {ins.topics.slice(0, 12).map((t) => (
                      <button key={t.term} className="cloud-chip" onClick={() => jump(t.term)} title={`Find “${t.term}” in this chat`}>{t.term}</button>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}

          {activeTab === "links" && (
            totalLinks === 0 ? <Empty>No links in this conversation.</Empty> :
            ins.links.map((g) => (
              <div className="link-group" key={g.domain}>
                <div className="link-domain">
                  <span className="dom-avatar">{g.domain.charAt(0).toUpperCase()}</span>
                  <span className="dom-name">{g.domain}</span>
                  <span className="dom-count">{g.count}</span>
                </div>
                <div className="link-items">
                  {g.items.map((l, i) => (
                    <a key={l.url + i} className="link-item" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                      <span className="li-text">{l.text || l.url}</span>
                      {l.context && <span className="li-ctx">…{l.context}…</span>}
                      <span className="li-meta">#{l.turnIndex + 1}</span>
                    </a>
                  ))}
                </div>
              </div>
            ))
          )}

          {activeTab === "people" && <EntityCloud entities={peopleAll} kind="person" onJump={jump} emptyLabel="No people detected." />}
          {activeTab === "orgs" && <EntityCloud entities={orgs} kind="org" onJump={jump} emptyLabel="No organizations detected." />}
          {activeTab === "places" && <EntityCloud entities={places} kind="place" onJump={jump} emptyLabel="No places detected." />}

          {activeTab === "topics" && (
            ins.topics.length === 0 ? <Empty>No topics extracted.</Empty> :
            <div className="chip-cloud">
              {ins.topics.map((t) => (
                <button key={t.term} className="cloud-chip" onClick={() => jump(t.term)} title={`Find “${t.term}” in this chat`}>{t.term}</button>
              ))}
            </div>
          )}

          {activeTab === "code" && (
            ins.code.length === 0 ? <Empty>No code blocks in this conversation.</Empty> :
            ins.code.map((c, i) => (
              <div className="code-card" key={i}>
                <div className="code-card-head">
                  <span className="code-lang-tag">{c.lang}</span>
                  <span className="dim">turn #{c.turnIndex + 1}</span>
                  <span className="spacer" />
                  <button className="btn ghost sm" onClick={() => copyCode(i, c.code)}>
                    <I.Copy size={13} /> {copied === i ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="code-card-body"><code>{c.code.length > 1200 ? c.code.slice(0, 1200) + "\n…" : c.code}</code></pre>
              </div>
            ))
          )}

          {activeTab === "emails" && (
            ins.emails.length === 0 ? <Empty>No email addresses found.</Empty> :
            <div className="chip-cloud">
              {ins.emails.map((e) => <a key={e} className="cloud-chip" href={`mailto:${e}`}>{e}</a>)}
            </div>
          )}
        </div>
    </aside>
  );
}

/** A cloud of typed entities: each chip jumps to occurrences in the current chat;
 *  a small ⌕ affordance searches the whole archive instead. */
function EntityCloud({ entities, kind, onJump, emptyLabel }: { entities: Entity[]; kind: string; onJump: (t: string) => void; emptyLabel: string }) {
  if (!entities.length) return <Empty>{emptyLabel}</Empty>;
  return (
    <div className="chip-cloud">
      {entities.map((e) => (
        <span key={e.name} className="entity-chip">
          <button className="cloud-chip ent-main" onClick={() => onJump(e.name)} title={`Find “${e.name}” in this chat`}>
            <span className={"kind-dot " + kind} />{e.name} <span className="chip-count">{e.count}</span>
          </button>
          <button className="ent-search" title="Search the whole archive" aria-label={`Search archive for ${e.name}`} onClick={() => searchFor(e.name)}>
            <I.Search size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="ins-stat"><span className="v">{value}</span><span className="k">{label}</span></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="ins-section"><div className="ins-section-head"><span>{title}</span></div>{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty" style={{ padding: 28 }}>{children}</div>;
}
