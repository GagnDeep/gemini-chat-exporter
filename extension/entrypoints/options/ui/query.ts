// Search query parser. Turns a raw input string into structured operators so
// the search layer can filter + rank precisely:
//
//   "exact phrase"      → phrase match (also boosts ranking)
//   -word  -"a phrase"  → exclude
//   chat:title          → only chats whose title contains this (quote for spaces)
//   before:2025-01-31   → chats scraped on/before this date
//   after:2025-01-01    → chats scraped on/after this date
//   has:code            → only turns whose answer has a code block
//   is:pinned           → only pinned chats
//   role:question|answer→ match only the question or only the answer
//
// Everything else is a free term. `text` is the natural-language remainder
// (terms + phrases) used for embeddings + highlighting.

export interface ParsedQuery {
  terms: string[];
  phrases: string[];
  excludeTerms: string[];
  excludePhrases: string[];
  chat?: string;
  before?: number;
  after?: number;
  hasCode?: boolean;
  isPinned?: boolean;
  role?: "question" | "answer";
  /** Natural-language remainder (terms + phrases) for embedding + highlight. */
  text: string;
  /** True when only filters were given (no terms/phrases to rank by). */
  filtersOnly: boolean;
}

/** Split respecting double quotes: `a "b c" -d` → [`a`, `"b c"`, `-d`]. */
function tokenizeRespectingQuotes(input: string): string[] {
  const out: string[] = [];
  const re = /-?(?:[a-z]+:)?"[^"]*"|\S+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[0]);
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, "");
}

function parseDate(v: string): number | undefined {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = {
    terms: [], phrases: [], excludeTerms: [], excludePhrases: [],
    text: "", filtersOnly: false,
  };
  for (const tokRaw of tokenizeRespectingQuotes(input)) {
    let tok = tokRaw;
    const negative = tok.startsWith("-");
    if (negative) tok = tok.slice(1);

    // field:value operators
    const colon = tok.match(/^([a-z]+):(.*)$/i);
    if (colon && !negative) {
      const field = colon[1]!.toLowerCase();
      const value = stripQuotes(colon[2]!);
      if (field === "chat") { q.chat = value.toLowerCase(); continue; }
      if (field === "before") { q.before = parseDate(value); continue; }
      if (field === "after") { q.after = parseDate(value); continue; }
      if (field === "has" && value.toLowerCase() === "code") { q.hasCode = true; continue; }
      if (field === "is" && value.toLowerCase() === "pinned") { q.isPinned = true; continue; }
      if (field === "role" && (value === "question" || value === "answer")) { q.role = value; continue; }
      // unknown operator → treat as a literal term
    }

    const isPhrase = tok.startsWith('"') && tok.endsWith('"') && tok.length > 1;
    const bare = stripQuotes(tok).trim().toLowerCase();
    if (!bare) continue;
    if (negative) {
      if (isPhrase || bare.includes(" ")) q.excludePhrases.push(bare);
      else q.excludeTerms.push(bare);
    } else if (isPhrase || bare.includes(" ")) {
      q.phrases.push(bare);
    } else {
      q.terms.push(bare);
    }
  }

  q.text = [...q.phrases, ...q.terms].join(" ").trim();
  q.filtersOnly = !q.terms.length && !q.phrases.length &&
    (q.chat != null || q.before != null || q.after != null || !!q.hasCode || !!q.isPinned || !!q.role);
  return q;
}

/** All positive ranking terms (phrase words flattened in), de-duplicated. */
export function rankTerms(q: ParsedQuery): string[] {
  const set = new Set<string>();
  for (const t of q.terms) if (t.length >= 2) set.add(t);
  for (const p of q.phrases) for (const w of p.split(/\s+/)) if (w.length >= 2) set.add(w);
  return [...set];
}
