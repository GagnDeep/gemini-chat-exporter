// Data model — mirrors the extension's export format so JSON round-trips cleanly.

export interface ChatTurn {
  index: number;
  /**
   * Stable per-turn key derived from the turn's content by the extension.
   * Used by incremental merge to match turns across re-scrapes even when their
   * index shifts. Optional for backward compat with older exports.
   */
  key?: string;
  question: string;
  answerText: string;
  answerHtml: string;
}

export interface Chat {
  id: string;
  title: string;
  url: string;
  scrapedAt: string;
  turns: ChatTurn[];
}

export interface GeminiExport {
  format: "gemini-chat-export";
  version: number;
  exportedAt: string;
  chats: Chat[];
}

/**
 * A flattened, searchable unit: one Q&A turn belonging to a chat.
 * `embedding` is populated lazily once the semantic index is built.
 */
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
  /** Unit-normalized embedding vector, or null until indexed. */
  embedding: number[] | null;
}

export type SearchMode = "keyword" | "fuzzy" | "semantic";

export interface SearchHit {
  segment: Segment;
  /** 0..1, higher is better. */
  score: number;
  /** Short snippet around the match for display. */
  snippet: string;
}
