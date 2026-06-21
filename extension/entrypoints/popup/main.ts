// Popup controller: scrape the active Gemini tab, manage the collected set in
// extension storage, and export to EPUB / Markdown / JSON.

import { buildEpub } from "@/lib/epub";
import { chatsToMarkdown } from "@/lib/markdown";
import type { Chat, GeminiExport } from "@/lib/types";
import { EXPORT_FORMAT, EXPORT_VERSION } from "@/lib/types";
import { getSettings } from "@/lib/settings";
import type { ScrapeOptions } from "@/lib/scraper";

const STORAGE_KEY = "collected_chats";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scrapeBtn = $<HTMLButtonElement>("scrape");
const scrapeFullBtn = $<HTMLButtonElement>("scrape-full");
const optionsBtn = $<HTMLButtonElement>("open-options");
const webappBtn = $<HTMLButtonElement>("open-webapp");
const statusEl = $<HTMLParagraphElement>("status");
const listEl = $<HTMLUListElement>("list");
const countEl = $<HTMLSpanElement>("count");
const emptyEl = $<HTMLParagraphElement>("empty");
const bulkActions = $<HTMLDivElement>("bulk-actions");
const clearBtn = $<HTMLButtonElement>("clear");
const exportEpubBtn = $<HTMLButtonElement>("export-epub");
const exportMdBtn = $<HTMLButtonElement>("export-md");
const exportJsonBtn = $<HTMLButtonElement>("export-json");
const syncAllBtn = $<HTMLButtonElement>("sync-all");

