// Canonical chat collection, persisted in browser.storage.local.
//
// This is the single source of truth for scraped conversations. The content
// script writes here directly (partial snapshots *and* the final result) so a
// capture is never lost when the popup closes or the service worker is evicted.
// The popup and the archive page read from here and react to storage changes.

import type { Chat, ChatTurn } from "./types";

export const CHATS_KEY = "collected_chats";

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
  for (const t of existing) {
    if (t.key) byKey.set(t.key, t);
    byIndex.set(t.index, t);
  }

  const result: ChatTurn[] = [];
  const usedIndexes = new Set<number>();

  for (const t of incoming) {
    let prev: ChatTurn | undefined;
    if (t.key && byKey.has(t.key)) {
      prev = byKey.get(t.key);
      if (prev) usedIndexes.add(prev.index);
    } else if (!t.key && byIndex.has(t.index) && !usedIndexes.has(t.index)) {
      // Index fallback is ONLY for legacy keyless data. When the incoming turn
      // carries a key but doesn't match any existing key, it is a *new* turn —
      // never let it overwrite a differently-keyed turn that happens to share an
      // index (that would silently drop a captured turn).
      const cand = byIndex.get(t.index);
      if (cand && !cand.key) {
        prev = cand;
        usedIndexes.add(t.index);
      }
    }

    if (prev) {
      const richer = (t.answerText?.length || 0) >= (prev.answerText?.length || 0);
      result.push({
        index: t.index,
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
    if (!usedIndexes.has(t.index)) result.push({ ...t });
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
