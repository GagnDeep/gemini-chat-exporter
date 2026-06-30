// Per-chat presentation metadata (pins + custom titles), persisted separately
// from the captured content so renaming/pinning never touches the source data
// and survives re-captures.

export interface ChatMeta {
  pinned?: boolean;
  /** User-set title that overrides the scraped one for display. */
  title?: string;
  /** ISO timestamp the user pinned it (for stable pinned ordering). */
  pinnedAt?: string;
}

export type ChatMetaMap = Record<string, ChatMeta>;

export const META_KEY = "chat_meta";

export async function getChatMeta(): Promise<ChatMetaMap> {
  const res = await browser.storage.local.get(META_KEY);
  return (res[META_KEY] as ChatMetaMap) ?? {};
}

export async function setChatMeta(id: string, patch: ChatMeta): Promise<ChatMetaMap> {
  const all = await getChatMeta();
  const next: ChatMeta = { ...all[id], ...patch };
  // Drop empty entries so the map stays tidy.
  if (!next.pinned && !next.title) delete all[id];
  else all[id] = next;
  await browser.storage.local.set({ [META_KEY]: all });
  return all;
}

export async function togglePin(id: string): Promise<ChatMetaMap> {
  const all = await getChatMeta();
  const pinned = !all[id]?.pinned;
  return setChatMeta(id, { pinned, pinnedAt: pinned ? new Date().toISOString() : undefined });
}

/** Resolve the display title for a chat id, honoring any custom override. */
export function displayTitle(meta: ChatMetaMap, id: string, fallback: string): string {
  return meta[id]?.title?.trim() || fallback;
}
