// Plain Markdown export of chats — a portable companion to the EPUB output.

import type { Chat } from "./types";

function wordCount(s: string): number {
  return ((s || "").trim().match(/\S+/g) || []).length;
}

function chatWords(chat: Chat): number {
  let n = 0;
  for (const t of chat.turns) n += wordCount(t.question) + wordCount(t.answerText);
  return n;
}

function readingTime(words: number): string {
  return `${Math.max(1, Math.round(words / 200))} min read`;
}

function chatToMarkdown(chat: Chat): string {
  const words = chatWords(chat);
  const lines: string[] = [`# ${chat.title}`, ""];
  lines.push(
    `> ${chat.turns.length} Q&A · ~${words.toLocaleString()} words · ${readingTime(words)} · scraped ${chat.scrapedAt.slice(0, 10)}`,
  );
  if (chat.url) lines.push(`>`, `> [Original conversation](${chat.url})`);
  lines.push("");

  chat.turns.forEach((turn, i) => {
    lines.push(`## ${i + 1}. ${turn.question || `Turn ${i + 1}`}`, "");
    lines.push((turn.answerText || "").trim() || "_(no answer captured)_", "", "---", "");
  });

  return lines.join("\n").trimEnd() + "\n";
}

export function chatsToMarkdown(chats: Chat[]): string {
  if (chats.length === 1) return chatToMarkdown(chats[0]!);
  const parts = [`# Gemini Chat Archive`, "", `${chats.length} conversations.`, ""];
  for (const chat of chats) parts.push(chatToMarkdown(chat), "\n\n");
  return parts.join("\n");
}
