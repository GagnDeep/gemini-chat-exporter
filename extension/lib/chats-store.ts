// Canonical chat collection, persisted in browser.storage.local.
//
// This is the single source of truth for scraped conversations. The content
// script writes here directly (partial snapshots *and* the final result) so a
// capture is never lost when the popup closes or the service worker is evicted.
// The popup and the archive page read from here and react to storage changes.

import type { Chat, ChatTurn } from "./types";

export const CHATS_KEY = "collected_chats";

// ---------------------------------------------------------------------------
// Cross-method content signature
//
// The same turn can be captured three different ways — the RPC loader (answer as
// Markdown, key `r:<responseId>`), the DOM scraper (answer as innerText, a
// content-hash or DOM-id key), and the live recorder (also DOM). Their KEYS
// differ, so a naive key-only merge would store the same turn twice. To dedupe
// across methods we also compute a normalized content signature: lowercase the
// question + answer, strip everything but alphanumerics, and hash. Markdown and
// innerText of the same answer collapse to (near-)identical alphanumeric streams,
// so their signatures match and the turn is reconciled instead of duplicated.
// ---------------------------------------------------------------------------

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function normContent(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Content signature, or "" when the turn is too short to signature safely
 *  (short strings like "ok" collide across genuinely different turns). */
export function turnContentSig(question: string, answerText: string): string {
  const q = normContent(question);
  const a = normContent(answerText);
  const combined = q + "␟" + a.slice(0, 400);
  // Require enough signal that a coincidental collision is implausible.
  if (q.length + a.length < 12) return "";
  return fnv1a(combined);
}

export async function getChats(): Promise<Chat[]> {
  const res = await browser.storage.local.get(CHATS_KEY);
  return (res[CHATS_KEY] as Chat[]) ?? [];
}

export async function setChats(chats: Chat[]): Promise<void> {
  await browser.storage.local.set({ [CHATS_KEY]: chats });
}

/**
 * Fold an incoming (possibly fuller) scrape of a chat into an existing copy.
 * Matches turns by stable `key`, falling back to `index` for older data.
 * Prefers the incoming turn only when it carries more content, so a *partial*
 * snapshot mid-scrape never clobbers a fuller stored turn. (Ported from the web
 * app's battle-tested merge so the two stay behaviourally identical.)
 */
export function mergeTurns(existing: ChatTurn[], incoming: ChatTurn[]): ChatTurn[] {
  const byKey = new Map<string, ChatTurn>();
  const byIndex = new Map<number, ChatTurn>();
  const bySig = new Map<string, ChatTurn>();
  for (const t of existing) {
    if (t.key) byKey.set(t.key, t);
    byIndex.set(t.index, t);
    const sig = turnContentSig(t.question, t.answerText);
    if (sig && !bySig.has(sig)) bySig.set(sig, t);
  }

  const result: ChatTurn[] = [];
  const used = new Set<ChatTurn>(); // existing turns already consumed

  for (const t of incoming) {
    let prev: ChatTurn | undefined;

    // 1) Exact key match (same capture method, or a re-scrape).
    if (t.key && byKey.has(t.key)) {
      prev = byKey.get(t.key);
    }

    // 2) Content-signature match — reconciles copies captured by a *different*
    //    method (RPC Markdown vs DOM innerText) whose keys don't match.
    if (!prev) {
      const sig = turnContentSig(t.question, t.answerText);
      if (sig) {
        const cand = bySig.get(sig);
        if (cand && !used.has(cand)) prev = cand;
      }
    }

    // 3) Index fallback — ONLY for legacy keyless data. A keyed incoming turn
    //    that matched nothing above is genuinely new; never let it overwrite a
    //    differently-keyed turn that merely shares an index.
    if (!prev && !t.key) {
      const cand = byIndex.get(t.index);
      if (cand && !cand.key && !used.has(cand)) prev = cand;
    }

    if (prev) {
      used.add(prev);
      const richer = (t.answerText?.length || 0) >= (prev.answerText?.length || 0);
      result.push({
        index: t.index,
        // Prefer a stable key from either side so future merges stay anchored.
        key: t.key ?? prev.key,
        question: t.question || prev.question,
        answerText: richer ? t.answerText : prev.answerText,
        answerHtml: richer ? t.answerHtml : prev.answerHtml,
      });
    } else {
      result.push({ ...t });
    }
  }

  // Keep existing turns the incoming scrape didn't cover.
  for (const t of existing) {
    if (!used.has(t)) result.push({ ...t });
  }

  return result.sort((a, b) => a.index - b.index).map((t, i) => ({ ...t, index: i }));
}

/** Merge one incoming chat into the existing copy (or insert it). */
export function mergeChatInto(existing: Chat | undefined, incoming: Chat): Chat {
  if (!existing) return incoming;
  return {
    id: existing.id,
    title: incoming.title || existing.title,
    url: incoming.url || existing.url,
    scrapedAt: incoming.scrapedAt || existing.scrapedAt,
    turns: mergeTurns(existing.turns, incoming.turns),
  };
}

/**
 * Commit a chat into the collection with the given merge mode. Returns the
 * merged chat that was stored. Safe to call repeatedly with partial snapshots:
 * with mode "merge" the richest-content-wins rule keeps the result monotonic.
 */
export async function commitChat(
  chat: Chat,
  mode: "merge" | "replace" = "merge",
): Promise<Chat> {
  const chats = await getChats();
  const i = chats.findIndex((c) => c.id === chat.id);
  let stored: Chat;
  if (i >= 0) {
    stored = mode === "replace" ? chat : mergeChatInto(chats[i], chat);
    chats[i] = stored;
  } else {
    stored = chat;
    chats.push(stored);
  }
  await setChats(chats);
  return stored;
}

export async function removeChat(chatId: string): Promise<void> {
  const chats = await getChats();
  const next = chats.filter((c) => c.id !== chatId);
  if (next.length !== chats.length) await setChats(next);
}
