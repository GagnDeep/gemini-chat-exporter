// Offline entity & concept extraction over chat turns.
//
// High-precision heuristics (GitHub repos, Hugging Face models, URLs) run
// instantly on import. "project" detection is fuzzier and best-effort.
// "concept" detection needs sentence embeddings and is ranked later by
// buildEntityIndex() in db.ts (KeyBERT-style: embed candidate phrases, rank by
// cosine similarity to the segment embedding). No new model download — it
// reuses the existing transformers.js worker.

import type { Chat, ChatTurn } from "./types";

export type EntityType = "github" | "huggingface" | "url" | "project" | "concept";

export interface Entity {
  /** `${chatId}#${turnIndex}#${type}#${slug(value)}` — stable across re-import. */
  id: string;
  type: EntityType;
  /** Canonical value, e.g. "owner/repo" or a full URL or a phrase. */
  value: string;
  /** Display label (often the same as value, or a host for URLs). */
  label: string;
  chatId: string;
  turnIndex: number;
  /** Occurrences within this turn. */
  count: number;
}

const GITHUB_OWNER_BLOCKLIST = new Set([
  "about", "features", "pricing", "sponsors", "topics", "collections",
  "marketplace", "explore", "settings", "notifications", "login", "join",
  "search", "orgs", "apps", "contact", "site", "blog", "enterprise", "team",
]);
const GITHUB_REPO_BLOCKLIST = new Set(["issues", "pulls", "blob", "tree", "wiki", "releases"]);

const STOP_PHRASES = new Set([
  "the", "this", "that", "these", "those", "for example", "such as",
  "on the", "in the", "to the", "of the", "and the", "i can", "you can",
  "here is", "here are", "note that", "for instance",
]);

const CONCEPT_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "day", "get", "has", "him", "his", "how", "man", "new",
  "now", "old", "see", "two", "way", "who", "boy", "did", "its", "let", "put",
  "say", "she", "too", "use", "with", "this", "that", "from", "they", "have",
  "will", "your", "what", "when", "which", "their", "would", "there", "about",
  "could", "other", "into", "than", "then", "them", "these", "some", "more",
  "also", "such", "like", "just", "only", "very", "much", "most", "many",
  "should", "because", "however", "therefore", "example", "using", "used",
  "make", "made", "need", "want", "able", "well", "good", "sure", "here",
  "where", "while", "being", "does", "doing", "done", "each", "both",
]);

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "x";
}

function entityId(chatId: string, turnIndex: number, type: EntityType, value: string): string {
  return `${chatId}#${turnIndex}#${type}#${slug(value)}`;
}

