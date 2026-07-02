// Per-chat and whole-archive insight extractors.
//
// These are PURE functions of Chat[] — links, named entities, topics, code, and
// stats are all *derived*, never separately stored. The archive page calls them
// from a memo over the reactive chat store, so every view stays realtime: a new
// capture or a delete updates the chats, the memo recomputes, the UI re-renders.
// No second source of truth, no manual refresh.

import nlp from "compromise";
import type { Chat, ChatTurn } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface LinkItem {
  url: string;
  domain: string;
  /** Anchor/link text (or the URL when bare). */
  text: string;
  /** Sentence/snippet the link appeared in. */
  context: string;
  chatId: string;
  chatTitle: string;
  turnIndex: number;
}

export interface DomainGroup {
  domain: string;
  count: number;
  items: LinkItem[];
}

export type EntityKind = "person" | "org" | "place" | "name";

export interface Entity {
  name: string;
  count: number;
  /** chatIds the entity appears in (for global browse → filter). */
  chatIds: string[];
  kind?: EntityKind;
}

export interface Topic {
  term: string;
  weight: number;
}

export interface CodeBlock {
  lang: string;
  code: string;
  chatId: string;
  chatTitle: string;
  turnIndex: number;
}

export interface ChatStats {
  turns: number;
  words: number;
  /** Rough token estimate (~0.75 words/token → words/0.75). */
  tokens: number;
  readingMinutes: number;
  date: string;
  longestAnswerWords: number;
}

export interface ChatInsights {
  links: DomainGroup[];
  entities: Entity[];
  topics: Topic[];
  emails: string[];
  code: CodeBlock[];
  stats: ChatStats;
}

