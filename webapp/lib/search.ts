// Three search strategies over the flattened segments:
//   keyword  — exact / word-boundary substring matching (fast, precise)
//   fuzzy    — Fuse.js typo-tolerant matching over question + answer
//   semantic — cosine similarity of query vs. stored embeddings

import Fuse from "fuse.js";
import type { Segment, SearchHit, SearchMode } from "./types";
import { cosineSim, getEmbeddings } from "./embeddings";

const SNIPPET_RADIUS = 90;

function makeSnippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  const q = query.trim().toLowerCase().split(/\s+/)[0] || "";
  const idx = q ? lower.indexOf(q) : -1;
  if (idx === -1) {
    return text.slice(0, SNIPPET_RADIUS * 2).trim() + (text.length > SNIPPET_RADIUS * 2 ? "…" : "");
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + q.length + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/** Keyword search: every whitespace-separated term must appear. */
export function keywordSearch(segments: Segment[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const phrase = terms.length > 1 ? q : null;
  const hits: SearchHit[] = [];
  for (const seg of segments) {
    const hay = seg.text.toLowerCase();
    const qHay = seg.question.toLowerCase();
    let ok = true;
    let score = 0;
    for (const t of terms) {
      const c = hay.split(t).length - 1;
      if (c === 0) { ok = false; break; }
      score += c;
      // Matches in the question itself are more meaningful than deep in an answer.
      if (qHay.includes(t)) score += 2;
    }
    // Exact phrase match is a strong signal.
    if (ok && phrase && hay.includes(phrase)) score += 5;
    if (ok) {
      hits.push({
        segment: seg,
        score: Math.min(1, score / 10),
        snippet: makeSnippet(seg.text, query),
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** Fuzzy search via Fuse.js — tolerant of typos and partial words. */
export function fuzzySearch(segments: Segment[], query: string): SearchHit[] {
  if (!query.trim()) return [];
  const fuse = new Fuse(segments, {
    keys: [
      { name: "question", weight: 0.6 },
      { name: "answerText", weight: 0.4 },
    ],
    includeScore: true,
    threshold: 0.45,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  return fuse.search(query).map((r) => ({
    segment: r.item,
    score: 1 - (r.score ?? 1), // Fuse score: 0 = perfect
    snippet: makeSnippet(r.item.text, query),
  }));
}

/**
 * Semantic search: embed the query in the worker, then rank stored segment
 * embeddings by cosine similarity. Segments without embeddings are skipped.
 */
export async function semanticSearch(
  segments: Segment[],
  query: string,
  topK = 30,
): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const indexed = segments.filter((s) => s.embedding && s.embedding.length);
  if (!indexed.length) return [];

  const qVec = await getEmbeddings().embedQuery(query);
  const scored = indexed.map((seg) => ({
    segment: seg,
    score: cosineSim(qVec, seg.embedding as number[]),
    snippet: makeSnippet(seg.text, query),
  }));
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((h) => h.score > 0.15);
}

export async function runSearch(
  mode: SearchMode,
  segments: Segment[],
  query: string,
): Promise<SearchHit[]> {
  if (mode === "keyword") return keywordSearch(segments, query);
  if (mode === "fuzzy") return fuzzySearch(segments, query);
  return semanticSearch(segments, query);
}

const HL_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "with", "this", "that",
  "from", "they", "have", "will", "your", "what", "when", "which", "how",
  "does", "into", "about", "why", "who", "can", "would", "should",
]);

/** Wrap matched query terms in <mark> for display (keyword/fuzzy). */
export function highlight(text: string, query: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const terms = query.trim().split(/\s+/).filter((t) => t.length >= 2);
  let out = esc(text);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(re, '<mark class="hl">$1</mark>');
  }
  return out;
}

/**
 * Lighter highlight for semantic results: there is no literal match, so we
 * emphasize the meaningful content words of the query where they happen to
 * appear in the snippet.
 */
export function highlightSemantic(text: string, query: string): string {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !HL_STOPWORDS.has(t));
  return terms.length ? highlight(text, terms.join(" ")) : escapeBasic(text);
}

function escapeBasic(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
