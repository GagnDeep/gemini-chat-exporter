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

// ---------------------------------------------------------------------------
// Background scrape jobs
//
// A scrape job is a *persisted* record of an in-flight (or finished) capture.
// It lives in browser.storage.local so it survives the popup closing and the
// service worker being evicted — the content script that owns the capture writes
// progress and the final result straight to storage, and every UI surface
// (popup, archive page) renders from that single source of truth.
// ---------------------------------------------------------------------------

export type ScrapeJobStatus =
  | "scraping" // actively capturing
  | "done" // finished, chat committed to the collection
  | "error" // failed
  | "canceled"; // user stopped, or tab/navigation interrupted it

export interface ScrapeJob {
  /** Unique job id. */
  id: string;
  /** Gemini conversation id (matches Chat.id) once known. */
  chatId: string;
  /** Best-known title for display. */
  title: string;
  /** URL the capture is running against. */
  url: string;
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
}
