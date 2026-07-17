// Popup controller.
//
// Detects which supported service the active tab is on (Gemini / Claude /
// ChatGPT), adapts the primary action + composer to it, captures the open chat
// as a *persisted* background job (so closing the popup never loses progress),
// opens the archive page, shows live job status from storage, and manages
// exports + web-app sync. All site-specific behaviour comes from the provider
// profiles in lib/providers.ts.

import type { Chat, ScrapeJob } from "@/lib/types";
import { exportEpub, exportMarkdown, exportJson } from "@/lib/exporters";
import { getSettings } from "@/lib/settings";
import { getChats, setChats } from "@/lib/chats-store";
import { getJobs, reconcileStalled } from "@/lib/jobs";
import { providerForUrl, providerById, sourceLabel, sourceAccent, type Provider, type ProviderId } from "@/lib/providers";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const primaryBtn = $<HTMLButtonElement>("primary");
const scrapeVisibleBtn = $<HTMLButtonElement>("scrape-visible");
const primaryHint = $<HTMLSpanElement>("primary-hint");
const statusEl = $<HTMLParagraphElement>("status");
const jobEl = $<HTMLDivElement>("job");
const listEl = $<HTMLUListElement>("list");
const countEl = $<HTMLSpanElement>("count");
const emptyEl = $<HTMLParagraphElement>("empty");
const bulkActions = $<HTMLDivElement>("bulk-actions");
const clearBtn = $<HTMLButtonElement>("clear");
const ctxEl = $<HTMLElement>("context");
const ctxTitle = $<HTMLDivElement>("ctx-title");
const ctxSub = $<HTMLDivElement>("ctx-sub");

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

// --- active-tab context ----------------------------------------------------

interface ActiveCtx {
  tabId: number;
  url: string;
  provider: Provider;
}

let active: ActiveCtx | null = null;
let activeChatId: string | undefined;
let activeChatUrl: string | undefined;
let preCount = 0;

async function activeTab(): Promise<{ id: number; url: string } | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return null;
  return { id: tab.id, url: tab.url };
}

function setSiteAccent(color: string) {
  document.documentElement.style.setProperty("--site", color);
}

const composerWrap = $<HTMLDetailsElement>("composer");
const composeProvider = $<HTMLSelectElement>("compose-provider");
const composeTarget = $<HTMLSelectElement>("compose-target");
const composeProviderLabel = composeProvider.closest("label") as HTMLLabelElement;
const composerTargetLabel = $<HTMLSpanElement>("composer-target-label");

async function refreshActiveContext(): Promise<void> {
  const tab = await activeTab();
  const provider = tab ? providerForUrl(tab.url) : null;

  if (!tab || !provider) {
    active = null;
    activeChatId = undefined;
    activeChatUrl = undefined;
    setSiteAccent("#9aa0a6");
    ctxEl.style.setProperty("--site", "#9aa0a6");
    ctxTitle.textContent = "Not on a supported chat";
    ctxSub.style.whiteSpace = "normal";
    ctxSub.innerHTML =
      '<span class="site-chips">' +
      '<button class="site-chip" data-site="https://gemini.google.com/app">Gemini</button>' +
      '<button class="site-chip" data-site="https://claude.ai/new">Claude</button>' +
      '<button class="site-chip" data-site="https://chatgpt.com/">ChatGPT</button>' +
      "</span>";
    ctxSub.querySelectorAll<HTMLButtonElement>(".site-chip").forEach((b) =>
      b.addEventListener("click", () => void browser.tabs.create({ url: b.dataset.site!, active: true })),
    );
    primaryBtn.textContent = "Open Archive";
    scrapeVisibleBtn.style.display = "none";
    primaryHint.textContent = "Browse everything you've saved";
    // Composer: pick a target service manually, always a new chat.
    composeProviderLabel.style.display = "";
    composeTarget.value = "new";
    updateComposerLabel();
    return;
  }

  active = { tabId: tab.id, url: tab.url, provider };
  setSiteAccent(provider.accent);
  scrapeVisibleBtn.style.display = "";
  primaryHint.textContent = "Runs in the background";
  composeProviderLabel.style.display = "none";
  composeProvider.value = provider.id;

  // Ask the content script for the open conversation's meta (id + title).
  let chatTitle = "";
  try {
    const resp = (await browser.tabs.sendMessage(tab.id, { type: "GET_META" })) as
      | { ok: true; meta: { id: string; title: string; url: string }; hasConversation?: boolean }
      | { ok: false }
      | undefined;
    if (resp && "ok" in resp && resp.ok) {
      activeChatId = resp.meta.id;
      activeChatUrl = resp.meta.url;
      chatTitle = resp.meta.title || "";
      const existing = (await getChats()).find((c) => c.id === activeChatId);
      preCount = existing?.turns.length ?? 0;
      primaryBtn.textContent = existing ? "Update this chat" : "Capture this chat";
    } else {
      activeChatId = undefined;
      activeChatUrl = tab.url;
      primaryBtn.textContent = "Capture this chat";
    }
  } catch {
    // Content script not loaded yet (page still booting).
    activeChatId = undefined;
    activeChatUrl = tab.url;
    primaryBtn.textContent = "Capture this chat";
  }

  ctxTitle.textContent = `${provider.glyph}  ${provider.label}`;
  ctxSub.style.whiteSpace = "nowrap";
  ctxSub.textContent = chatTitle || "Open a conversation to capture it";
  updateComposerLabel();
}

