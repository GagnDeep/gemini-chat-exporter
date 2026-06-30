// Shared download helpers for EPUB / Markdown / JSON. Used by both the archive
// page and the popup (single source of truth — no duplicated slugify/download).
// DOM-only (document/Blob), so import from page/popup contexts, not background.

import { buildEpub } from "@/lib/epub";
import { chatsToMarkdown } from "@/lib/markdown";
import { EXPORT_FORMAT, EXPORT_VERSION, type Chat, type GeminiExport } from "@/lib/types";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "gemini-chat";
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportEpub(chats: Chat[]): Promise<void> {
  if (!chats.length) return;
  const blob = await buildEpub(chats, { title: chats.length === 1 ? chats[0]!.title : "Gemini Chats" });
  download(blob, chats.length === 1 ? `${slugify(chats[0]!.title)}.epub` : "gemini-chats.epub");
}

export function exportMarkdown(chats: Chat[]): void {
  if (!chats.length) return;
  download(
    new Blob([chatsToMarkdown(chats)], { type: "text/markdown" }),
    chats.length === 1 ? `${slugify(chats[0]!.title)}.md` : "gemini-chats.md",
  );
}

export function exportJson(chats: Chat[]): void {
  if (!chats.length) return;
  const payload: GeminiExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    chats,
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "gemini-chats.json");
}
