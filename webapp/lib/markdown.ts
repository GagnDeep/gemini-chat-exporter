// Plain Markdown export of chats — a portable companion to the EPUB output.
// Answers are exported as their plain-text form (already captured at scrape
// time), which keeps the Markdown clean and diff-friendly.

import type { Chat } from "./types";
import { chatWordCount, readingTime } from "./text-stats";

function chatToMarkdown(chat: Chat): string {
  const lines: string[] = [];
  const words = chatWordCount(chat);
  lines.push(`# ${chat.title}`);
  lines.push("");
  lines.push(
    `> ${chat.turns.length} Q&A · ~${words.toLocaleString()} words · ${readingTime(words)} · scraped ${chat.scrapedAt.slice(0, 10)}`,
  );
  if (chat.url) lines.push(`>`, `> [Original conversation](${chat.url})`);
  lines.push("");

  chat.turns.forEach((turn, i) => {
    lines.push(`## ${i + 1}. ${turn.question || `Turn ${i + 1}`}`);
    lines.push("");
    const answer = (turn.answerText || "").trim() || "_(no answer captured)_";
    lines.push(answer);
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n").trimEnd() + "\n";
}

export function chatsToMarkdown(chats: Chat[]): string {
  if (chats.length === 1) return chatToMarkdown(chats[0]!);
  const parts = [`# Gemini Chat Archive`, "", `${chats.length} conversations.`, ""];
  for (const chat of chats) {
    parts.push(chatToMarkdown(chat));
    parts.push("\n\n");
  }
  return parts.join("\n");
}
