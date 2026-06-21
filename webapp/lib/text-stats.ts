// Small shared helpers for word counts, reading time, and relative timestamps.

import type { Chat } from "./types";

export function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) || []).length;
}

export function chatWordCount(chat: Chat): number {
  let n = 0;
  for (const t of chat.turns) n += wordCount(t.question) + wordCount(t.answerText);
  return n;
}

/** Human reading time at ~200 wpm. */
export function readingTime(words: number): string {
  const mins = Math.max(1, Math.round(words / 200));
  return `${mins} min read`;
}

/** Compact relative time, e.g. "3d ago", "just now". Falls back to the date. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso?.slice(0, 10) || "";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.round(mon / 12)}y ago`;
}
