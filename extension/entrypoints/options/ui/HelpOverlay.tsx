import React, { useEffect } from "react";

const SHORTCUTS: [string, string][] = [
  ["/", "Focus search"],
  ["⌘ / Ctrl + K", "Command palette"],
  ["↑ ↓", "Move through results"],
  ["Enter", "Open selected result"],
  ["Esc", "Clear search / close overlay"],
  ["F (in a chat)", "Find within the conversation"],
  ["N / Shift+N", "Next / previous match in a chat"],
  ["?", "Toggle this help"],
];

export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="palette-input" style={{ cursor: "default" }}>
          <strong style={{ fontSize: 15 }}>Keyboard shortcuts</strong>
        </div>
        <div style={{ padding: "8px 6px 12px" }}>
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="shortcut-row">
              <span>{v}</span>
              <kbd>{k}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
