// Popup controller. Captures the active Gemini tab as a *persisted* background
// job (so closing the popup never loses progress), opens the Gemini-style
// archive page (optionally deep-linked to the current chat), shows live job
// status from storage, and manages exports + web-app sync.

import type { Chat, ScrapeJob } from "@/lib/types";
import { exportEpub, exportMarkdown, exportJson } from "@/lib/exporters";
import { getSettings } from "@/lib/settings";
import { getChats, setChats } from "@/lib/chats-store";
import { getJobs, reconcileStalled } from "@/lib/jobs";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const openArchiveChatBtn = $<HTMLButtonElement>("open-archive-chat");
const scrapeBtn = $<HTMLButtonElement>("scrape");
const scrapeFullBtn = $<HTMLButtonElement>("scrape-full");
const statusEl = $<HTMLParagraphElement>("status");
const jobEl = $<HTMLDivElement>("job");
const listEl = $<HTMLUListElement>("list");
const countEl = $<HTMLSpanElement>("count");
const emptyEl = $<HTMLParagraphElement>("empty");
const bulkActions = $<HTMLDivElement>("bulk-actions");
const clearBtn = $<HTMLButtonElement>("clear");

function setStatus(msg: string, kind: "" | "ok" | "err" = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// --- archive page helpers --------------------------------------------------

function archiveUrl(hash = ""): string {
  return browser.runtime.getURL("/options.html") + (hash || "");
}

async function openArchive(hash = ""): Promise<void> {
  const base = browser.runtime.getURL("/options.html");
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(base));
  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { active: true, url: archiveUrl(hash) });
    if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: archiveUrl(hash), active: true });
  }
}

// --- live job rendering ----------------------------------------------------

function jobPct(job: ScrapeJob): number {
  if (job.status !== "scraping") return 100;
  if (job.atTop) return 95;
  const t = Math.min(job.turns, 200);
  return Math.min(90, 8 + t * 0.6);
}

// Active-tab context, used to label the primary button + show capture deltas.
let activeChatId: string | undefined;
let preCount = 0;

async function refreshActiveContext(): Promise<void> {
  const tab = await activeGeminiTab();
  if (!tab) { activeChatId = undefined; openArchiveChatBtn.textContent = "Open Archive"; return; }
  try {
    const resp = (await browser.tabs.sendMessage(tab.id, { type: "GET_META" })) as
      | { ok: true; meta: { id: string; title: string } } | { ok: false } | undefined;
    if (resp && "ok" in resp && resp.ok) {
      activeChatId = resp.meta.id;
      const existing = (await getChats()).find((c) => c.id === activeChatId);
      preCount = existing?.turns.length ?? 0;
      openArchiveChatBtn.textContent = existing ? "Update this chat in Archive" : "Open this chat in Archive";
      scrapeFullBtn.textContent = existing ? "Update full chat" : "Capture full chat";
      return;
    }
  } catch {
    /* content script not loaded yet */
  }
  openArchiveChatBtn.textContent = "Open this chat in Archive";
}

async function renderJob(): Promise<void> {
  const jobs = await getJobs();
  const active = jobs.find((j) => j.status === "scraping");
  const recent = jobs.find((j) => j.status !== "scraping");
  const job = active || recent;
  if (!job || (!active && job.finishedAt && Date.now() - Date.parse(job.finishedAt) > 25_000)) {
    jobEl.hidden = true;
    return;
  }
  jobEl.hidden = false;
  const isErr = job.status === "error" || job.status === "canceled";
  jobEl.className = "job" + (isErr ? " err" : "");
  const delta = job.chatId === activeChatId && preCount > 0 ? job.turns - preCount : 0;
  const msg =
    job.status === "scraping"
      ? `Capturing… ${job.turns} turn${job.turns === 1 ? "" : "s"}${job.loading ? " · loading older" : job.atTop ? " · finishing" : ""}`
      : job.status === "done"
        ? `Captured ${job.turns} turn${job.turns === 1 ? "" : "s"}${delta > 0 ? ` · +${delta} new` : ""}`
        : job.error || "Capture interrupted";
  jobEl.innerHTML = `
    ${job.status === "scraping" ? '<div class="spin"></div>' : isErr ? "✕" : "✓"}
    <div class="grow">
      <div class="jt" title="${escapeAttr(job.title)}">${escapeHtml(job.title || "Gemini chat")}</div>
      <div class="jm">${escapeHtml(msg)}</div>
      ${job.status === "scraping" ? `<div class="track"><div class="fill" style="width:${jobPct(job)}%"></div></div>` : ""}
    </div>
    ${job.status === "done" ? `<button class="view" data-chat="${escapeAttr(job.chatId)}">Open</button>` : ""}
  `;
  jobEl.querySelector<HTMLButtonElement>("button.view")?.addEventListener("click", (e) => {
    const id = (e.currentTarget as HTMLButtonElement).dataset.chat!;
    void openArchive(`#/chat/${encodeURIComponent(id)}`);
  });
}

