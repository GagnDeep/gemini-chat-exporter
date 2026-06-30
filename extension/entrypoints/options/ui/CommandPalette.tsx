import React, { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { useChats, useChatMeta } from "./store";
import { displayTitle } from "@/lib/meta";
import { exportEpub, exportJson, exportMarkdown } from "./exporters";
import { navigate } from "./App";
import * as I from "./icons";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chats = useChats();
  const meta = useChatMeta();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const actions: Cmd[] = useMemo(() => [
    { id: "go-search", label: "Go to Search", icon: <I.Search size={16} />, run: () => navigate("#/search") },
    { id: "go-settings", label: "Open Settings & Archive", icon: <I.SettingsIcon size={16} />, run: () => navigate("#/settings") },
    { id: "theme", label: "Toggle light / dark theme", icon: <I.Sun size={16} />, run: () => window.dispatchEvent(new Event("toggle-theme")) },
    { id: "exp-json", label: "Export all as JSON", icon: <I.Json size={16} />, run: () => exportJson(chats) },
    { id: "exp-md", label: "Export all as Markdown", icon: <I.Doc size={16} />, run: () => exportMarkdown(chats) },
    { id: "exp-epub", label: "Export all as EPUB", icon: <I.Download size={16} />, run: () => void exportEpub(chats) },
  ], [chats]);

  const items: Cmd[] = useMemo(() => {
    const term = q.trim();
    const chatCmds: Cmd[] = chats.map((c) => ({
      id: "chat:" + c.id,
      label: displayTitle(meta, c.id, c.title),
      hint: `${c.turns.length} Q&A`,
      icon: <I.Msg size={16} />,
      run: () => navigate(`#/chat/${encodeURIComponent(c.id)}`),
    }));
    if (!term) return [...actions, ...chatCmds.slice(0, 8)];
    const fuse = new Fuse([...actions, ...chatCmds], { keys: ["label"], threshold: 0.4, ignoreLocation: true });
    return fuse.search(term).map((r) => r.item).slice(0, 30);
  }, [q, chats, meta, actions]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const it = items[sel]; if (it) { it.run(); onClose(); } }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, items, sel, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <I.Search size={18} />
          <input ref={inputRef} value={q} placeholder="Search chats or run a command…"
            onChange={(e) => { setQ(e.target.value); setSel(0); }} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {items.map((it, i) => (
            <button key={it.id} className={"palette-item" + (i === sel ? " sel" : "")}
              onMouseEnter={() => setSel(i)} onClick={() => { it.run(); onClose(); }}>
              <span className="pi-icon">{it.icon}</span>
              <span className="pi-label">{it.label}</span>
              {it.hint && <span className="pi-hint">{it.hint}</span>}
            </button>
          ))}
          {!items.length && <div className="empty" style={{ padding: 24 }}>No matches.</div>}
        </div>
      </div>
    </div>
  );
}
