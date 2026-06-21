// Parse uploaded JSON exports and produce JSON for re-export.

import type { Chat, GeminiExport } from "./types";

export class ImportError extends Error {}

/**
 * Coerce an arbitrary value (parsed JSON, an extension-bridge payload, …) into
 * a clean array of valid chats. Accepts either a bare array of chats or the
 * wrapped export envelope. Returns `[]` rather than throwing so callers decide
 * how to treat an empty result.
 */
export function normalizeChats(data: unknown): Chat[] {
  const chats: unknown = Array.isArray(data) ? data : (data as GeminiExport)?.chats;
  if (!Array.isArray(chats)) return [];

  const valid: Chat[] = [];
  for (const c of chats as Chat[]) {
    if (c && typeof c.id === "string" && Array.isArray(c.turns)) {
      valid.push({
        id: c.id,
        title: c.title || "Untitled chat",
        url: c.url || "",
        scrapedAt: c.scrapedAt || new Date().toISOString(),
        turns: c.turns.map((t, i) => ({
          index: typeof t.index === "number" ? t.index : i,
          key: typeof t.key === "string" ? t.key : undefined,
          question: t.question || "",
          answerText: t.answerText || "",
          answerHtml: t.answerHtml || "",
        })),
      });
    }
  }
  return valid;
}

/** Validate and normalize an uploaded export file's text into chats. */
export function parseExport(text: string): Chat[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError("That file isn't valid JSON.");
  }

  // Distinguish "not our format" from "valid format, no usable chats".
  const top: unknown = Array.isArray(data) ? data : (data as GeminiExport)?.chats;
  if (!Array.isArray(top)) {
    throw new ImportError(
      "Unrecognized format. Expected a Gemini Chat Exporter JSON file.",
    );
  }

  const valid = normalizeChats(data);
  if (!valid.length) throw new ImportError("No valid chats found in that file.");
  return valid;
}

export function chatsToJson(chats: Chat[]): string {
  const payload: GeminiExport = {
    format: "gemini-chat-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    chats,
  };
  return JSON.stringify(payload, null, 2);
}