export interface ArchiveInsights {
  links: DomainGroup[];
  entities: Entity[];
  topics: Topic[];
  emails: { value: string; count: number }[];
  totalChats: number;
  totalTurns: number;
  totalWords: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the","and","for","are","but","not","you","with","this","that","from","they",
  "have","will","your","what","when","which","how","does","into","about","why",
  "who","can","would","should","could","its","it's","there","their","them","then",
  "than","also","such","some","any","all","may","might","must","each","more","most",
  "other","over","under","been","being","was","were","has","had","did","done","get",
  "got","out","off","via","per","use","used","using","one","two","let","like","just",
  "here","very","much","many","make","made","want","need","know","see","way","new",
  "now","etc","yes","no","ok","okay","i'm","i'll","we'll","don't","doesn't","isn't",
  "a","an","of","to","in","on","is","it","as","at","by","be","or","if","so","do","up",
  "he","she","we","my","me","us","am","i",
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const WORD_RE = /[a-zA-Z0-9][a-zA-Z0-9'’+-]*/g;

/** Cheap stable content hash (FNV-1a → base36). Local so lib/ stays standalone. */
function hashText(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Strip HTML to plain text using the DOM (available in extension page/content contexts). */
function htmlToText(html: string): string {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent || "";
  } catch {
    return html.replace(/<[^>]+>/g, " ");
  }
}

/** Plain answer text with code blocks removed (so NER/topics never see code). */
function proseFromHtml(html: string): string {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("pre, code").forEach((el) => el.remove());
    return doc.body.textContent || "";
  } catch {
    return html.replace(/<(pre|code)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  }
}

/** Full turn text (question + whole answer, incl. code) — for word counts. */
function turnText(t: ChatTurn): string {
  const answer = t.answerText || htmlToText(t.answerHtml);
  return `${t.question || ""}\n${answer}`;
}

/** Prose-only turn text for NER/topics/emails: code blocks removed, and URLs +
 *  emails stripped so identifiers, links and addresses can't pollute the NER. */
function proseTurnText(t: ChatTurn): string {
  const answer = t.answerHtml ? proseFromHtml(t.answerHtml) : (t.answerText || "");
  const text = `${t.question || ""}\n${answer}`;
  return text.replace(URL_RE, " ").replace(EMAIL_RE, " ");
}

// --- Entity normalization / canonicalization ------------------------------
// Fold possessives, whitespace variants and simple plurals so counts stop
// fragmenting, while keeping a human display form separate from the merge key.

function singularize(w: string): string {
  if (w.length > 4 && /[^s]s$/.test(w) && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Cleaned display form of a raw entity string. */
function entityDisplay(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").replace(/[’']s\b/gi, "").replace(/^[.,;:'"’-]+|[.,;:'"’-]+$/g, "").trim();
}

/** Canonical merge key: lowercased, possessive/punct-stripped, last word
 *  singularized, internal spaces squashed (so "Open AI" ≡ "OpenAI"). */
function entityKey(raw: string): string {
  const disp = entityDisplay(raw).toLowerCase().replace(/[’']/g, "");
  const parts = disp.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  parts[parts.length - 1] = singularize(parts[parts.length - 1]!);
  return parts.join("");
}

/** Reject obvious NER noise (empty, numeric, or a single lowercase common word). */
function isJunkEntity(display: string): boolean {
  if (display.length < 2 || /^\d+$/.test(display)) return true;
  const words = display.split(" ");
  if (words.length < 2 && !/[A-Z]/.test(display)) return true; // lowercase single word
  if (words.every((w) => STOPWORDS.has(w.toLowerCase()))) return true;
  return false;
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function contextAround(haystack: string, needle: string, radius = 90): string {
  const i = haystack.indexOf(needle);
  if (i === -1) return "";
  const start = Math.max(0, i - radius);
  const end = Math.min(haystack.length, i + needle.length + radius);
  return (start > 0 ? "…" : "") + haystack.slice(start, end).replace(/\s+/g, " ").trim() + (end < haystack.length ? "…" : "");
}

function wordCount(s: string): number {
  return (s.match(WORD_RE) || []).length;
}

// ---------------------------------------------------------------------------
// Per-turn extractors
// ---------------------------------------------------------------------------

function extractTurnLinks(t: ChatTurn, chat: Chat): LinkItem[] {
  const out: LinkItem[] = [];
  const seen = new Set<string>();
  const plain = t.answerText || htmlToText(t.answerHtml);

  // 1) Anchor links from the HTML (richest — carries link text).
  if (t.answerHtml) {
    try {
      const doc = new DOMParser().parseFromString(t.answerHtml, "text/html");
      doc.querySelectorAll("a[href]").forEach((a) => {
        const url = a.getAttribute("href") || "";
        if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
        seen.add(url);
        const text = (a.textContent || url).trim();
        out.push({
          url, domain: domainOf(url), text,
          context: contextAround(plain, text) || contextAround(plain, url),
          chatId: chat.id, chatTitle: chat.title, turnIndex: t.index,
        });
      });
    } catch { /* fall through to bare-url scan */ }
  }

  // 2) Bare URLs in the plain text the anchors didn't already cover.
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(plain))) {
    // Strip trailing sentence punctuation, but only drop a closing paren when it's
    // unbalanced (so URLs like ...(disambiguation) survive intact).
    let url = m[0].replace(/[.,;:]+$/, "");
    if (url.endsWith(")") && !url.includes("(")) url = url.replace(/\)+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url, domain: domainOf(url), text: url,
      context: contextAround(plain, url),
      chatId: chat.id, chatTitle: chat.title, turnIndex: t.index,
    });
  }
  return out;
}

function extractTurnCode(t: ChatTurn, chat: Chat): CodeBlock[] {
  if (!t.answerHtml) return [];
  const out: CodeBlock[] = [];
  try {
    const doc = new DOMParser().parseFromString(t.answerHtml, "text/html");
    doc.querySelectorAll("pre").forEach((pre) => {
      const codeEl = pre.querySelector("code") || pre;
      const code = (codeEl.textContent || "").replace(/\s+$/, "");
      if (!code.trim()) return;
      const cls = codeEl.getAttribute("class") || pre.getAttribute("class") || "";
      const lang = (cls.match(/language-([a-z0-9+#-]+)/i)?.[1] || cls.match(/\b([a-z]+)\b/i)?.[1] || "code").toLowerCase();
      out.push({ lang, code, chatId: chat.id, chatTitle: chat.title, turnIndex: t.index });
    });
  } catch { /* ignore */ }
  return out;
}

function groupLinks(links: LinkItem[]): DomainGroup[] {
  const map = new Map<string, DomainGroup>();
  for (const l of links) {
    if (!l.domain) continue;
    const g = map.get(l.domain);
    if (g) { g.items.push(l); g.count++; }
    else map.set(l.domain, { domain: l.domain, count: 1, items: [l] });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

interface EntityAgg {
  key: string;
  /** display form → frequency, to pick the most common surface as the label. */
  displays: Map<string, number>;
  count: number;
  chatIds: Set<string>;
  kinds: Map<EntityKind, number>;
}

/** High-quality typed NER via compromise — people, organizations, places — over
 *  PROSE only (code + URLs already stripped). Aggregates by canonical key so
 *  possessive/whitespace/plural variants merge into one counted entity. This is
 *  the single extraction path used for both per-chat and whole-archive views. */
function tallyEntitiesNLP(prose: string, chatId: string, into: Map<string, EntityAgg>) {
  let doc: ReturnType<typeof nlp>;
  try { doc = nlp(prose.slice(0, 200_000)); } catch { return; }
  const add = (names: string[], kind: EntityKind) => {
    for (const raw of names) {
      const display = entityDisplay(raw);
      if (isJunkEntity(display)) continue;
      const key = entityKey(raw);
      if (!key) continue;
      let e = into.get(key);
      if (!e) { e = { key, displays: new Map(), count: 0, chatIds: new Set(), kinds: new Map() }; into.set(key, e); }
      e.count++;
      e.chatIds.add(chatId);
      e.displays.set(display, (e.displays.get(display) || 0) + 1);
      e.kinds.set(kind, (e.kinds.get(kind) || 0) + 1);
    }
  };
  try { add(doc.people().out("array"), "person"); } catch { /* ignore */ }
  try { add(doc.organizations().out("array"), "org"); } catch { /* ignore */ }
  try { add(doc.places().out("array"), "place"); } catch { /* ignore */ }
}

/** Finalize aggregates → sorted Entity[] with a display label + winning kind. */
function aggToEntities(map: Map<string, EntityAgg>): Entity[] {
  const out: Entity[] = [];
  for (const e of map.values()) {
    let name = ""; let best = -1;
    for (const [d, n] of e.displays) if (n > best) { best = n; name = d; }
    let kind: EntityKind = "name"; let bk = -1;
    for (const [k, n] of e.kinds) if (n > bk) { bk = n; kind = k; }
    out.push({ name, count: e.count, chatIds: [...e.chatIds], kind });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Merge one chat's finalized entities into a cross-chat aggregate (archive). */
function mergeEntities(entities: Entity[], into: Map<string, EntityAgg>) {
  for (const e of entities) {
    const key = entityKey(e.name);
    if (!key) continue;
    let agg = into.get(key);
    if (!agg) { agg = { key, displays: new Map(), count: 0, chatIds: new Set(), kinds: new Map() }; into.set(key, agg); }
    agg.count += e.count;
    for (const id of e.chatIds) agg.chatIds.add(id);
    agg.displays.set(e.name, (agg.displays.get(e.name) || 0) + e.count);
    if (e.kind) agg.kinds.set(e.kind, (agg.kinds.get(e.kind) || 0) + e.count);
  }
}

/** RAKE-lite keyword topics: candidate phrases split on stopwords, scored by
 *  word degree/frequency. Returns top-weighted phrases. */
function rakeTopics(text: string, limit = 12): Topic[] {
  const tokens = (text.toLowerCase().match(WORD_RE) || []);
  const phrases: string[][] = [];
  let cur: string[] = [];
  for (const tok of tokens) {
    if (STOPWORDS.has(tok) || tok.length < 3 || /^\d+$/.test(tok)) {
      if (cur.length) { phrases.push(cur); cur = []; }
    } else cur.push(tok);
  }
  if (cur.length) phrases.push(cur);

  const freq = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const p of phrases) {
    const d = p.length - 1;
    for (const w of p) {
      freq.set(w, (freq.get(w) || 0) + 1);
      degree.set(w, (degree.get(w) || 0) + d + 1);
    }
  }
  const wordScore = (w: string) => (degree.get(w) || 0) / (freq.get(w) || 1);

  const scored = new Map<string, number>();
  for (const p of phrases) {
    if (p.length > 4) continue;
    const phrase = p.join(" ");
    const score = p.reduce((s, w) => s + wordScore(w), 0);
    scored.set(phrase, Math.max(scored.get(phrase) || 0, score));
  }
  return [...scored.entries()]
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

function uniqueEmails(text: string): string[] {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text))) set.add(m[0]);
  return [...set];
}

// ---------------------------------------------------------------------------
// Public: per-chat
// ---------------------------------------------------------------------------

// Content-hashed cache: per-chat insight extraction (the NER/RAKE work) is done
// once and reused until the chat's content changes. archiveInsights merges these
// cached results, so it no longer reprocesses every turn on every storage change.
const chatInsightsCache = new Map<string, { hash: string; value: ChatInsights }>();

/** Hash of a chat's searchable content — invalidates the cache when text moves. */
function chatContentHash(chat: Chat): string {
  let s = `${chat.id}|${chat.turns.length}`;
  for (const t of chat.turns) s += `${t.question || ""}${t.answerText || ""}`;
  return hashText(s);
}

function computeChatInsights(chat: Chat): ChatInsights {
  const links: LinkItem[] = [];
  const code: CodeBlock[] = [];
  const entityMap = new Map<string, EntityAgg>();
  let proseAll = "";
  let longestAnswerWords = 0;
  let words = 0;

  for (const t of chat.turns) {
    links.push(...extractTurnLinks(t, chat));
    code.push(...extractTurnCode(t, chat));
    const prose = proseTurnText(t);
    proseAll += prose + "\n";
    tallyEntitiesNLP(prose, chat.id, entityMap);
    const aw = wordCount(t.answerText || htmlToText(t.answerHtml));
    if (aw > longestAnswerWords) longestAnswerWords = aw;
    words += wordCount(turnText(t));
  }

  const entities = aggToEntities(entityMap);
  const topics = rakeTopics(proseAll);
  const emails = uniqueEmails(proseAll);

  const stats: ChatStats = {
    turns: chat.turns.length,
    words,
    tokens: Math.round(words / 0.75),
    readingMinutes: Math.max(1, Math.round(words / 220)),
    date: chat.scrapedAt,
    longestAnswerWords,
  };

  return { links: groupLinks(links), entities, topics, emails, code, stats };
}

export function chatInsights(chat: Chat): ChatInsights {
  const hash = chatContentHash(chat);
  const cached = chatInsightsCache.get(chat.id);
  if (cached && cached.hash === hash) return cached.value;
  const value = computeChatInsights(chat);
  chatInsightsCache.set(chat.id, { hash, value });
  return value;
}

// ---------------------------------------------------------------------------
// Public: whole archive (global browse). Derived reactively from all chats.
// ---------------------------------------------------------------------------

export function archiveInsights(chats: Chat[]): ArchiveInsights {
  const allLinks: LinkItem[] = [];
  const entityMap = new Map<string, EntityAgg>();
  const topicWeight = new Map<string, number>();
  const emailCount = new Map<string, number>();
  let totalTurns = 0;
  let totalWords = 0;

  // Reuse the (cached) per-chat extraction and merge — the same compromise-typed
  // entities the reader sees, so the two views never disagree, and only chats
  // whose content actually changed are recomputed.
  for (const chat of chats) {
    const ci = chatInsights(chat);
    for (const g of ci.links) for (const l of g.items) allLinks.push(l);
    mergeEntities(ci.entities, entityMap);
    for (const tp of ci.topics) topicWeight.set(tp.term, (topicWeight.get(tp.term) || 0) + tp.weight);
    for (const e of ci.emails) emailCount.set(e, (emailCount.get(e) || 0) + 1);
    totalTurns += ci.stats.turns;
    totalWords += ci.stats.words;
  }

  const entities = aggToEntities(entityMap)
    .filter((e) => e.count > 1 || e.chatIds.length > 1)
    .slice(0, 200);
  const topics = [...topicWeight.entries()]
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 80);
  const emails = [...emailCount.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  return {
    links: groupLinks(allLinks),
    entities,
    topics,
    emails,
    totalChats: chats.length,
    totalTurns,
    totalWords,
  };
}