function updateComposerLabel(): void {
  const provId = (active?.provider.id ?? (composeProvider.value as ProviderId)) as ProviderId;
  const label = sourceLabel(provId);
  const target = composeTarget.value === "new" ? "new chat" : "current chat";
  composerTargetLabel.textContent = `→ ${label} · ${target}`;
  $<HTMLSpanElement>("compose-send-label").textContent = `Send to ${label}`;
}

// --- live job rendering ----------------------------------------------------

function jobPct(job: ScrapeJob): number {
  if (job.status !== "scraping") return 100;
  if (job.atTop) return 95;
  const t = Math.min(job.turns, 200);
  return Math.min(90, 8 + t * 0.6);
}

async function renderJob(): Promise<void> {
  const jobs = await getJobs();
  const activeJob = jobs.find((j) => j.status === "scraping");
  const recent = jobs.find((j) => j.status !== "scraping");
  const job = activeJob || recent;
  if (!job || (!activeJob && job.finishedAt && Date.now() - Date.parse(job.finishedAt) > 25_000)) {
    jobEl.hidden = true;
    return;
  }
  jobEl.hidden = false;
  const isErr = job.status === "error" || job.status === "canceled";
  jobEl.className = "job" + (isErr ? " err" : "");
  const delta = job.chatId === activeChatId && preCount > 0 ? job.turns - preCount : 0;
  const label = sourceLabel(job.source);
  const msg =
    job.status === "scraping"
      ? `Capturing… ${job.turns} turn${job.turns === 1 ? "" : "s"}${job.loading ? " · loading older" : job.atTop ? " · finishing" : ""}`
      : job.status === "done"
        ? `Captured ${job.turns} turn${job.turns === 1 ? "" : "s"}${delta > 0 ? ` · +${delta} new` : ""}`
        : job.error || "Capture interrupted";
  jobEl.innerHTML = `
    ${job.status === "scraping" ? '<div class="spin"></div>' : isErr ? "✕" : "✓"}
    <div class="grow">
      <div class="jt" title="${escapeAttr(job.title)}">${escapeHtml(job.title || `${label} chat`)}</div>
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

function sourceBadge(source: ProviderId | undefined): string {
  const id = (source || "gemini") as ProviderId;
  const label = sourceLabel(id);
  const color = sourceAccent(id);
  const glyph = providerById(id)?.glyph ?? "";
  return `<span class="src-badge" style="color:${color};border-color:${color}55">${escapeHtml(glyph)} ${escapeHtml(label)}</span>`;
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
        <div class="title" data-open="${escapeAttr(chat.id)}" title="${escapeAttr(chat.title)}">${escapeHtml(chat.title)}</div>
        <div class="turns">${sourceBadge(chat.source)}<span>${chat.turns.length} Q&A · ${chat.scrapedAt.slice(0, 10)}</span></div>
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

// --- capture ---------------------------------------------------------------

async function startCapture(): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  if (!active) return { ok: false, error: "unsupported" };
  const s = await getSettings();
  try {
    const resp = (await browser.tabs.sendMessage(active.tabId, {
      type: "START_SCRAPE",
      opts: { scrollDelayMs: s.scrollDelayMs, maxIterations: s.maxIterations },
    })) as { ok: boolean; jobId?: string; chatId?: string; error?: string } | undefined;
    if (!resp?.ok) return { ok: false, error: resp?.error || "Could not start the capture." };
    return { ok: true, chatId: resp.chatId };
  } catch {
    return { ok: false, error: `Reload the ${active.provider.label} tab so the content script loads, then retry.` };
  }
}

primaryBtn.addEventListener("click", async () => {
  if (!active) {
    await openArchive("#/search");
    return;
  }
  setStatus("Starting capture…");
  const res = await startCapture();
  if (!res.ok) {
    setStatus(res.error || "Could not start.", "err");
    return;
  }
  await renderJob();
  setStatus(`Capturing ${active.provider.label} in the background — opening Archive…`, "ok");
  await openArchive(res.chatId ? `#/chat/${encodeURIComponent(res.chatId)}` : "#/search");
});