// --- collection list -------------------------------------------------------

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
        <div class="title" data-open="${escapeAttr(chat.id)}" title="${escapeAttr(chat.title)}">${escapeHtml(chat.title)}</div>
        <div class="turns">${chat.turns.length} Q&A · ${chat.scrapedAt.slice(0, 10)}</div>
      </div>
      <button class="epub" data-i="${i}" title="Export EPUB">EPUB</button>
      <button class="md" data-i="${i}" title="Export Markdown">MD</button>
      <button class="remove" data-i="${i}" title="Remove">✕</button>`;
    listEl.appendChild(li);
  });

  listEl.querySelectorAll<HTMLElement>(".title[data-open]").forEach((el) =>
    el.addEventListener("click", () => void openArchive(`#/chat/${encodeURIComponent(el.dataset.open!)}`)),
  );

  listEl.querySelectorAll<HTMLButtonElement>("button.epub").forEach((b) =>
    b.addEventListener("click", async () => {
      const chat = (await getChats())[Number(b.dataset.i)];
      if (!chat) return;
      setStatus("Building EPUB…");
      await exportEpub([chat]);
      setStatus("EPUB downloaded.", "ok");
    }),
  );

  listEl.querySelectorAll<HTMLButtonElement>("button.md").forEach((b) =>
    b.addEventListener("click", async () => {
      const chat = (await getChats())[Number(b.dataset.i)];
      if (!chat) return;
      exportMarkdown([chat]);
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

// --- web app sync ----------------------------------------------------------

async function getWebappTab(origin: string): Promise<{ id?: number } | undefined> {
  let [tab] = await browser.tabs.query({ url: `${origin}/*` });
  if (!tab?.id) {
    tab = await browser.tabs.create({ url: origin + "/", active: false });
    await new Promise((r) => setTimeout(r, 1500));
  }
  return tab;
}

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
    return resp?.ok ? ` Synced ${resp.imported ?? chats.length} to web app.` : ` Sync failed: ${resp?.error || "unknown error"}.`;
  } catch {
    return " Sync failed (open the web app tab, then retry).";
  }
}

// --- actions ---------------------------------------------------------------

async function activeGeminiTab(): Promise<{ id: number; url: string } | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("gemini.google.com")) return null;
  return { id: tab.id, url: tab.url };
}

/** Start a persisted background capture in the active Gemini tab. */
async function startCapture(): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  const tab = await activeGeminiTab();
  if (!tab) return { ok: false, error: "Open a Gemini chat tab first." };
  const s = await getSettings();
  try {
    const resp = (await browser.tabs.sendMessage(tab.id, {
      type: "START_SCRAPE",
      opts: { scrollDelayMs: s.scrollDelayMs, maxIterations: s.maxIterations },
    })) as { ok: boolean; jobId?: string; chatId?: string; error?: string } | undefined;
    if (!resp?.ok) return { ok: false, error: resp?.error || "Could not start the capture." };
    return { ok: true, chatId: resp.chatId };
  } catch {
    return { ok: false, error: "Reload the Gemini tab so the content script loads, then retry." };
  }
}

openArchiveChatBtn.addEventListener("click", async () => {
  setStatus("Starting capture…");
  const res = await startCapture();
  if (!res.ok) {
    // Not on a Gemini tab (or failed) — still open the archive so the user can browse.
    if (res.error?.includes("Gemini")) {
      setStatus("Opening Archive…");
      await openArchive("#/search");
      return;
    }
    setStatus(res.error || "Could not start.", "err");
    return;
  }
  await renderJob();
  setStatus("Capturing in the background — opening Archive…", "ok");
  await openArchive(res.chatId ? `#/chat/${encodeURIComponent(res.chatId)}` : "#/search");
});

scrapeFullBtn.addEventListener("click", async () => {
  scrapeFullBtn.disabled = true;
  setStatus("Starting background capture…");
  const res = await startCapture();
  setStatus(res.ok ? "Capturing in the background. You can close this popup." : res.error || "Failed.", res.ok ? "ok" : "err");
  await renderJob();
  scrapeFullBtn.disabled = false;
});