function matchAll(s: string, re: RegExp): RegExpMatchArray[] {
  return [...s.matchAll(re)];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isProjectName(s: string): boolean {
  if (s.length < 2 || s.length > 40 || /\s/.test(s)) return false;
  if (!/^[A-Za-z0-9_.@/-]+$/.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  // Require a "namey" shape (hyphen/underscore/dot/slash, camelCase, or
  // Capitalized) so plain lowercase english words are skipped.
  return /[-_./]/.test(s) || /[a-z][A-Z]/.test(s) || /^[A-Z]/.test(s);
}

/**
 * Extract high-precision + heuristic entities (everything except concepts) for
 * a whole chat. Pure and synchronous.
 */
export function extractHeuristicEntities(chat: Chat): Entity[] {
  const out = new Map<string, Entity>();
  const add = (turnIndex: number, type: EntityType, value: string, label?: string) => {
    const v = value.trim();
    if (!v) return;
    const id = entityId(chat.id, turnIndex, type, v);
    const existing = out.get(id);
    if (existing) existing.count++;
    else out.set(id, { id, type, value: v, label: label ?? v, chatId: chat.id, turnIndex, count: 1 });
  };

  for (const turn of chat.turns) {
    const text = `${turn.question}\n${turn.answerText}`;
    const html = turn.answerHtml || "";
    const hrefs = matchAll(html, /href\s*=\s*"([^"]+)"/gi).map((m) => decodeEntities(m[1]!));
    const codes = matchAll(html, /<code[^>]*>([\s\S]*?)<\/code>/gi).map((m) =>
      decodeEntities(stripTags(m[1]!)).trim(),
    );
    const haystack = text + "\n" + hrefs.join("\n");

    const ghSet = new Set<string>();
    const hfSet = new Set<string>();

    // GitHub repos
    for (const m of matchAll(haystack, /github\.com\/([\w.-]+)\/([\w.-]+)/gi)) {
      const owner = m[1]!;
      const repo = m[2]!.replace(/\.git$/i, "").replace(/[.,)]+$/, "");
      if (GITHUB_OWNER_BLOCKLIST.has(owner.toLowerCase())) continue;
      if (!repo || GITHUB_REPO_BLOCKLIST.has(repo.toLowerCase())) continue;
      const value = `${owner}/${repo}`;
      ghSet.add(value.toLowerCase());
      add(turn.index, "github", value);
    }

    // Hugging Face models/datasets/spaces from URLs
    for (const m of matchAll(
      haystack,
      /huggingface\.co\/(?:(?:models|datasets|spaces)\/)?([\w.-]+\/[\w.-]+)/gi,
    )) {
      const value = m[1]!.replace(/[.,)]+$/, "");
      hfSet.add(value.toLowerCase());
      add(turn.index, "huggingface", value);
    }
    // Bare org/model ids inside code spans (e.g. `Xenova/all-MiniLM-L6-v2`)
    for (const code of codes) {
      if (/^[\w.-]+\/[\w.-]+$/.test(code) && code.length <= 60) {
        const low = code.toLowerCase();
        if (ghSet.has(low) || hfSet.has(low)) continue;
        hfSet.add(low);
        add(turn.index, "huggingface", code);
      }
    }

    // General URLs (excluding ones already captured more specifically)
    for (const m of matchAll(haystack, /\bhttps?:\/\/[^\s<>"')]+/gi)) {
      const url = m[0]!.replace(/[.,)]+$/, "");
      if (/github\.com|huggingface\.co/i.test(url)) continue;
      add(turn.index, "url", url, hostOf(url));
    }

    // Projects: code-span identifiers + capitalized multi-word phrases
    for (const code of codes) {
      if (isProjectName(code)) {
        const low = code.toLowerCase();
        if (ghSet.has(low) || hfSet.has(low) || low.includes("/")) continue;
        add(turn.index, "project", code);
      }
    }
    for (const m of matchAll(text, /\b([A-Z][a-zA-Z0-9]+(?:[ -][A-Z][a-zA-Z0-9]+){1,3})\b/g)) {
      const phrase = m[1]!.trim();
      if (STOP_PHRASES.has(phrase.toLowerCase())) continue;
      add(turn.index, "project", phrase);
    }
  }
  return [...out.values()];
}

/**
 * Candidate concept phrases for a piece of text: stopword-filtered unigrams and
 * bigrams, ranked by frequency. Ranking by meaning happens later via embeddings.
 */
export function conceptCandidates(text: string, max = 18): string[] {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/gi) || []).map((w) =>
    w.replace(/[.-]+$/, ""),
  );
  const freq = new Map<string, number>();
  const bump = (p: string) => freq.set(p, (freq.get(p) || 0) + 1);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.length < 3 || CONCEPT_STOPWORDS.has(w)) continue;
    bump(w);
    const w2 = words[i + 1];
    if (w2 && w2.length >= 3 && !CONCEPT_STOPWORDS.has(w2)) bump(`${w} ${w2}`);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([p]) => p);
}

/** Build a concept Entity row for a ranked phrase. */
export function conceptEntity(
  chatId: string,
  turnIndex: number,
  phrase: string,
  count = 1,
): Entity {
  return {
    id: entityId(chatId, turnIndex, "concept", phrase),
    type: "concept",
    value: phrase,
    label: phrase,
    chatId,
    turnIndex,
    count,
  };
}

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  github: "GitHub repos",
  huggingface: "Hugging Face",
  url: "Links",
  project: "Projects",
  concept: "Concepts",
};
