import React, { useMemo, useState } from "react";
import { archiveInsights } from "@/lib/insights";
import { useChats } from "./store";
import { searchFor, navigate, chatLink } from "./App";
import { JobBanner } from "./JobBanner";
import * as I from "./icons";

type Tab = "topics" | "entities" | "links" | "emails";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "topics", label: "Topics", icon: <I.Tag size={14} /> },
  { id: "entities", label: "People & names", icon: <I.User size={14} /> },
  { id: "links", label: "Links", icon: <I.Link size={14} /> },
  { id: "emails", label: "Emails", icon: <I.Msg size={14} /> },
];

/** Whole-archive browse of derived insights. Reactive: `useChats()` reloads on
 *  any storage change, so captures/deletes update this view with no refresh. */
export function BrowseView() {
  const chats = useChats();
  const [tab, setTab] = useState<Tab>("topics");
  const data = useMemo(() => archiveInsights(chats), [chats]);

  const empty = !chats.length;

  return (
    <>
      <JobBanner />
      <div className="col search-wrap">
        <h1 className="greeting">Browse your <span className="grad">archive</span></h1>
        <div className="browse-stats">
          {data.totalChats.toLocaleString()} chats · {data.totalTurns.toLocaleString()} Q&amp;A · {data.totalWords.toLocaleString()} words
        </div>

        <div className="modes">
          {TABS.map((t) => (
            <button key={t.id} className={"mode-chip" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {empty ? (
          <div className="empty"><div className="big"><I.Globe size={22} /></div>
            <p>Nothing to browse yet. Capture a few conversations and topics, people, and links will surface here automatically.</p>
          </div>
        ) : tab === "topics" ? (
          <>
            <div className="section-label"><span>{data.topics.length} topics</span></div>
            <div className="chip-cloud">
              {data.topics.map((t) => (
                <button key={t.term} className="cloud-chip" style={{ fontSize: chipSize(t.weight, data.topics[0]?.weight || 1) }}
                  onClick={() => searchFor(t.term)} title={`Search “${t.term}”`}>{t.term}</button>
              ))}
            </div>
          </>
        ) : tab === "entities" ? (
          <>
            <div className="section-label"><span>{data.entities.length} people &amp; names</span></div>
            <div className="chip-cloud">
              {data.entities.map((e) => (
                <button key={e.name} className="cloud-chip" onClick={() => searchFor(e.name)}
                  title={`Appears in ${e.chatIds.length} chat${e.chatIds.length === 1 ? "" : "s"} · ${e.count}×`}>
                  {e.name} <span className="chip-count">{e.count}</span>
                </button>
              ))}
            </div>
          </>
        ) : tab === "links" ? (
          <>
            <div className="section-label"><span>{data.links.length} domains · {data.links.reduce((n, g) => n + g.count, 0)} links</span></div>
            {data.links.map((g) => (
              <div className="link-group" key={g.domain}>
                <div className="link-domain">
                  <span className="dom-avatar">{g.domain.charAt(0).toUpperCase()}</span>
                  <span className="dom-name">{g.domain}</span>
                  <span className="dom-count">{g.count}</span>
                </div>
                <div className="link-items">
                  {g.items.slice(0, 12).map((l, i) => (
                    <a key={l.url + i} className="link-item" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                      <span className="li-text">{l.text || l.url}</span>
                      {l.context && <span className="li-ctx">{l.context}</span>}
                      <button className="li-src" title="Open the chat this link came from"
                        onClick={(e) => { e.preventDefault(); navigate(chatLink(l.chatId, l.turnIndex)); }}>
                        <I.Msg size={12} /> {l.chatTitle || "chat"}
                      </button>
                    </a>
                  ))}
                  {g.items.length > 12 && <div className="li-more">+{g.items.length - 12} more</div>}
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="section-label"><span>{data.emails.length} emails</span></div>
            <div className="chip-cloud">
              {data.emails.map((e) => (
                <a key={e.value} className="cloud-chip" href={`mailto:${e.value}`}>
                  {e.value} <span className="chip-count">{e.count}</span>
                </a>
              ))}
              {!data.emails.length && <div className="empty">No email addresses found in your archive.</div>}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function chipSize(weight: number, max: number): number {
  const t = Math.min(1, weight / (max || 1));
  return Math.round(12 + t * 9); // 12–21px
}