scrapeBtn.addEventListener("click", async () => {
  scrapeBtn.disabled = true;
  setStatus("Capturing visible turns…");
  try {
    const tab = await activeGeminiTab();
    if (!tab) { setStatus("Open a Gemini chat tab first.", "err"); return; }
    const resp = (await browser.tabs.sendMessage(tab.id, { type: "SCRAPE_CHAT" })) as
      | { ok: true; chat: Chat } | { ok: false; error: string } | undefined;
    if (!resp?.ok) { setStatus(resp?.error || "Could not capture this page.", "err"); return; }
    await render();
    const sync = await syncToWebapp([resp.chat]);
    setStatus(`Saved “${resp.chat.title}” (${resp.chat.turns.length} Q&A).` + sync, "ok");
  } catch {
    setStatus("Reload the Gemini tab so the content script loads, then retry.", "err");
  } finally {
    scrapeBtn.disabled = false;
  }
});

$<HTMLButtonElement>("export-epub").addEventListener("click", async () => {
  const chats = await getChats();
  if (!chats.length) return;
  setStatus("Building EPUB…");
  await exportEpub(chats);
  setStatus("EPUB downloaded.", "ok");
});

$<HTMLButtonElement>("export-md").addEventListener("click", async () => {
  const chats = await getChats();
  if (!chats.length) return;
  exportMarkdown(chats);
  setStatus("Markdown downloaded.", "ok");
});

$<HTMLButtonElement>("export-json").addEventListener("click", async () => {
  const chats = await getChats();
  if (!chats.length) return;
  exportJson(chats);
  setStatus("JSON downloaded — import it in the web app or Archive.", "ok");
});

$<HTMLButtonElement>("sync-all").addEventListener("click", async () => {
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

// --- composer: send a new message into Gemini ------------------------------

const composeText = $<HTMLTextAreaElement>("compose-text");
const composeSend = $<HTMLButtonElement>("compose-send");
const composeTarget = $<HTMLSelectElement>("compose-target");

async function sendComposed(): Promise<void> {
  const text = composeText.value.trim();
  if (!text) { composeText.focus(); return; }
  composeSend.disabled = true;
  setStatus("Sending to Gemini…");
  try {
    // "current" continues the active chat when we're on one (or the most recent
    // Gemini tab); "new" always opens a fresh conversation.
    const wantNew = composeTarget.value === "new";
    const tab = await activeGeminiTab();
    let convId: string | undefined;
    let url: string | undefined = "https://gemini.google.com/app";
    if (!wantNew && tab) {
      try {
        const resp = (await browser.tabs.sendMessage(tab.id, { type: "GET_META" })) as
          | { ok: true; meta: { id: string; url: string } } | { ok: false } | undefined;
        if (resp && "ok" in resp && resp.ok) { convId = resp.meta.id; url = resp.meta.url; }
      } catch { /* content script not ready; fall back to a new chat */ }
    }
    const res = (await browser.runtime.sendMessage({
      type: "SEND_TO_GEMINI",
      text,
      convId: wantNew ? undefined : convId,
      url: wantNew ? "https://gemini.google.com/app" : url,
    })) as { ok: boolean; error?: string } | undefined;
    if (res?.ok) {
      composeText.value = "";
      setStatus("Sent. Gemini is answering — it'll be mirrored into your archive.", "ok");
    } else {
      setStatus(res?.error || "Couldn't send the message.", "err");
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "Couldn't send the message.", "err");
  } finally {
    composeSend.disabled = false;
  }
}

composeSend.addEventListener("click", () => void sendComposed());
composeText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendComposed();
  }
});

$<HTMLButtonElement>("open-archive").addEventListener("click", () => void openArchive("#/search"));
$<HTMLButtonElement>("open-options").addEventListener("click", () => void openArchive("#/settings"));
$<HTMLButtonElement>("open-webapp").addEventListener("click", async () => {
  const s = await getSettings();
  await browser.tabs.create({ url: s.webappOrigin.replace(/\/+$/, "") + "/", active: true });
});

// Live updates while the popup is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.collected_chats) { void render(); void refreshActiveContext(); }
  if (changes.scrape_jobs) void renderJob();
});

void reconcileStalled();
void render();
void refreshActiveContext().then(renderJob);
void renderJob();
