// React hooks over the extension's storage.local — the archive's live data feed.
// Everything (chats, jobs, settings) is observed via storage.onChanged so the
// UI updates the instant the content script persists a new snapshot.

import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { Chat, ScrapeJob } from "@/lib/types";
import { CHATS_KEY, getChats, setChats } from "@/lib/chats-store";
import { JOBS_KEY, getJobs, reconcileStalled } from "@/lib/jobs";
import { getSettings, setSettings, DEFAULT_SETTINGS, type Settings } from "@/lib/settings";
import { META_KEY, getChatMeta, type ChatMetaMap } from "@/lib/meta";

type Area = "local" | "sync" | "managed" | "session";
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;

function useStorageValue<T>(key: string, load: () => Promise<T>, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    let alive = true;
    load().then((v) => alive && setValue(v));
    const onChange = (changes: Changes, area: Area) => {
      if (area === "local" && key in changes) load().then((v) => alive && setValue(v));
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

export function useChats(): Chat[] {
  return useStorageValue<Chat[]>(CHATS_KEY, getChats, []);
}

export function useJobs(): ScrapeJob[] {
  // Reconcile any stalled jobs once when the archive mounts.
  useEffect(() => {
    void reconcileStalled();
  }, []);
  return useStorageValue<ScrapeJob[]>(JOBS_KEY, getJobs, []);
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => Promise<void>] {
  const settings = useStorageValue<Settings>("settings", getSettings, DEFAULT_SETTINGS);
  const update = async (patch: Partial<Settings>) => {
    await setSettings(patch);
  };
  return [settings, update];
}

export function useChatMeta(): ChatMetaMap {
  return useStorageValue<ChatMetaMap>(META_KEY, getChatMeta, {});
}

/** Remove a chat from the collection. */
export async function deleteChat(chatId: string): Promise<void> {
  const chats = await getChats();
  await setChats(chats.filter((c) => c.id !== chatId));
}

/** Remove many chats in a single write. */
export async function deleteChats(chatIds: Iterable<string>): Promise<number> {
  const drop = new Set(chatIds);
  if (!drop.size) return 0;
  const chats = await getChats();
  const kept = chats.filter((c) => !drop.has(c.id));
  await setChats(kept);
  return chats.length - kept.length;
}

/** Wipe the whole collection. */
export async function clearChats(): Promise<void> {
  await setChats([]);
}
