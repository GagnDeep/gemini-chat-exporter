// Pure, render-time highlighting for in-chat find.
//
// The old approach (find.ts) mutated the live DOM that React owns via
// dangerouslySetInnerHTML — which left stale <mark> refs after re-renders and
// could crash React with `normalize()`. Instead we compute highlighted HTML
// *strings* here (memoized) and hand them to React to render. Every match gets a
// stable `data-fi="<index>"` so the view can scroll to it without holding node
// refs. Marks are injected only inside text nodes, so HTML tags stay intact.

export interface FindMatch {
  /** Global match index in document order — also the value of the mark's data-fi. */
  index: number;
  turnIndex: number;
  field: "question" | "answer";
  /** Surrounding text for the results panel. */
  before: string;
  match: string;
  after: string;
}

/** Per-match counter threaded across turns so indices are globally sequential. */
export interface FindCounter {
  n: number;
}

const CONTEXT_CHARS = 100;

const FIND_TERM_CAP = 8;

export function findTerms(query: string): string[] {
  const all = [...new Set(query.trim().toLowerCase().split(/\s+/).filter((t) => t.length >= 2))];
  if (all.length <= FIND_TERM_CAP) return all;
  // Long query: marking every word everywhere is noisy — keep only the salient
  // (non-stopword) words, longest first, capped, so highlighting stays legible.
  const salient = all.filter((t) => !FIND_STOPWORDS.has(t)).sort((a, b) => b.length - a.length).slice(0, FIND_TERM_CAP);
  return salient.length ? salient : all.slice(0, FIND_TERM_CAP);
}

// --- Fuzzy (typo-tolerant) term expansion ---------------------------------
// To keep inline <mark> highlighting working, fuzzy find never marks "virtual"
// matches — it expands each typed term to the set of *real* words present in the
// chat that are within a small edit distance (or share a prefix), then feeds
// those surface words through the same literal highlight pipeline.

const FIND_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "with", "this", "that",
  "from", "they", "have", "will", "your", "what", "when", "which", "how",
  "does", "into", "about", "why", "who", "can", "would", "should", "was",
  "were", "has", "had", "its", "their", "there", "then", "than",
]);

/** Distinct lowercased word tokens (≥3 chars) across questions + answers. */
export function buildVocabulary(turns: { question?: string; answerText?: string }[]): string[] {
  const set = new Set<string>();
  for (const t of turns) {
    const text = `${t.question || ""} ${t.answerText || ""}`.toLowerCase();
    const words = text.match(/[a-z0-9][a-z0-9'+_-]{2,}/g);
    if (words) for (const w of words) set.add(w);
  }
  return [...set];
}

/** Bounded Levenshtein: returns a distance capped at `max + 1`. */
function editDistance(a: string, b: string, max: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1; // whole row exceeds budget → early out
    [prev, cur] = [cur, prev];
  }
  return prev[bl];
}

/**
 * Expand literal terms to nearby real words from the vocabulary. Each term keeps
 * itself plus up to a few close vocab words (edit distance ≤1 for short terms,
 * ≤2 for longer, or a shared 4+ char prefix). Capped so highlighting stays fast.
 */
export function fuzzyExpand(terms: string[], vocab: string[]): string[] {
  const out = new Set<string>();
  for (const term of terms) {
    out.add(term);
    if (term.length < 3) continue;
    const budget = term.length <= 4 ? 1 : 2;
    const cands: { w: string; d: number }[] = [];
    for (const w of vocab) {
      if (w === term) continue;
      if (Math.abs(w.length - term.length) > budget && !w.startsWith(term.slice(0, 4))) continue;
      const d = editDistance(term, w, budget);
      if (d <= budget) cands.push({ w, d });
      else if (term.length >= 4 && w.startsWith(term.slice(0, 4)) && w.length - term.length <= 3) cands.push({ w, d: budget });
    }
    cands.sort((x, y) => x.d - y.d || x.w.length - y.w.length);
    for (const c of cands.slice(0, 8)) out.add(c.w);
  }
  return [...out];
}

/** Content-bearing query words (≥4 chars, non-stopword) for meaning-mode marks. */
export function salientTerms(query: string): string[] {
  return [...new Set(
    query.toLowerCase().match(/[a-z0-9][a-z0-9'+_-]{3,}/g) || [],
  )].filter((w) => !FIND_STOPWORDS.has(w));
}

function termRegex(terms: string[]): RegExp {
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(pattern, "gi");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function isInCode(node: Node): boolean {
  let el = node.parentElement;
  while (el) {
    const tag = el.tagName;
    if (tag === "PRE" || tag === "CODE") return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Highlight matches inside a block of sanitized answer HTML, returning a new HTML
 * string and pushing each match (with context) into `out`. Only text nodes are
 * touched; tags/attributes are preserved. Code blocks are skipped unless
 * `includeCode` is set.
 */
export function highlightAnswerHtml(
  html: string,
  terms: string[],
  turnIndex: number,
  counter: FindCounter,
  out: FindMatch[],
  includeCode = false,
): string {
  if (!terms.length) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const re = termRegex(terms);
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (!includeCode && isInCode(n)) continue;
    textNodes.push(n as Text);
  }
  for (const tn of textNodes) {
    const text = tn.nodeValue || "";
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const mark = doc.createElement("mark");
      mark.className = "find-hit";
      mark.setAttribute("data-fi", String(counter.n));
      mark.textContent = m[0];
      frag.appendChild(mark);
      out.push({
        index: counter.n,
        turnIndex,
        field: "answer",
        before: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
        match: m[0],
        after: text.slice(end, end + CONTEXT_CHARS),
      });
      counter.n++;
      last = end;
      if (m.index === re.lastIndex) re.lastIndex++; // zero-length guard
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    tn.parentNode?.replaceChild(frag, tn);
  }
  return doc.body.innerHTML;
}

/**
 * Highlight matches in a plain-text block (question, or answer with no HTML),
 * returning an HTML-escaped string with <mark> wrappers. Safe to render via
 * dangerouslySetInnerHTML because every literal is escaped first.
 */
export function highlightPlain(
  text: string,
  terms: string[],
  turnIndex: number,
  field: FindMatch["field"],
  counter: FindCounter,
  out: FindMatch[],
): string {
  if (!terms.length) return escapeHtml(text);
  const re = termRegex(terms);
  let html = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > last) html += escapeHtml(text.slice(last, start));
    html += `<mark class="find-hit" data-fi="${counter.n}">${escapeHtml(m[0])}</mark>`;
    out.push({
      index: counter.n,
      turnIndex,
      field,
      before: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
      match: m[0],
      after: text.slice(end, end + CONTEXT_CHARS),
    });
    counter.n++;
    last = end;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  html += escapeHtml(text.slice(last));
  return html;
}
