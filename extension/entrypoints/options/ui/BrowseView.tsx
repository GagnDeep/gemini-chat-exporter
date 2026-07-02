import React, { useMemo, useState } from "react";
import { archiveInsights, type Entity } from "@/lib/insights";
import { useChats } from "./store";
import { searchFor, navigate, chatLink } from "./App";
import { JobBanner } from "./JobBanner";
import * as I from "./icons";

type Tab = "topics" | "people" | "orgs" | "places" | "links" | "emails";

/** Whole-archive browse of derived insights. Reactive: `useChats()` reloads on
 *  any storage change, so captures/deletes update this view with no refresh.
 *  Entities are typed (People / Organizations / Places) via compromise — the same
 *  extraction the reader uses — so no "People & names" catch-all of regex noise. */
export function BrowseView() {
  const chats = useChats();
  const [tab, setTab] = useState<Tab>("topics");
  const data = useMemo(() => archiveInsights(chats), [chats]);

  const people = useMemo(() => data.entities.filter((e) => e.kind === "person" || !e.kind || e.kind === "name"), [data.entities]);
  const orgs = useMemo(() => data.entities.filter((e) => e.kind === "org"), [data.entities]);
  const places = useMemo(() => data.entities.filter((e) => e.kind === "place"), [data.entities]);

  const empty = !chats.length;

  const tabs: { id: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: "topics", label: "Topics", icon: <I.Tag size={14} />, count: data.topics.length },
    { id: "people", label: "People", icon: <I.User size={14} />, count: people.length },
    { id: "orgs", label: "Orgs", icon: <I.User size={14} />, count: orgs.length },
    { id: "places", label: "Places", icon: <I.Globe size={14} />, count: places.length },
    { id: "links", label: "Links", icon: <I.Link size={14} />, count: data.links.length },
    { id: "emails", label: "Emails", icon: <I.Msg size={14} />, count: data.emails.length },
  ];
  const activeTab = tabs.find((t) => t.id === tab) ? tab : "topics";

  return (
    <>
      <JobBanner />
      <div className="col search-wrap">
        <h1 className="greeting">Browse your <span className="grad">archive</span></h1>
        <div className="browse-stats">
          {data.totalChats.toLocaleString()} chats · {data.totalTurns.toLocaleString()} Q&amp;A · {data.totalWords.toLocaleString()} words
        </div>

        <div className="modes">
          {tabs.map((t) => (
            <button key={t.id} className={"mode-chip" + (activeTab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>
              {t.icon} {t.label}{t.count != null && <span className="mt-count">{t.count}</span>}
            </button>
          ))}
        </div>

        {empty ? (
          <div className="empty"><div className="big"><I.Globe size={22} /></div>
            <p>Nothing to browse yet. Capture a few conversations and topics, people, and links will surface here automatically.</p>
          </div>
        ) : activeTab === "topics" ? (
          <>
            <div className="section-label"><span>{data.topics.length} topics</span></div>
            <div className="chip-cloud">
              {data.topics.map((t) => (
                <button key={t.term} className="cloud-chip" style={{ fontSize: chipSize(t.weight, data.topics[0]?.weight || 1) }}
                  onClick={() => searchFor(t.term)} title={`Search “${t.term}”`}>{t.term}</button>
              ))}
            </div>
          </>
        ) : activeTab === "people" ? (
          <EntityTab entities={people} kind="person" noun="people" />
        ) : activeTab === "orgs" ? (
          <EntityTab entities={orgs} kind="org" noun="organizations" />
        ) : activeTab === "places" ? (
          <EntityTab entities={places} kind="place" noun="places" />
        ) : activeTab === "links" ? (
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
                        onClick={(e) => { e.preventDefault(); navigate(chatLink(l.chatId, l.turnIndex, undefined, undefined, [l.text || l.domain])); }}>
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

function EntityTab({ entities, kind, noun }: { entities: Entity[]; kind: string; noun: string }) {
  if (!entities.length) return <div className="empty" style={{ padding: 28 }}>No {noun} detected in your archive.</div>;
  return (
    <>
      <div className="section-label"><span>{entities.length} {noun}</span></div>
      <div className="chip-cloud">
        {entities.map((e) => (
          <button key={e.name} className="cloud-chip" onClick={() => searchFor(e.name)}
            title={`Appears in ${e.chatIds.length} chat${e.chatIds.length === 1 ? "" : "s"} · ${e.count}× · search archive`}>
            <span className={"kind-dot " + kind} />{e.name} <span className="chip-count">{e.count}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function chipSize(weight: number, max: number): number {
  const t = Math.min(1, weight / (max || 1));
  return Math.round(12 + t * 9); // 12–21px
}
