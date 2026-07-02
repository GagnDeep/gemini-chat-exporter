// Best-passage selection — shared by the search result cards and the in-chat
// on-arrival highlight so the two ALWAYS agree on what to surface.
//
// Given a block of text and a query (plus the surface words the ranker actually
// hit), pick the single sentence/window that best represents the match and the
// words to <mark> inside it. Pure + synchronous: no embeddings, no async. When
// no literal/fuzzy query word appears anywhere (a purely semantic hit) it falls
// back to the first substantive sentence and returns that sentence's own salient
// words — so callers always have a visible passage AND markable words, never an
// empty highlight.

import { salientTerms, fuzzyExpand } from "./findHighlight";

export interface Passage {
  /** The chosen sentence/window (trimmed, possibly clamped to maxLen). */
  text: string;
  /** Offset of `text` within the input string. */
  startOffset: number;
  endOffset: number;
  /** Lowercased surface words to highlight inside the passage (always present in it). */
  terms: string[];
  /** True when no literal/fuzzy query word was found (semantic fallback). */
  approximate: boolean;
}

const DEFAULT_MAX_LEN = 260;
const MIN_SENTENCE = 24;
const FALLBACK_TERM_CAP = 4;

export interface PassageOpts {
  /** Surface words the ranker hit (SearchHit.matchedTerms). Preferred seed. */
  salientTerms?: string[];
  /** Expand seed terms to nearby real words in the text (typo tolerance). */
  fuzzy?: boolean;
  /** Max passage length before centering a window on the first matched term. */
  maxLen?: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, word-ish regex over the given terms (longest first). */
function termRegex(terms: string[]): RegExp | null {
  const uniq = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))]
    .sort((a, b) => b.length - a.length);
  if (!uniq.length) return null;
  return new RegExp(uniq.map(escapeRe).join("|"), "gi");
}

/** Distinct lowercased word tokens (≥3 chars) in a text, for fuzzy expansion. */
function uniqueWords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9'+_-]{2,}/g) || [])];
}

interface Sent { text: string; start: number; end: number; }

/** Split into sentences while preserving byte offsets into the original text. */
function splitSentences(text: string): Sent[] {
  const out: Sent[] = [];
  let start = 0;
  const re = /([.!?])[\s)"']+|\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + (m[1] ? 1 : 0); // keep the terminator punctuation
    if (text.slice(start, end).trim()) out.push({ text: text.slice(start, end), start, end });
    start = re.lastIndex;
  }
  if (start < text.length && text.slice(start).trim()) out.push({ text: text.slice(start), start, end: text.length });
  return out;
}

/** Clamp a sentence to maxLen by centering a window on the first matched term. */
function clamp(sent: Sent, terms: string[], maxLen: number): { text: string; startOffset: number } {
  const lead = sent.text.length - sent.text.trimStart().length;
  const trimmed = sent.text.trim();
  let absStart = sent.start + lead;
  if (trimmed.length <= maxLen) return { text: trimmed, startOffset: absStart };
  let center = 0;
  const re = termRegex(terms);
  if (re) { const mm = re.exec(trimmed.toLowerCase()); if (mm) center = mm.index; }
  let ws = Math.max(0, center - Math.floor(maxLen / 2));
  const we = Math.min(trimmed.length, ws + maxLen);
  ws = Math.max(0, we - maxLen);
  return { text: trimmed.slice(ws, we), startOffset: absStart + ws };
}

/**
 * Pick the best passage in `text` for `query`. `opts.salientTerms` should be the
 * ranker's matched surface words when available (more precise than the raw query).
 */
export function bestPassage(text: string, query: string, opts: PassageOpts = {}): Passage {
  const clean = text || "";
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const seed = (opts.salientTerms && opts.salientTerms.length ? opts.salientTerms : salientTerms(query))
    .map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  let terms = [...new Set(seed)];
  if (opts.fuzzy && terms.length) terms = fuzzyExpand(terms, uniqueWords(clean));

  const sents = splitSentences(clean);
  if (!sents.length) {
    const head = clean.trim().slice(0, maxLen);
    return { text: head, startOffset: 0, endOffset: head.length, terms: [], approximate: true };
  }

  const re = termRegex(terms);
  let best: Sent | null = null;
  let bestWords: string[] = [];
  let bestScore = 0;
  if (re) {
    for (const s of sents) {
      re.lastIndex = 0;
      const low = s.text.toLowerCase();
      const words = new Set<string>();
      let hits = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(low))) { hits++; words.add(m[0]); if (m.index === re.lastIndex) re.lastIndex++; }
      if (!hits) continue;
      // Distinct-term coverage dominates raw frequency; longer sentences aren't rewarded.
      const score = words.size * 3 + hits;
      if (score > bestScore) { bestScore = score; best = s; bestWords = [...words]; }
    }
  }

  if (best) {
    const c = clamp(best, bestWords, maxLen);
    return { text: c.text, startOffset: c.startOffset, endOffset: c.startOffset + c.text.length, terms: bestWords, approximate: false };
  }

  // Semantic fallback: no literal/fuzzy word hit anywhere. Surface the first
  // substantive sentence and mark ITS salient words so something is still visible.
  const first = sents.find((s) => s.text.trim().length >= MIN_SENTENCE) || sents[0]!;
  const c = clamp(first, [], maxLen);
  const fallbackTerms = salientTerms(c.text).slice(0, FALLBACK_TERM_CAP);
  return { text: c.text, startOffset: c.startOffset, endOffset: c.startOffset + c.text.length, terms: fallbackTerms, approximate: true };
}

/**
 * The words to <mark> inside a target turn on arrival. Prefers the seed terms
 * that literally appear (fuzzy-expanded); if none do (semantic hit), falls back
 * to the best passage's own salient words — which are guaranteed present. The
 * result is always non-empty when the turn has any content, so the arrival
 * highlight is never blank.
 */
export function passageMarkTerms(turnText: string, seedTerms: string[], query: string): string[] {
  const text = turnText || "";
  const low = text.toLowerCase();
  const seed = [...new Set((seedTerms || []).map((t) => t.toLowerCase()).filter((t) => t.length >= 2))];
  const present = seed.filter((t) => low.includes(t));
  if (present.length) {
    const expanded = fuzzyExpand(present, uniqueWords(text)).filter((t) => low.includes(t));
    return [...new Set(expanded.length ? expanded : present)];
  }
  return bestPassage(text, query, { salientTerms: seed, fuzzy: true }).terms;
}
