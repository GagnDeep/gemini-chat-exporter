// Background service worker.
//   • Keeps the toolbar badge showing how many chats are collected.
//   • Adds a right-click context menu + keyboard command to scrape the full
//     conversation without opening the popup.

import type { Chat } from "@/lib/types";
import { getSettings } from "@/lib/settings";

const STORAGE_KEY = "collected_chats";
const MENU_ID = "scrape-full-chat";

async function getChats(): Promise<Chat[]> {
  const res = await browser.storage.local.get(STORAGE_KEY);
  return (res[STORAGE_KEY] as Chat[]) ?? [];
}

async function updateBadge(): Promise<void> {
  try {
    const chats = await getChats();
    const n = chats.length;
    await browser.action.setBadgeText({ text: n ? String(n) : "" });
    await browser.action.setBadgeBackgroundColor({ color: "#673ab7" });
  } catch {
    /* action API unavailable (e.g. during install race) */
  }
}

/** Best-effort sync of a chat into the web app, mirroring the popup logic. */
async function syncToWebapp(chat: Chat): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoSyncToWebapp) return;
  const origin = settings.webappOrigin.replace(/\/+$/, "");
  try {
    let [tab] = await browser.tabs.query({ url: `${origin}/*` });
    if (!tab?.id) {
      tab = await browser.tabs.create({ url: origin + "/", active: false });
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (tab?.id) {
      await browser.tabs.sendMessage(tab.id, {
        type: "SYNC_TO_WEBAPP",
        chats: [chat],
        mode: settings.mergeMode,
      });
    }
  } catch {
    /* ignore — popup surfaces sync errors interactively */
  }
}

async function scrapeActiveTab(tabId: number, tabUrl?: string): Promise<void> {
  if (!tabUrl?.includes("gemini.google.com")) {
    await flashBadge("!");
    return;
  }
  try {
    const settings = await getSettings();
    const resp = (await browser.tabs.sendMessage(tabId, {
      type: "SCRAPE_FULL_CHAT",
      opts: { scrollDelayMs: settings.scrollDelayMs, maxIterations: settings.maxIterations },
    })) as { ok: true; chat: Chat } | { ok: false; error: string } | undefined;

    if (!resp?.ok) {
      await flashBadge("!");
      return;
    }
    const chats = await getChats();
    const i = chats.findIndex((c) => c.id === resp.chat.id);
    if (i >= 0) chats[i] = resp.chat;
    else chats.push(resp.chat);
    await browser.storage.local.set({ [STORAGE_KEY]: chats });
    await updateBadge();
    await syncToWebapp(resp.chat);
    await flashBadge("✓");
  } catch {
    await flashBadge("!");
  }
}

async function flashBadge(text: string): Promise<void> {
  try {
    await browser.action.setBadgeText({ text });
    await browser.action.setBadgeBackgroundColor({ color: text === "✓" ? "#1a73e8" : "#f28b82" });
    setTimeout(updateBadge, 2000);
  } catch {
    /* ignore */
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      console.log(
        "[Gemini Chat Exporter] installed. Open a chat on gemini.google.com and click the toolbar icon.",
      );
    }
    try {
      browser.contextMenus.create({
        id: MENU_ID,
        title: "Scrape this Gemini chat (full)",
        contexts: ["page"],
        documentUrlPatterns: ["https://gemini.google.com/*"],
      });
    } catch {
      /* contextMenus may not be granted in all builds */
    }
    updateBadge();
  });

  browser.runtime.onStartup?.addListener(updateBadge);

  // Keep the badge in sync as the collection changes.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) updateBadge();
  });

  browser.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID && tab?.id) scrapeActiveTab(tab.id, tab.url);
  });

  browser.commands?.onCommand.addListener(async (command) => {
    if (command !== "scrape-full-chat") return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) scrapeActiveTab(tab.id, tab.url);
  });

  updateBadge();
});
