// Shared data model for scraped conversations.
// This same shape is exported as JSON by the extension and imported by the web app.

import type { ProviderId } from "./providers";

export interface ChatTurn {
  /** Zero-based position of this Q&A pair within the conversation. */
  index: number;
  /**
   * Stable per-turn key, derived from the turn's content (see scraper.ts).
   * Survives index shifts so merges stay anchored. Optional for backward compat.
   */
  key?: string;
  /** The user's prompt / question. */
  question: string;
  /** The model's answer as plain text (used for search + previews). */
  answerText: string;
  /** The model's answer as sanitized HTML (used for rich rendering + EPUB). */
  answerHtml: string;
}

export interface Chat {
  /** Stable id derived from the conversation URL (namespaced by source). */
  id: string;
  /** Conversation title (from the page <title>). */
  title: string;
  /** Full URL the chat was scraped from. */
  url: string;
  /**
   * Which AI product this chat came from ("gemini" | "claude" | "chatgpt").
   * Optional for backward compat with archives captured before multi-provider
   * support (those are Gemini by definition).
   */
  source?: ProviderId;
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

// ---------------------------------------------------------------------------
// Background scrape jobs
// ---------------------------------------------------------------------------

export type ScrapeJobStatus = "scraping" | "done" | "error" | "canceled";

export interface ScrapeJob {
  /** Unique job id. */
  id: string;
  /** Conversation id (matches Chat.id) once known. */
  chatId: string;
  /** Best-known title for display. */
  title: string;
  /** URL the capture is running against. */
  url: string;
  /** Which product this capture belongs to. */
  source?: ProviderId;
  /** Tab the capture is running in (best-effort; tabs can close). */
  tabId?: number;
  status: ScrapeJobStatus;
  /** Turns captured so far. */
  turns: number;
  /** Whether the scroller has reached the top of the conversation. */
  atTop: boolean;
  /** Whether older turns are currently streaming in from the server. */
  loading: boolean;
  /** Scroll iteration count (rough progress signal). */
  iteration: number;
  error?: string;
  startedAt: string;
  /** ISO timestamp of the last progress write — used to detect stalls. */
  updatedAt: string;
  /** Set when the job reaches a terminal state. */
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Search model (used by the in-extension archive page)
// ---------------------------------------------------------------------------

/** A flattened, searchable unit: one Q&A turn belonging to a chat. */
export interface Segment {
  /** `${chatId}#${turnIndex}` */
  id: string;
  chatId: string;
  chatTitle: string;
  /** Source product of the owning chat (for badges + filtering). */
  source?: ProviderId;
  turnIndex: number;
  question: string;
  answerText: string;
  /** question + answer, used for fuzzy/keyword search and embedding. */
  text: string;
  /** ISO timestamp of the owning chat (for recency sorting). */
  scrapedAt: string;
  /** True when the answer contains a code block (for the `has:code` filter). */
  hasCode: boolean;
  /** Unit-normalized embedding vector, or null until indexed. */
  embedding: number[] | null;
}

export type SearchMode = "hybrid" | "keyword" | "fuzzy" | "semantic";

export interface SearchHit {
  segment: Segment;
  /** 0..1, higher is better. */
  score: number;
  /** Short snippet around the match for display. */
  snippet: string;
  /** Surface words the ranker actually hit (drives arrival highlighting). */
  matchedTerms?: string[];
  /** Which field the strongest match landed in, when known. */
  field?: "question" | "answer";
}
