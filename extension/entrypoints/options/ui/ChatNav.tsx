import React, { useMemo, useState } from "react";
import { displayTitle } from "@/lib/meta";
import type { Chat } from "@/lib/types";
import { providerById } from "@/lib/providers";
import { useChats, useChatMeta } from "./store";
import { shortDate } from "./segments";
import { navigate, chatLink } from "./App";
import { ResizeHandle } from "./resize";
import * as I from "./icons";

/** Small colored source badge (Gemini / Claude / ChatGPT). */
function SourceBadge({ source }: { source?: string }) {
  const p = providerById(source);
  if (!p) return null;
  return (
    <span
      className="cn-src"
      title={p.label}
      style={{
        color: p.accent,
        border: `1px solid ${p.accent}55`,
        borderRadius: 6,
        padding: "0 5px",
        fontSize: 10,
        lineHeight: "15px",
        fontWeight: 600,
        letterSpacing: ".02em",
      }}
    >
      {p.glyph} {p.label}
    </span>
  );
}

/** Collapsible, resizable chat-switcher sidebar (lives in App, beside the rail).
 *  Lists pinned + recent chats with a quick filter; clicking opens that chat. */
export function ChatNav({
  activeChatId, width, onWidthChange, onClose,
}: {
  activeChatId?: string;
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;
}) {
  const chats = useChats();
  const meta = useChatMeta();
  const [q, setQ] = useState("");

  const pinned = useMemo(
    () => chats.filter((c) => meta[c.id]?.pinned)
      .sort((a, b) => (meta[b.id]?.pinnedAt || "").localeCompare(meta[a.id]?.pinnedAt || "")),
    [chats, meta],
  );
  const recent = useMemo(
    () => [...chats].filter((c) => !meta[c.id]?.pinned)
      .sort((a, b) => (b.scrapedAt || "").localeCompare(a.scrapedAt || "")),
    [chats, meta],
  );

  const needle = q.trim().toLowerCase();
  const match = (id: string, title: string) => !needle || displayTitle(meta, id, title).toLowerCase().includes(needle);
  const fPinned = pinned.filter((c) => match(c.id, c.title));
  const fRecent = recent.filter((c) => match(c.id, c.title)).slice(0, 60);

  const open = (id: string) => navigate(chatLink(id));

  const Row = (c: Chat, isPinned: boolean) => (
    <button key={c.id} className={"cn-row" + (c.id === activeChatId ? " on" : "")}
      onClick={() => open(c.id)} title={displayTitle(meta, c.id, c.title)}>
      <span className="cn-ic">{isPinned ? <I.Pin size={15} /> : <I.Msg size={15} />}</span>
      <span className="cn-body">
        <span className="cn-title">{displayTitle(meta, c.id, c.title)}</span>
        <span className="cn-sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <SourceBadge source={c.source} />
          <span>{c.turns.length} Q&amp;A · {shortDate(c.scrapedAt)}</span>
        </span>
      </span>
    </button>
  );

  return (
    <aside className="chatnav" style={{ width }} aria-label="Chats">
      <div className="cn-head">
        <strong><I.Msg size={15} /> Chats</strong>
        <button className="iconbtn" title="Hide sidebar" aria-label="Hide sidebar" onClick={onClose}><I.Close size={16} /></button>
      </div>
      <div className="cn-filter">
        <I.Search size={14} />
        <input value={q} placeholder="Filter chats…" aria-label="Filter chats"
          onChange={(e) => setQ(e.target.value)} spellCheck={false} autoComplete="off" />
        {q && <button className="iconbtn" title="Clear" aria-label="Clear filter" onClick={() => setQ("")}><I.Close size={14} /></button>}
      </div>
      <div className="cn-list">
        {chats.length === 0 && <div className="cn-empty">No chats captured yet.</div>}
        {fPinned.length > 0 && <div className="cn-label">Pinned</div>}
        {fPinned.map((c) => Row(c, true))}
        {fRecent.length > 0 && <div className="cn-label">Recent</div>}
        {fRecent.map((c) => Row(c, false))}
        {needle && fPinned.length === 0 && fRecent.length === 0 && (
          <div className="cn-empty">No chats match “{q.trim()}”.</div>
        )}
      </div>
      <ResizeHandle value={width} min={200} max={420} onChange={onWidthChange} edge="right" title="Drag to resize sidebar" />
    </aside>
  );
}
