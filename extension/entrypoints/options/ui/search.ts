// Search ranking over the prebuilt SearchIndex.
//
//   smart    — weighted Reciprocal Rank Fusion of BM25 + semantic (or fuzzy),
//              with exact-phrase, recency boosts, facet filters and per-chat
//              relevance. The default.
//   keyword  — BM25 lexical only.
//   fuzzy    — typo-tolerant Fuse.js.
//   semantic — cosine similarity of query vs. stored embeddings.
//
// All heavy corpus work lives in SearchIndex (built once); this module only
// ranks + fuses, so typing stays smooth on large archives.

import type { Segment, SearchHit, SearchMode } from "@/lib/types";
import { cosineSim, getEmbeddings } from "./embeddings";
import { SearchIndex, type RankedSeg } from "./searchIndex";
import { rankTerms, type ParsedQuery } from "./query";

const SNIPPET_RADIUS = 120;

export interface SearchContext {
  index: SearchIndex;
  /** Segments with embeddings attached, for the semantic pass. */
  vectorSegments: Segment[];
  pinnedIds: Set<string>;
  hasVectors: boolean;
  onSemanticError?: (message: string) => void;
}

export interface SearchOutcome {
  hits: SearchHit[];
  rankedBy: "smart" | "keyword" | "fuzzy" | "semantic";
  /** Whether the semantic vector pass actually contributed. */
  semanticUsed: boolean;
}

// ---------------------------------------------------------------------------
// Snippets — center on the best matched span, expand to sentence boundaries.
// ---------------------------------------------------------------------------

function makeSnippet(text: string, queryText: string): string {
  const terms = queryText.trim().toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const lower = text.toLowerCase();
  let best = -1;
  let bestLen = 0;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (best === -1 || i < best)) { best = i; bestLen = term.length; }
  }
  if (best === -1) {
    const head = text.slice(0, SNIPPET_RADIUS * 2).trim();
    return head + (text.length > head.length ? "…" : "");
  }
  let start = Math.max(0, best - SNIPPET_RADIUS);
  let end = Math.min(text.length, best + bestLen + SNIPPET_RADIUS);
  // Expand to the nearest sentence boundaries for readable context.
  const sentStart = text.lastIndexOf(". ", best);
  if (sentStart !== -1 && best - sentStart < SNIPPET_RADIUS * 1.5) start = sentStart + 2;
  const sentEnd = text.indexOf(". ", end);
  if (sentEnd !== -1 && sentEnd - end < SNIPPET_RADIUS) end = sentEnd + 1;
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

// ---------------------------------------------------------------------------
// Facets + boosts
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function passesFacets(seg: Segment, q: ParsedQuery, pinnedIds: Set<string>): boolean {
  if (q.chat && !seg.chatTitle.toLowerCase().includes(q.chat)) return false;
  if (q.hasCode && !seg.hasCode) return false;
  if (q.isPinned && !pinnedIds.has(seg.chatId)) return false;
  const t = Date.parse(seg.scrapedAt);
  if (q.before != null && Number.isFinite(t) && t > q.before + DAY - 1) return false;
  if (q.after != null && Number.isFinite(t) && t < q.after) return false;
  const hay = seg.text.toLowerCase();
  for (const w of q.excludeTerms) if (hay.includes(w)) return false;
  for (const p of q.excludePhrases) if (hay.includes(p)) return false;
  return true;
}

/** 1.0 for today, decaying to ~0 over ~180 days. */
function recencyScore(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const ageDays = (Date.now() - t) / DAY;
  return Math.max(0, 1 - ageDays / 180);
}

function roleText(seg: Segment, role?: "question" | "answer"): string {
  if (role === "question") return seg.question;
  if (role === "answer") return seg.answerText;
  return seg.text;
}

function fieldHasTerm(seg: Segment, role: "question" | "answer", terms: string[]): boolean {
  const hay = (role === "question" ? seg.question : seg.answerText).toLowerCase();
  return terms.some((t) => hay.includes(t));
}

// ---------------------------------------------------------------------------
// Semantic pass
// ---------------------------------------------------------------------------

