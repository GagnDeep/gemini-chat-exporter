// Small, dependency-free resize primitives shared by the chat sidebar and the
// outline. No drag library — a thin grabber bar drives a clamped width that is
// persisted to localStorage and published as a CSS variable by the consumer.

import React, { useCallback, useState } from "react";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Width state persisted under `key`, clamped to [min, max]. */
export function usePersistentWidth(key: string, def: number, min: number, max: number): [number, (w: number) => void] {
  const [width, set] = useState<number>(() => {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw, min, max) : def;
  });
  const setWidth = useCallback((w: number) => {
    const c = clamp(Math.round(w), min, max);
    set(c);
    localStorage.setItem(key, String(c));
  }, [key, min, max]);
  return [width, setWidth];
}

/**
 * A draggable edge. `edge="right"` grows the panel as the pointer moves right;
 * `edge="left"` grows it as the pointer moves left. Uses pointer capture so the
 * drag keeps tracking outside the handle, and flags <body> for cursor/no-select.
 */
export function ResizeHandle({
  value, min, max, onChange, edge = "right", title = "Drag to resize",
}: {
  value: number;
  min: number;
  max: number;
  onChange: (w: number) => void;
  edge?: "left" | "right";
  title?: string;
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = value;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      onChange(startW + (edge === "right" ? dx : -dx));
    };
    const onUp = (ev: PointerEvent) => {
      try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      document.body.classList.remove("dragging");
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  return React.createElement("div", {
    className: "resize-handle " + edge,
    role: "separator",
    "aria-orientation": "vertical",
    title,
    onPointerDown,
  });
}
