// Runs the global search engine (runSearch) scoped to a single chat, so the
// in-chat advanced overlay and quick-find "Meaning" mode get keyword / fuzzy /
// semantic / smart ranking for free. The engine is corpus-agnostic — scoping is
// purely a matter of which segment array (and SearchIndex) we feed it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, SearchMode } from "@/lib/types";
import { segmentsFromChats, hashText } from "./segments";
import { SearchIndex, segmentsSignature } from "./searchIndex";
import { parseQuery } from "./query";
import { runSearch, type SearchContext, type SearchOutcome } from "./search";
import { getAllEmbeddings, type EmbRecord } from "./idb";

export interface ChatSearch {
  /** True once at least one of this chat's turns has a cached vector. */
  vectorsReady: boolean;
  embedded: number;
  total: number;
  /** Run a scoped search; resolves to the ranked outcome (turn-level hits). */
  search: (mode: SearchMode, query: string, onSemanticError?: (m: string) => void) => Promise<SearchOutcome>;
}

const EMPTY = new Set<string>();

export function useChatSearch(chat: Chat | undefined): ChatSearch {
  // Cached vectors (loaded once, shared with ChatView.findSimilar's own copy).
  const [cache, setCache] = useState<Map<string, EmbRecord> | null>(null);
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    getAllEmbeddings().then(setCache).catch(() => setCache(new Map()));
    // Refresh after an (inline or Settings) index build so meaning search works
    // immediately without a reload.
    const onUpdated = () => { getAllEmbeddings().then(setCache).catch(() => {}); };
    window.addEventListener("vectors-updated", onUpdated);
    return () => window.removeEventListener("vectors-updated", onUpdated);
  }, []);

  // Segments for this one chat (memoized on identity + turn count).
  const segments = useMemo(() => (chat ? segmentsFromChats([chat]) : []), [chat?.id, chat?.turns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lexical index — rebuilt only when the segment set changes.
  const sig = segmentsSignature(segments);
  const index = useMemo(() => new SearchIndex(segments), [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach cached vectors where the content hash still matches.
  const vectorSegments = useMemo(() => {
    if (!cache || !cache.size) return segments;
    return segments.map((s) => {
      const rec = cache.get(s.id);
      return rec && rec.hash === hashText(s.text) ? { ...s, embedding: rec.vec } : s;
    });
  }, [segments, cache]);

  const embedded = useMemo(() => vectorSegments.filter((s) => s.embedding && s.embedding.length).length, [vectorSegments]);
  const total = segments.length;

  const search = useCallback(
    async (mode: SearchMode, query: string, onSemanticError?: (m: string) => void): Promise<SearchOutcome> => {
      const q = parseQuery(query);
      const ctx: SearchContext = {
        index,
        vectorSegments,
        pinnedIds: EMPTY,
        hasVectors: (mode === "hybrid" || mode === "semantic") && embedded > 0,
        onSemanticError,
      };
      return runSearch(mode, q, ctx);
    },
    [index, vectorSegments, embedded],
  );

  return { vectorsReady: embedded > 0, embedded, total, search };
}
