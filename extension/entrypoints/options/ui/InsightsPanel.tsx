import React, { useMemo, useState } from "react";
import type { Chat } from "@/lib/types";
import { chatInsights } from "@/lib/insights";
import { searchFor } from "./App";
import * as I from "./icons";

type Tab = "overview" | "links" | "people" | "topics" | "code" | "emails";

/** Per-chat insights as a docked side panel with tabs: stats overview plus
 *  dedicated tabs to browse every link (with context), person/name, topic, code
 *  block and email extracted from the conversation. Derived from chat content. */
export function InsightsPanel({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const ins = useMemo(() => chatInsights(chat), [chat]);
  const [tab, setTab] = useState<Tab>("overview");
  const [copied, setCopied] = useState<number | null>(null);

  const totalLinks = ins.links.reduce((n, g) => n + g.count, 0);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "links", label: "Links", count: totalLinks },
    { id: "people", label: "People", count: ins.entities.length },
    { id: "topics", label: "Topics", count: ins.topics.length },
    { id: "code", label: "Code", count: ins.code.length },
    { id: "emails", label: "Emails", count: ins.emails.length },
  ];

  const copyCode = (i: number, code: string) => {
    void navigator.clipboard.writeText(code);
    setCopied(i);
    setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
  };

  return (
    <aside className="insights dock" role="complementary" aria-label="Chat insights">
        <div className="ins-head">
          <strong><I.Bulb size={16} /> Insights</strong>
          <button className="iconbtn" title="Close insights" aria-label="Close insights" onClick={onClose}><I.Close size={16} /></button>
        </div>

        <div className="ins-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id}
              className={"ins-tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
              {t.label}{t.count != null && <span className="mt-count">{t.count}</span>}
            </button>
          ))}
        </div>

        <div className="ins-body">
          {tab === "overview" && (
            <>
              <div className="ins-stats">
                <Stat label="Q&A" value={ins.stats.turns} />
                <Stat label="Words" value={ins.stats.words.toLocaleString()} />
                <Stat label="~Tokens" value={ins.stats.tokens.toLocaleString()} />
                <Stat label="Reading" value={`${ins.stats.readingMinutes} min`} />
                <Stat label="Longest answer" value={`${ins.stats.longestAnswerWords.toLocaleString()} w`} />
                <Stat label="Code blocks" value={ins.code.length} />
                <Stat label="Links" value={totalLinks} />
                <Stat label="People" value={ins.entities.length} />
              </div>
              {ins.topics.length > 0 && (
                <Section title="Top topics">
                  <div className="chip-cloud sm">
                    {ins.topics.slice(0, 12).map((t) => (
                      <button key={t.term} className="cloud-chip" onClick={() => searchFor(t.term)}>{t.term}</button>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}

          {tab === "links" && (
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

          {tab === "people" && (
            ins.entities.length === 0 ? <Empty>No people or named entities detected.</Empty> :
            <div className="chip-cloud">
              {ins.entities.map((e) => (
                <button key={e.name} className="cloud-chip" onClick={() => searchFor(e.name)} title={`${e.kind ?? "name"} · ${e.count}× · search`}>
                  {e.kind && <span className={"kind-dot " + e.kind} />}{e.name} <span className="chip-count">{e.count}</span>
                </button>
              ))}
            </div>
          )}

          {tab === "topics" && (
            ins.topics.length === 0 ? <Empty>No topics extracted.</Empty> :
            <div className="chip-cloud">
              {ins.topics.map((t) => (
                <button key={t.term} className="cloud-chip" onClick={() => searchFor(t.term)} title={`Search “${t.term}”`}>{t.term}</button>
              ))}
            </div>
          )}

          {tab === "code" && (
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

          {tab === "emails" && (
            ins.emails.length === 0 ? <Empty>No email addresses found.</Empty> :
            <div className="chip-cloud">
              {ins.emails.map((e) => <a key={e} className="cloud-chip" href={`mailto:${e}`}>{e}</a>)}
            </div>
          )}
        </div>
    </aside>
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