async function semanticRanked(vectorSegments: Segment[], queryText: string, topK: number): Promise<RankedSeg[]> {
  if (!queryText.trim()) return [];
  const indexed = vectorSegments.filter((s) => s.embedding && s.embedding.length);
  if (!indexed.length) return [];
  const qVec = await getEmbeddings().embedQuery(queryText);
  return indexed
    .map((seg) => ({ segment: seg, score: cosineSim(qVec, seg.embedding as number[]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((h) => h.score > 0.15);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runSearch(mode: SearchMode, q: ParsedQuery, ctx: SearchContext): Promise<SearchOutcome> {
  const terms = rankTerms(q);
  const candidateIds = new Set(ctx.index.segments.filter((s) => passesFacets(s, q, ctx.pinnedIds)).map((s) => s.id));
  const keep = (r: RankedSeg) => candidateIds.has(r.segment.id) && (!q.role || fieldHasTerm(r.segment, q.role, terms));

  // Filters-only query (e.g. `is:pinned has:code`) → list candidates by recency.
  if (q.filtersOnly) {
    const hits = ctx.index.segments
      .filter((s) => candidateIds.has(s.id))
      .sort((a, b) => (b.scrapedAt || "").localeCompare(a.scrapedAt || ""))
      .slice(0, 120)
      .map((seg) => ({ segment: seg, score: 1, snippet: makeSnippet(roleText(seg, q.role), q.text) }));
    return { hits, rankedBy: "keyword", semanticUsed: false };
  }

  const toHits = (list: RankedSeg[]): SearchHit[] => {
    const max = Math.max(...list.map((r) => r.score), 1e-9);
    return list.map((r) => ({ segment: r.segment, score: r.score / max, snippet: makeSnippet(roleText(r.segment, q.role), q.text) }));
  };

  if (mode === "keyword") {
    return { hits: toHits(ctx.index.bm25(terms, 160).filter(keep)).slice(0, 120), rankedBy: "keyword", semanticUsed: false };
  }
  if (mode === "fuzzy") {
    return { hits: toHits(ctx.index.fuzzy(q.text, 160).filter(keep)).slice(0, 120), rankedBy: "fuzzy", semanticUsed: false };
  }
  if (mode === "semantic") {
    try {
      const sem = (await semanticRanked(ctx.vectorSegments, q.text, 160)).filter(keep);
      return { hits: toHits(sem).slice(0, 120), rankedBy: "semantic", semanticUsed: sem.length > 0 };
    } catch (e) {
      ctx.onSemanticError?.(e instanceof Error ? e.message : String(e));
      return { hits: [], rankedBy: "semantic", semanticUsed: false };
    }
  }

  // ---- smart / hybrid: weighted RRF -------------------------------------
  const K = 60;
  const lexical = ctx.index.bm25(terms, 160).filter(keep);
  let semantic: RankedSeg[] = [];
  let semanticUsed = false;
  if (ctx.hasVectors && q.text.trim()) {
    try {
      semantic = (await semanticRanked(ctx.vectorSegments, q.text, 160)).filter(keep);
      semanticUsed = true;
    } catch (e) {
      ctx.onSemanticError?.(e instanceof Error ? e.message : String(e));
    }
  }
  const secondary = semanticUsed ? semantic : ctx.index.fuzzy(q.text, 160).filter(keep);

  const fused = new Map<string, { seg: Segment; score: number }>();
  const add = (list: RankedSeg[], weight: number) => {
    list.forEach((r, rank) => {
      const contrib = weight * (1 / (K + rank + 1));
      const cur = fused.get(r.segment.id);
      if (cur) cur.score += contrib;
      else fused.set(r.segment.id, { seg: r.segment, score: contrib });
    });
  };
  add(lexical, 1.0);
  add(secondary, semanticUsed ? 1.0 : 0.6);

  // Exact-phrase + recency boosts.
  for (const v of fused.values()) {
    if (q.phrases.length) {
      const hay = v.seg.text.toLowerCase();
      for (const p of q.phrases) if (hay.includes(p)) v.score *= 1.6;
    }
    v.score *= 1 + 0.25 * recencyScore(v.seg.scrapedAt);
  }

  const ranked: RankedSeg[] = [...fused.values()].map((v) => ({ segment: v.seg, score: v.score }))
    .sort((a, b) => b.score - a.score).slice(0, 120);
  return { hits: toHits(ranked), rankedBy: "smart", semanticUsed };
}

// ---------------------------------------------------------------------------
// Highlighting + grouping (unchanged API, used by the results UI)
// ---------------------------------------------------------------------------

const HL_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "with", "this", "that",
  "from", "they", "have", "will", "your", "what", "when", "which", "how",
  "does", "into", "about", "why", "who", "can", "would", "should",
]);

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

export function highlight(text: string, queryText: string): string {
  const terms = queryText.trim().split(/\s+/).filter((t) => t.length >= 2);
  let out = esc(text);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(re, '<mark class="hl">$1</mark>');
  }
  return out;
}

export function highlightSemantic(text: string, queryText: string): string {
  const terms = queryText.trim().toLowerCase().split(/\s+/).filter((t) => t.length >= 4 && !HL_STOPWORDS.has(t));
  return terms.length ? highlight(text, terms.join(" ")) : esc(text);
}

export interface ResultGroup {
  chatId: string;
  chatTitle: string;
  scrapedAt: string;
  score: number;
  hits: SearchHit[];
}

export function groupByChat(hits: SearchHit[]): ResultGroup[] {
  const groups = new Map<string, ResultGroup>();
  for (const h of hits) {
    const g = groups.get(h.segment.chatId);
    if (g) {
      g.hits.push(h);
      if (h.score > g.score) g.score = h.score;
    } else {
      groups.set(h.segment.chatId, {
        chatId: h.segment.chatId,
        chatTitle: h.segment.chatTitle,
        scrapedAt: h.segment.scrapedAt,
        score: h.score,
        hits: [h],
      });
    }
  }
  const out = [...groups.values()];
  out.forEach((g) => g.hits.sort((a, b) => b.score - a.score));
  return out.sort((a, b) => b.score - a.score);
}