scrapeVisibleBtn.addEventListener("click", async () => {
  if (!active) return;
  scrapeVisibleBtn.disabled = true;
  setStatus("Capturing visible turns…");
  try {
    const resp = (await browser.tabs.sendMessage(active.tabId, { type: "SCRAPE_CHAT" })) as
      | { ok: true; chat: Chat }
      | { ok: false; error: string }
      | undefined;
    if (!resp?.ok) {
      setStatus(resp?.error || "Could not capture this page.", "err");
      return;
    }
    await render();
    const sync = await syncToWebapp([resp.chat]);
    setStatus(`Saved “${resp.chat.title}” (${resp.chat.turns.length} Q&A).` + sync, "ok");
  } catch {
    setStatus(`Reload the ${active.provider.label} tab so the content script loads, then retry.`, "err");
  } finally {
    scrapeVisibleBtn.disabled = false;
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

// --- composer: send a message ----------------------------------------------

const composeText = $<HTMLTextAreaElement>("compose-text");
const composeSend = $<HTMLButtonElement>("compose-send");

composeTarget.addEventListener("change", updateComposerLabel);
composeProvider.addEventListener("change", updateComposerLabel);

async function sendComposed(): Promise<void> {
  const text = composeText.value.trim();
  if (!text) {
    composeText.focus();
    return;
  }
  composeSend.disabled = true;
  const provId = (active?.provider.id ?? (composeProvider.value as ProviderId)) as ProviderId;
  const label = sourceLabel(provId);
  setStatus(`Sending to ${label}…`);
  try {
    const wantNew = composeTarget.value === "new" || !active;
    const res = (await browser.runtime.sendMessage({
      type: "SEND_TO_CHAT",
      provider: provId,
      text,
      convId: wantNew ? undefined : activeChatId,
      url: wantNew ? undefined : activeChatUrl,
    })) as { ok: boolean; error?: string } | undefined;
    if (res?.ok) {
      composeText.value = "";
      setStatus(`Sent. ${label} is answering — it'll be mirrored into your archive.`, "ok");
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
$<HTMLButtonElement>("open-archive-top").addEventListener("click", () => void openArchive("#/search"));
$<HTMLButtonElement>("open-options").addEventListener("click", () => void openArchive("#/settings"));
$<HTMLButtonElement>("open-webapp").addEventListener("click", async () => {
  const s = await getSettings();
  await browser.tabs.create({ url: s.webappOrigin.replace(/\/+$/, "") + "/", active: true });
});

// Live updates while the popup is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.collected_chats) {
    void render();
    void refreshActiveContext();
  }
  if (changes.scrape_jobs) void renderJob();
});

void reconcileStalled();
void render();
void refreshActiveContext().then(renderJob);
void renderJob();
