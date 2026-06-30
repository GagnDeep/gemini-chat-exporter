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
// Capitalized multi-word proper-noun phrases (heuristic NER).
const ENTITY_RE = /\b([A-Z][a-zA-Z0-9'’.-]+(?:\s+(?:of|the|and|de|van|von)\s+)?(?:\s+[A-Z][a-zA-Z0-9'’.-]+){0,3})\b/g;
const WORD_RE = /[a-zA-Z0-9][a-zA-Z0-9'’+-]*/g;

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

function turnText(t: ChatTurn): string {
  const answer = t.answerText || htmlToText(t.answerHtml);
  return `${t.question || ""}\n${answer}`;
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
    const url = m[0].replace(/[.,;:)]+$/, "");
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

/** High-quality NER via compromise — people, organizations, places. Used for a
 *  single chat (bounded work). Falls back silently to the regex tally on error. */
function tallyEntitiesNLP(text: string, chatId: string, into: Map<string, Entity>) {
  try {
    const doc = nlp(text.slice(0, 200_000));
    const add = (names: string[], kind: EntityKind) => {
      for (const raw of names) {
        const name = raw.trim().replace(/\s+/g, " ");
        if (name.length < 2 || /^\d+$/.test(name)) continue;
        const key = name.toLowerCase();
        const e = into.get(key);
        if (e) { e.count++; if (!e.chatIds.includes(chatId)) e.chatIds.push(chatId); }
        else into.set(key, { name, count: 1, chatIds: [chatId], kind });
      }
    };
    add(doc.people().out("array"), "person");
    add(doc.organizations().out("array"), "org");
    add(doc.places().out("array"), "place");
  } catch {
    tallyEntities(text, chatId, into);
  }
}

/** Heuristic named-entity / people extraction from raw text. */
function tallyEntities(text: string, chatId: string, into: Map<string, Entity>) {
  let m: RegExpExecArray | null;
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(text))) {
    const name = m[1].replace(/\s+/g, " ").replace(/[.'’-]+$/, "").trim();
    const words = name.split(" ");
    // Keep multi-word phrases, or single proper nouns that aren't sentence-start noise.
    const lc = words[0]!.toLowerCase();
    if (words.length < 2 && (STOPWORDS.has(lc) || name.length < 3)) continue;
    if (words.length >= 2 && words.every((w) => STOPWORDS.has(w.toLowerCase()))) continue;
    const key = name.toLowerCase();
    const e = into.get(key);
    if (e) { e.count++; if (!e.chatIds.includes(chatId)) e.chatIds.push(chatId); }
    else into.set(key, { name, count: 1, chatIds: [chatId] });
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

export function chatInsights(chat: Chat): ChatInsights {
  const links: LinkItem[] = [];
  const code: CodeBlock[] = [];
  const entityMap = new Map<string, Entity>();
  let fullText = "";
  let longestAnswerWords = 0;
  let words = 0;

  for (const t of chat.turns) {
    links.push(...extractTurnLinks(t, chat));
    code.push(...extractTurnCode(t, chat));
    const text = turnText(t);
    fullText += text + "\n";
    tallyEntitiesNLP(text, chat.id, entityMap);
    const aw = wordCount(t.answerText || htmlToText(t.answerHtml));
    if (aw > longestAnswerWords) longestAnswerWords = aw;
    words += wordCount(text);
  }

  const entities = [...entityMap.values()].sort((a, b) => b.count - a.count);
  const topics = rakeTopics(fullText);
  const emails = uniqueEmails(fullText);

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

// ---------------------------------------------------------------------------
// Public: whole archive (global browse). Derived reactively from all chats.
// ---------------------------------------------------------------------------

export function archiveInsights(chats: Chat[]): ArchiveInsights {
  const allLinks: LinkItem[] = [];
  const entityMap = new Map<string, Entity>();
  const topicWeight = new Map<string, number>();
  const emailCount = new Map<string, number>();
  let totalTurns = 0;
  let totalWords = 0;

  for (const chat of chats) {
    let fullText = "";
    for (const t of chat.turns) {
      allLinks.push(...extractTurnLinks(t, chat));
      const text = turnText(t);
      fullText += text + "\n";
      tallyEntities(text, chat.id, entityMap);
      totalWords += wordCount(text);
    }
    totalTurns += chat.turns.length;
    for (const tp of rakeTopics(fullText, 20)) {
      topicWeight.set(tp.term, (topicWeight.get(tp.term) || 0) + tp.weight);
    }
    for (const e of uniqueEmails(fullText)) emailCount.set(e, (emailCount.get(e) || 0) + 1);
  }

  const entities = [...entityMap.values()]
    .filter((e) => e.count > 1 || e.chatIds.length > 1)
    .sort((a, b) => b.count - a.count)
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