function setStatus(msg: string, kind: "" | "ok" | "err" = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function getChats(): Promise<Chat[]> {
  const res = await browser.storage.local.get(STORAGE_KEY);
  return (res[STORAGE_KEY] as Chat[]) ?? [];
}

async function setChats(chats: Chat[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: chats });
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "gemini-chat";
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function render() {
  const chats = await getChats();
  countEl.textContent = String(chats.length);
  listEl.innerHTML = "";
  const has = chats.length > 0;
  emptyEl.hidden = has;
  bulkActions.hidden = !has;
  clearBtn.hidden = !has;

  chats.forEach((chat, i) => {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <div class="meta">
        <div class="title" title="${escapeAttr(chat.title)}">${escapeHtml(chat.title)}</div>
        <div class="turns">${chat.turns.length} Q&A · ${chat.scrapedAt.slice(0, 10)}</div>
      </div>
      <button class="epub" data-i="${i}" title="Export EPUB">EPUB</button>
      <button class="md" data-i="${i}" title="Export Markdown">MD</button>
      <button class="remove" data-i="${i}" title="Remove">✕</button>`;
    listEl.appendChild(li);
  });

  listEl.querySelectorAll<HTMLButtonElement>("button.epub").forEach((b) =>
    b.addEventListener("click", async () => {
      const chat = (await getChats())[Number(b.dataset.i)];
      if (!chat) return;
      setStatus("Building EPUB…");
      const blob = await buildEpub([chat], { title: chat.title });
      download(blob, `${slugify(chat.title)}.epub`);
      setStatus("EPUB downloaded.", "ok");
    }),
  );

  listEl.querySelectorAll<HTMLButtonElement>("button.md").forEach((b) =>
    b.addEventListener("click", async () => {
      const chat = (await getChats())[Number(b.dataset.i)];
      if (!chat) return;
      download(new Blob([chatsToMarkdown([chat])], { type: "text/markdown" }), `${slugify(chat.title)}.md`);
      setStatus("Markdown downloaded.", "ok");
    }),
  );

  listEl.querySelectorAll<HTMLButtonElement>("button.remove").forEach((b) =>
    b.addEventListener("click", async () => {
      const all = await getChats();
      all.splice(Number(b.dataset.i), 1);
      await setChats(all);
      render();
    }),
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/** Find an existing web app tab for the configured origin, or open one. */
async function getWebappTab(origin: string): Promise<{ id?: number } | undefined> {
  const matchPattern = `${origin}/*`;
  let [tab] = await browser.tabs.query({ url: matchPattern });
  if (!tab?.id) {
    tab = await browser.tabs.create({ url: origin + "/", active: false });
    await new Promise((r) => setTimeout(r, 1500));
  }
  return tab;
}

/**
 * Push chats into the companion web app's IndexedDB via the bridge content
 * script. Returns a status fragment. Best-effort — never throws.
 */
async function syncToWebapp(chats: Chat[], force = false): Promise<string> {
  const settings = await getSettings();
  if (!settings.autoSyncToWebapp && !force) return "";
  const origin = settings.webappOrigin.replace(/\/+$/, "");
  try {
    const tab = await getWebappTab(origin);
    if (!tab?.id) return " Auto-sync skipped (no web app tab).";
    const resp = (await browser.tabs.sendMessage(tab.id, {
      type: "SYNC_TO_WEBAPP",
      chats,
      mode: settings.mergeMode,
    })) as { ok: boolean; imported?: number; error?: string } | undefined;
    return resp?.ok
      ? ` Synced ${resp.imported ?? chats.length} to web app.`
      : ` Sync failed: ${resp?.error || "unknown error"}.`;
  } catch {
    return " Sync failed (open the web app tab, then retry).";
  }
}

/**
 * Run a full scroll-capture over a long-lived Port so the popup can show live
 * progress. Falls back to a one-shot message if the port can't be opened.
 */
function scrapeFullViaPort(
  tabId: number,
  opts: ScrapeOptions | undefined,
): Promise<{ ok: true; chat: Chat } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let port: ReturnType<typeof browser.tabs.connect>;
    try {
      port = browser.tabs.connect(tabId, { name: "scrape-full" });
    } catch {
      // Fall back to the request/response path.
      browser.tabs
        .sendMessage(tabId, { type: "SCRAPE_FULL_CHAT", opts })
        .then((r) => resolve(r as never))
        .catch((e) => resolve({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    let settled = false;
    port.onMessage.addListener((msg: { type: string; turns?: number; chat?: Chat; error?: string }) => {
      if (msg.type === "progress") {
        setStatus(`Scrolling… captured ${msg.turns ?? 0} turns`);
      } else if (msg.type === "done" && msg.chat) {
        settled = true;
        resolve({ ok: true, chat: msg.chat });
        port.disconnect();
      } else if (msg.type === "error") {
        settled = true;
        resolve({ ok: false, error: msg.error || "Scrape failed." });
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) resolve({ ok: false, error: "Lost connection to the page. Reload it and retry." });
    });
    port.postMessage({ type: "start", opts });
  });
}

async function runScrape(full: boolean) {
  setStatus(full ? "Scraping full chat (scrolling)…" : "Scraping visible turns…");
  scrapeBtn.disabled = true;
  scrapeFullBtn.disabled = true;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes("gemini.google.com")) {
      setStatus("Open a Gemini chat tab first.", "err");
      return;
    }

    let resp: { ok: true; chat: Chat } | { ok: false; error: string };
    if (full) {
      const s = await getSettings();
      const opts: ScrapeOptions = { scrollDelayMs: s.scrollDelayMs, maxIterations: s.maxIterations };
      resp = await scrapeFullViaPort(tab.id, opts);
    } else {
      resp = (await browser.tabs.sendMessage(tab.id, { type: "SCRAPE_CHAT" })) as typeof resp;
    }

    if (!resp?.ok) {
      setStatus(resp?.error || "Could not scrape this page.", "err");
      return;
    }
    const chats = await getChats();
    const existing = chats.findIndex((c) => c.id === resp.chat.id);
    if (existing >= 0) chats[existing] = resp.chat;
    else chats.push(resp.chat);
    await setChats(chats);
    await render();

    const base = `Saved “${resp.chat.title}” (${resp.chat.turns.length} Q&A)${existing >= 0 ? " — updated" : ""}.`;
    const syncMsg = await syncToWebapp([resp.chat]);
    setStatus(base + syncMsg, "ok");
  } catch (err) {
    setStatus(
      "Scrape failed. Reload the Gemini tab so the content script loads, then retry.",
      "err",
    );
    console.error(err);
  } finally {
    scrapeBtn.disabled = false;
    scrapeFullBtn.disabled = false;
  }
}

scrapeBtn.addEventListener("click", () => runScrape(false));
scrapeFullBtn.addEventListener("click", () => runScrape(true));
optionsBtn.addEventListener("click", () => browser.runtime.openOptionsPage());
webappBtn.addEventListener("click", async () => {
  const s = await getSettings();
  const origin = s.webappOrigin.replace(/\/+$/, "");
  await browser.tabs.create({ url: origin + "/", active: true });
});

exportEpubBtn.addEventListener("click", async () => {
  const chats = await getChats();
  if (!chats.length) return;
  setStatus("Building EPUB…");
  const blob = await buildEpub(chats, {
    title: chats.length === 1 ? chats[0]!.title : "Gemini Chats",
  });
  download(blob, chats.length === 1 ? `${slugify(chats[0]!.title)}.epub` : "gemini-chats.epub");
  setStatus("EPUB downloaded.", "ok");
});

exportMdBtn.addEventListener("click", async () => {
  const chats = await getChats();
  if (!chats.length) return;
  download(
    new Blob([chatsToMarkdown(chats)], { type: "text/markdown" }),
    chats.length === 1 ? `${slugify(chats[0]!.title)}.md` : "gemini-chats.md",
  );
  setStatus("Markdown downloaded.", "ok");
});

exportJsonBtn.addEventListener("click", async () => {
  const chats = await getChats();
  if (!chats.length) return;
  const payload: GeminiExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    chats,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  download(blob, "gemini-chats.json");
  setStatus("JSON downloaded — import it in the web app.", "ok");
});

syncAllBtn.addEventListener("click", async () => {
  const chats = await getChats();
  if (!chats.length) return;
  setStatus("Syncing all chats to the web app…");
  const msg = await syncToWebapp(chats, true);
  setStatus(("Sync requested." + msg).trim(), msg.includes("failed") || msg.includes("skipped") ? "err" : "ok");
});

clearBtn.addEventListener("click", async () => {
  await setChats([]);
  await render();
  setStatus("Collection cleared.");
});

render();
