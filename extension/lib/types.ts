// Shared data model for scraped Gemini conversations.
// This same shape is exported as JSON by the extension and imported by the web app.

export interface ChatTurn {
  /** Zero-based position of this Q&A pair within the conversation. */
  index: number;
  /**
   * Stable per-turn key, derived from the turn's content (see `turnKey` in
   * scraper.ts). Survives index shifts so the web app can merge incrementally
   * when an older turn surfaces in a later scrape. Optional for backward compat
   * with exports made before this field existed.
   */
  key?: string;
  /** The user's prompt / question. */
  question: string;
  /** Gemini's answer as plain text (used for search + previews). */
  answerText: string;
  /** Gemini's answer as sanitized HTML (used for rich rendering + EPUB). */
  answerHtml: string;
}

export interface Chat {
  /** Stable id derived from the Gemini conversation URL. */
  id: string;
  /** Conversation title (from the page <title>). */
  title: string;
  /** Full URL the chat was scraped from. */
  url: string;
  /** ISO timestamp of when the scrape happened. */
  scrapedAt: string;
  /** The ordered Q&A pairs. */
  turns: ChatTurn[];
}

/** Top-level file format written by the extension and read by the web app. */
export interface GeminiExport {
  format: "gemini-chat-export";
  version: 1;
  exportedAt: string;
  chats: Chat[];
}

export const EXPORT_FORMAT = "gemini-chat-export" as const;
export const EXPORT_VERSION = 1 as const;
