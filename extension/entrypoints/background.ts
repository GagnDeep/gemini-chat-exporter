// Background service worker.
//   • Keeps the toolbar badge in sync with the collected-chats count, and shows
//     a live indicator while a capture is running.
//   • Right-click menu + keyboard command start a *persisted* background scrape
//     (the content script owns the capture + persistence, so it survives the SW
//     being evicted).
//   • Tells content scripts which tab they live in (WHICH_TAB).
//   • Syncs freshly-finished chats into the companion web app when enabled.

import type { Chat, ScrapeJob } from "@/lib/types";
import { getSettings } from "@/lib/settings";
import { getChats, CHATS_KEY } from "@/lib/chats-store";
import { JOBS_KEY, getJobs, reconcileStalled } from "@/lib/jobs";

const MENU_ID = "scrape-full-chat";

async function updateBadge(): Promise<void> {
  try {
    const [chats, jobs] = await Promise.all([getChats(), getJobs()]);
    const active = jobs.some((j) => j.status === "scraping");
    if (active) {
      await browser.action.setBadgeText({ text: "…" });
      await browser.action.setBadgeBackgroundColor({ color: "#1a73e8" });
      return;
    }
    const n = chats.length;
    await browser.action.setBadgeText({ text: n ? String(n) : "" });
    await browser.action.setBadgeBackgroundColor({ color: "#673ab7" });
  } catch {
    /* action API unavailable (e.g. during install race) */
  }
}

/** Best-effort sync of a chat into the web app. */
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
    /* ignore — the popup surfaces sync errors interactively */
  }
}

/** Kick off a persisted scrape in a Gemini tab (used by menu + command). */
async function startScrapeInTab(tabId: number, tabUrl?: string): Promise<void> {
  if (!tabUrl?.includes("gemini.google.com")) {
    await flashBadge("!");
    return;
  }
  try {
    const settings = await getSettings();
    const resp = (await browser.tabs.sendMessage(tabId, {
      type: "START_SCRAPE",
      opts: { scrollDelayMs: settings.scrollDelayMs, maxIterations: settings.maxIterations },
    })) as { ok: boolean; error?: string } | undefined;
    await flashBadge(resp?.ok ? "…" : "!");
  } catch {
    await flashBadge("!");
  }
}

async function flashBadge(text: string): Promise<void> {
  try {
    await browser.action.setBadgeText({ text });
    await browser.action.setBadgeBackgroundColor({ color: text === "!" ? "#f28b82" : "#1a73e8" });
    setTimeout(updateBadge, 2000);
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait (bounded) for a tab to finish loading before we message its content script. */
async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await browser.tabs.get(tabId);
      if (t.status === "complete") return;
    } catch {
      return; // tab gone
    }
    await sleep(300);
  }
}

/**
 * Ask a Gemini tab's content script to type + submit a prompt, retrying while the
 * content script (or the SPA it drives) is still coming up on a fresh tab.
 */
async function sendPromptToTab(tabId: number, text: string): Promise<{ ok: boolean; error?: string }> {
  let lastErr = "";
  for (let i = 0; i < 30; i++) {
    try {
      const resp = (await browser.tabs.sendMessage(tabId, { type: "SEND_PROMPT", text })) as
        | { ok: boolean; error?: string }
        | undefined;
      if (resp) return resp;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e); // usually "no receiving end yet"
    }
    await sleep(500);
  }
  return { ok: false, error: lastErr || "The Gemini page didn't respond in time." };
}

/**
 * Continue an archived conversation live: focus (or open) its Gemini tab and
 * submit `text` into the composer. Reuses an existing tab already on that
 * conversation when one is open, so we never spawn duplicates.
 */
async function sendToGemini(args: { url?: string; convId?: string; text: string }): Promise<{ ok: boolean; error?: string }> {
  const text = (args.text || "").trim();
  if (!text) return { ok: false, error: "Nothing to send." };
  try {
    const tabs = await browser.tabs.query({ url: "https://gemini.google.com/*" });
    let tab = args.convId ? tabs.find((t) => t.url && t.url.includes(args.convId!)) : undefined;
    let freshlyOpened = false;

    if (tab?.id != null) {
      await browser.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        try { await browser.windows.update(tab.windowId, { focused: true }); } catch { /* single-window */ }
      }
    } else {
      tab = await browser.tabs.create({ url: args.url || "https://gemini.google.com/app", active: true });
      freshlyOpened = true;
    }
    if (tab?.id == null) return { ok: false, error: "Couldn't open a Gemini tab." };

    await waitForTabComplete(tab.id, freshlyOpened ? 25_000 : 8_000);
    return await sendPromptToTab(tab.id, text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Track which jobs we've already synced so a single completion fires once. */
const syncedJobs = new Set<string>();

async function onJobsChanged(jobs: ScrapeJob[]): Promise<void> {
  for (const job of jobs) {
    if (job.status === "done" && !syncedJobs.has(job.id)) {
      syncedJobs.add(job.id);
      const chat = (await getChats()).find((c) => c.id === job.chatId);
      if (chat) void syncToWebapp(chat);
    }
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
        title: "Capture this Gemini chat (full)",
        contexts: ["page"],
        documentUrlPatterns: ["https://gemini.google.com/*"],
      });
    } catch {
      /* contextMenus may not be granted in all builds */
    }
    void reconcileStalled();
    void updateBadge();
  });

  browser.runtime.onStartup?.addListener(() => {
    void reconcileStalled();
    void updateBadge();
  });

  // Reply to content scripts asking which tab they're in.
  browser.runtime.onMessage.addListener(
    (msg: { type?: string; url?: string; convId?: string; text?: string }, sender, sendResponse) => {
      if (msg?.type === "WHICH_TAB") {
        sendResponse({ tabId: sender.tab?.id });
        return; // synchronous
      }
      if (msg?.type === "SEND_TO_GEMINI") {
        sendToGemini({ url: msg.url, convId: msg.convId, text: msg.text ?? "" }).then(sendResponse);
        return true; // async
      }
      return false;
    },
  );

  // Keep the badge in sync and react to job completions.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CHATS_KEY] || changes[JOBS_KEY]) void updateBadge();
    if (changes[JOBS_KEY]) {
      const next = (changes[JOBS_KEY].newValue as ScrapeJob[]) ?? [];
      void onJobsChanged(next);
    }
  });

  browser.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID && tab?.id) void startScrapeInTab(tab.id, tab.url);
  });

  browser.commands?.onCommand.addListener(async (command) => {
    if (command !== "scrape-full-chat") return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) void startScrapeInTab(tab.id, tab.url);
  });

  void reconcileStalled();
  void updateBadge();
});
