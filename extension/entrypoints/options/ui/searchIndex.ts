// Incremental, memoized lexical index. The expensive corpus work — per-segment
// tokenization, document frequencies, average length, and the Fuse instance —
// is done ONCE when the segment set changes, not on every keystroke. BM25
// scoring then only counts query terms against the precomputed token arrays.

import Fuse from "fuse.js";
import type { Segment } from "@/lib/types";

const TOKEN_RE = /[a-z0-9]+/g;
export function tokenize(s: string): string[] {
  return s.toLowerCase().match(TOKEN_RE) || [];
}

export interface RankedSeg {
  segment: Segment;
  score: number;
}

export class SearchIndex {
  readonly segments: Segment[];
  private docTokens: string[][];
  private docTokenSets: Set<string>[];
  private df = new Map<string, number>();
  private avgdl = 1;
  private fuse: Fuse<Segment>;

  constructor(segments: Segment[]) {
    this.segments = segments;
    this.docTokens = new Array(segments.length);
    this.docTokenSets = new Array(segments.length);
    let total = 0;
    for (let i = 0; i < segments.length; i++) {
      const toks = tokenize(`${segments[i]!.chatTitle} ${segments[i]!.text}`);
      this.docTokens[i] = toks;
      const set = new Set(toks);
      this.docTokenSets[i] = set;
      total += toks.length;
      for (const t of set) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgdl = total / (segments.length || 1) || 1;
    this.fuse = new Fuse(segments, {
      keys: [
        { name: "chatTitle", weight: 0.4 },
        { name: "question", weight: 0.4 },
        { name: "answerText", weight: 0.2 },
      ],
      includeScore: true,
      threshold: 0.42,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }

  /** BM25 over the precomputed corpus. `terms` are lowercased query tokens. */
  bm25(terms: string[], topK = 80): RankedSeg[] {
    const qTerms = [...new Set(terms)].filter((t) => t.length >= 1);
    if (!qTerms.length) return [];
    const N = this.segments.length || 1;
    const k1 = 1.5;
    const b = 0.75;
    const idf = new Map<string, number>();
    for (const t of qTerms) {
      const n = this.df.get(t) || 0;
      idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }

    const out: RankedSeg[] = [];
    for (let i = 0; i < this.segments.length; i++) {
      const d = this.docTokens[i]!;
      if (!d.length) continue;
      // term frequencies for just the query terms
      let score = 0;
      let matched = 0;
      for (const t of qTerms) {
        if (!this.docTokenSets[i]!.has(t)) continue;
        let f = 0;
        for (const w of d) if (w === t) f++;
        if (!f) continue;
        matched++;
        const denom = f + k1 * (1 - b + (b * d.length) / this.avgdl);
        score += (idf.get(t) || 0) * ((f * (k1 + 1)) / denom);
      }
      if (!matched) continue;
      out.push({ segment: this.segments[i]!, score });
    }
    return out.sort((a, b2) => b2.score - a.score).slice(0, topK);
  }

  fuzzy(query: string, topK = 80): RankedSeg[] {
    if (!query.trim()) return [];
    return this.fuse.search(query).slice(0, topK).map((r) => ({
      segment: r.item,
      score: 1 - (r.score ?? 1),
    }));
  }
}

/** Stable signature so a memo can rebuild only when the segment set changes
 *  (not when embeddings are attached, which clones the array). */
export function segmentsSignature(segments: Segment[]): string {
  const n = segments.length;
  if (!n) return "0";
  return `${n}:${segments[0]!.id}:${segments[n - 1]!.id}`;
}
