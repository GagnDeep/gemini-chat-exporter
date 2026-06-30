import React, { useMemo, useState } from "react";
import type { Chat } from "@/lib/types";
import { displayTitle, togglePin } from "@/lib/meta";
import { useChats, useChatMeta, deleteChats } from "./store";
import { chatWordCount, shortDate } from "./segments";
import { exportEpub, exportMarkdown, exportJson } from "./exporters";
import { showToast } from "./toast";
import { navigate, chatLink } from "./App";
import * as I from "./icons";

type SortKey = "recent" | "title" | "length" | "pinned";

/** Sortable, filterable, multi-selectable list of every chat with bulk
 *  export/delete + per-row actions. Reactive via useChats(). */
export function ArchiveManager() {
  const chats = useChats();
  const meta = useChatMeta();
  const [sort, setSort] = useState<SortKey>("recent");
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    let list = chats.map((c) => ({
      chat: c,
      title: displayTitle(meta, c.id, c.title),
      words: chatWordCount(c),
      pinned: !!meta[c.id]?.pinned,
    }));
    if (f) list = list.filter((r) => r.title.toLowerCase().includes(f));
    list.sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "length") return b.words - a.words;
      if (sort === "pinned") return Number(b.pinned) - Number(a.pinned) || (b.chat.scrapedAt || "").localeCompare(a.chat.scrapedAt || "");
      return (b.chat.scrapedAt || "").localeCompare(a.chat.scrapedAt || "");
    });
    return list;
  }, [chats, meta, sort, filter]);

  const allSelected = rows.length > 0 && rows.every((r) => sel.has(r.chat.id));
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(rows.map((r) => r.chat.id)));
  const toggle = (id: string) => setSel((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const selectedChats = (): Chat[] => chats.filter((c) => sel.has(c.id));

  const bulkDelete = async () => {
    const ids = [...sel];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} chat${ids.length === 1 ? "" : "s"} from the archive? This cannot be undone.`)) return;
    const n = await deleteChats(ids);
    setSel(new Set());
    showToast(`Deleted ${n} chat${n === 1 ? "" : "s"}.`, "ok");
  };

  const deleteOne = async (id: string, title: string) => {
    if (!confirm(`Delete “${title}”? This cannot be undone.`)) return;
    await deleteChats([id]);
    setSel((cur) => { const n = new Set(cur); n.delete(id); return n; });
    showToast("Chat deleted.", "ok");
  };

  const bulkExport = async (kind: "epub" | "md" | "json") => {
    const list = selectedChats();
    if (!list.length) return;
    try {
      if (kind === "epub") await exportEpub(list);
      else if (kind === "md") exportMarkdown(list);
      else exportJson(list);
      showToast(`Exported ${list.length} chat${list.length === 1 ? "" : "s"}.`, "ok");
    } catch (e) {
      showToast("Export failed: " + (e instanceof Error ? e.message : String(e)), "err");
    }
  };

  return (
    <div className="card">
      <h2>Manage chats</h2>
      <div className="toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
        <div className="searchbox sm">
          <span className="icn"><I.Search size={15} /></span>
          <input value={filter} placeholder="Filter by title…" onChange={(e) => setFilter(e.target.value)} aria-label="Filter chats" />
        </div>
        <div className="seg">
          {(["recent", "title", "length", "pinned"] as SortKey[]).map((k) => (
            <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>
              {k === "recent" ? "Recent" : k === "title" ? "Title" : k === "length" ? "Longest" : "Pinned"}
            </button>
          ))}
        </div>
      </div>

      <div className="manage-bar">
        <label className="row-check inline">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
          <span>{sel.size ? `${sel.size} selected` : `${rows.length} chat${rows.length === 1 ? "" : "s"}`}</span>
        </label>
        <span className="spacer" />
        {sel.size > 0 && (
          <>
            <button className="btn ghost sm" onClick={() => void bulkExport("epub")}><I.Download size={14} /> EPUB</button>
            <button className="btn ghost sm" onClick={() => void bulkExport("md")}><I.Doc size={14} /> MD</button>
            <button className="btn ghost sm" onClick={() => void bulkExport("json")}><I.Json size={14} /> JSON</button>
            <button className="btn ghost sm" style={{ color: "var(--danger)" }} onClick={() => void bulkDelete()}><I.Trash size={14} /> Delete</button>
          </>
        )}
      </div>

      <div className="manage-list">
        {rows.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>{filter ? "No chats match that filter." : "No chats yet."}</div>
        ) : rows.map((r) => (
          <div key={r.chat.id} className={"manage-row" + (sel.has(r.chat.id) ? " sel" : "")}>
            <input type="checkbox" checked={sel.has(r.chat.id)} onChange={() => toggle(r.chat.id)} aria-label={`Select ${r.title}`} />
            <button className="mr-main" onClick={() => navigate(chatLink(r.chat.id))} title="Open chat">
              <span className="mr-title">{r.pinned && <I.Pin size={12} />} {r.title}</span>
              <span className="mr-sub">{r.chat.turns.length} Q&A · {r.words.toLocaleString()} words · {shortDate(r.chat.scrapedAt)}</span>
            </button>
            <button className="iconbtn sm" title={r.pinned ? "Unpin" : "Pin"} aria-label="Pin" onClick={() => void togglePin(r.chat.id)}>
              {r.pinned ? <I.Pin size={15} /> : <I.PinOff size={15} />}
            </button>
            <button className="iconbtn sm" title="Delete" aria-label="Delete chat" style={{ color: "var(--danger)" }} onClick={() => void deleteOne(r.chat.id, r.title)}>
              <I.Trash size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
