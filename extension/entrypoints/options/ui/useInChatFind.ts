// Derives in-chat find state from chat *content* (not live DOM nodes), so it
// stays correct across React re-renders and chat navigation. Returns the flat
// match list (with context) plus per-turn highlighted HTML for rendering.

import { useMemo } from "react";
import type { Chat } from "@/lib/types";
import {
  findTerms,
  buildVocabulary,
  fuzzyExpand,
  highlightAnswerHtml,
  highlightPlain,
  type FindCounter,
  type FindMatch,
} from "./findHighlight";

/** Quick-find matching strategy. "meaning" is handled outside this hook
 *  (semantic ranking lives in useChatSearch); here it behaves like exact. */
export type FindMode = "exact" | "fuzzy" | "meaning";

export interface TurnHighlight {
  /** Highlighted, HTML-escaped question (or undefined if no matches/question). */
  questionHtml?: string;
  /** Highlighted answer HTML (sanitized) or escaped plain text. */
  answerHtml?: string;
  /** True when answerHtml is escaped plain text (render with pre-wrap). */
  answerIsPlain?: boolean;
}

export interface InChatFind {
  active: boolean;
  matches: FindMatch[];
  /** turn.index → highlighted HTML for that turn (only turns with matches present). */
  perTurn: Map<number, TurnHighlight>;
}

export function useInChatFind(
  chat: Chat | undefined,
  query: string,
  includeCode: boolean,
  /** Pre-enriched (sanitized + syntax/math) answer HTML per turn index. */
  answerHtmlByTurn: Map<number, string>,
  /** Matching strategy. "fuzzy" expands terms to nearby real words; "meaning"
   *  (and any non-fuzzy value) behaves like exact for inline marks. */
  mode: FindMode = "exact",
): InChatFind {
  // Per-chat vocabulary, only built when fuzzy mode is actually in use.
  const vocab = useMemo(
    () => (mode === "fuzzy" && chat ? buildVocabulary(chat.turns) : []),
    [mode, chat?.id, chat?.turns.length], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return useMemo(() => {
    const base = findTerms(query);
    const terms = mode === "fuzzy" && base.length ? fuzzyExpand(base, vocab) : base;
    const matches: FindMatch[] = [];
    const perTurn = new Map<number, TurnHighlight>();
    if (!chat || !terms.length) return { active: false, matches, perTurn };

    const counter: FindCounter = { n: 0 };
    for (const t of chat.turns) {
      const entry: TurnHighlight = {};
      let touched = false;
      if (t.question) {
        const before = counter.n;
        const html = highlightPlain(t.question, terms, t.index, "question", counter, matches);
        if (counter.n > before) { entry.questionHtml = html; touched = true; }
      }
      const baseHtml = answerHtmlByTurn.get(t.index);
      if (baseHtml) {
        const before = counter.n;
        const html = highlightAnswerHtml(baseHtml, terms, t.index, counter, matches, includeCode);
        if (counter.n > before) { entry.answerHtml = html; touched = true; }
      } else if (t.answerText) {
        const before = counter.n;
        const html = highlightPlain(t.answerText, terms, t.index, "answer", counter, matches);
        if (counter.n > before) { entry.answerHtml = html; entry.answerIsPlain = true; touched = true; }
      }
      if (touched) perTurn.set(t.index, entry);
    }
    return { active: true, matches, perTurn };
  }, [chat?.id, query, includeCode, chat?.turns.length, answerHtmlByTurn, mode, vocab]);
}
