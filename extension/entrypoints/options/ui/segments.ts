// Flatten chats into searchable segments (one per Q&A turn) and small text utils.

import type { Chat, Segment } from "@/lib/types";

export function segmentsFromChats(chats: Chat[]): Segment[] {
  const segs: Segment[] = [];
  for (const chat of chats) {
    for (const t of chat.turns) {
      segs.push({
        id: `${chat.id}#${t.index}`,
        chatId: chat.id,
        chatTitle: chat.title,
        turnIndex: t.index,
        question: t.question,
        answerText: t.answerText,
        text: `${t.question}\n\n${t.answerText}`.trim(),
        scrapedAt: chat.scrapedAt,
        hasCode: /<pre[\s>]|<code[\s>]/i.test(t.answerHtml || ""),
        embedding: null,
      });
    }
  }
  return segs;
}

/** Cheap stable hash of a string (FNV-1a → base36). */
export function hashText(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function wordCount(s: string): number {
  return ((s || "").trim().match(/\S+/g) || []).length;
}

export function chatWordCount(chat: Chat): number {
  let n = 0;
  for (const t of chat.turns) n += wordCount(t.question) + wordCount(t.answerText);
  return n;
}

/** "3 days ago" style relative time. */
export function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const day = 86_400_000;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < day * 7) return `${Math.round(diff / day)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Short calendar date like "28 Jun" (matches Gemini's list dates). */
export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
