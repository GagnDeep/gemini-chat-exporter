import React, { useEffect, useState } from "react";
import type { Chat } from "@/lib/types";
import type { OutlineSection, SectionKind } from "./outlineSections";
import { ResizeHandle, usePersistentWidth } from "./resize";
import * as I from "./icons";

/** Per-turn cap before a "+N more" toggle, so long answers stay scannable. */
const SECTION_CAP = 8;

const KIND_ICON: Record<SectionKind, React.ReactNode> = {
  heading: <I.Tag size={12} />,
  list: <I.List size={12} />,
  table: <I.Doc size={12} />,
  code: <I.Type size={12} />,
  quote: <I.Msg size={12} />,
};

/** Collapsible, structure-aware table of contents. Top level is one row per
 *  question; expanding a row reveals the answer's markdown structure (headings,
 *  lists, tables, code, quotes). Clicks route through onJump* so scrolling works
 *  with the virtualized reader. */
export function Outline({
  chat, sectionsByTurn, onClose, onJumpTurn, onJumpSection,
}: {
  chat: Chat;
  sectionsByTurn: Map<number, OutlineSection[]>;
  onClose: () => void;
  onJumpTurn: (index: number) => void;
  onJumpSection: (turnIndex: number, sectionId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState<Set<number>>(new Set());
  const [width, setWidth] = usePersistentWidth("outline-width", 300, 220, 520);

  // Publish width so .outline and .main.dock-l padding track it live.
  useEffect(() => {
    document.documentElement.style.setProperty("--outline-w", width + "px");
  }, [width]);

  const toggle = (i: number) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const toggleAll = (i: number) =>
    setShowAll((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });

  return (
    <aside className="outline" role="navigation" aria-label="Conversation outline" style={{ width }}>
      <div className="ins-head">
        <strong><I.Outline size={15} /> Outline</strong>
        <button className="iconbtn" title="Close outline" aria-label="Close outline" onClick={onClose}><I.Close size={16} /></button>
      </div>
      <ol className="outline-list">
        {chat.turns.map((t) => {
          const sections = sectionsByTurn.get(t.index) || [];
          const hasSections = sections.length > 0;
          const open = expanded.has(t.index);
          const all = showAll.has(t.index);
          const visible = all ? sections : sections.slice(0, SECTION_CAP);
          const hidden = sections.length - visible.length;
          return (
            <li key={t.key || t.index} className="ol-turn">
              <div className={"outline-item" + (open ? " open" : "")}>
                {hasSections ? (
                  <button className="ol-caret" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}
                    onClick={() => toggle(t.index)}>
                    <I.ChevDown size={13} className={open ? "" : "rot-90"} />
                  </button>
                ) : <span className="ol-caret-spacer" />}
                <button className="ol-q" onClick={() => onJumpTurn(t.index)} title={t.question || `Turn ${t.index + 1}`}>
                  <span className="oi-num">{t.index + 1}</span>
                  <span className="oi-text">{t.question?.trim() || "(no question)"}</span>
                </button>
              </div>
              {open && hasSections && (
                <ul className="ol-sections">
                  {visible.map((s) => (
                    <li key={s.id}>
                      <button className={"ol-sec lvl-" + Math.min(s.level, 5) + " kind-" + s.kind}
                        onClick={() => onJumpSection(t.index, s.id)} title={s.label}>
                        <span className="ol-sec-icn">{KIND_ICON[s.kind]}</span>
                        <span className="ol-sec-text">{s.label}</span>
                      </button>
                    </li>
                  ))}
                  {hidden > 0 && (
                    <li><button className="ol-more" onClick={() => toggleAll(t.index)}>+{hidden} more</button></li>
                  )}
                  {all && sections.length > SECTION_CAP && (
                    <li><button className="ol-more" onClick={() => toggleAll(t.index)}>Show fewer</button></li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <ResizeHandle value={width} min={220} max={520} onChange={setWidth} edge="right" title="Drag to resize outline" />
    </aside>
  );
}
