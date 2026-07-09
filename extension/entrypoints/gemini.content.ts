// Content script injected into Gemini pages.
//
// It OWNS the capture lifecycle and persists everything itself, so a scrape is
// never lost when the popup closes or the service worker is evicted:
//
//   • progress      -> written (throttled) to the `scrape_jobs` registry
//   • partial result-> committed (throttled) to `collected_chats`
//   • final result  -> committed to `collected_chats`, job marked done
//
// Channels:
//   • runtime message SCRAPE_CHAT          — synchronous visible-turns scrape
//   • runtime message START_SCRAPE         — begins a persisted background job,
//                                            returns { ok, jobId } immediately
//   • runtime message SCRAPE_FULL_CHAT     — legacy: awaits and returns the chat
//   • port "scrape-full"                   — legacy live-progress stream

import {
  scrapeCurrentChat,
  scrapeFullChat,
  hasConversation,
  isGenerating,
  getConversationMeta,
  type ScrapeOptions,
} from "@/lib/scraper";
import type { Chat, ScrapeJob } from "@/lib/types";
import { commitChat } from "@/lib/chats-store";
import { startJob, updateJob, finishJob } from "@/lib/jobs";
import { submitPrompt } from "@/lib/compose";
import { scrapeFullChatViaRpc } from "@/lib/gemini-rpc";
import { getSettings } from "@/lib/settings";
import { startLiveRecorder } from "@/lib/live-recorder";

/**
 * Run a full-history capture using the fast RPC path when enabled + available,
 * falling back to the auto-scroll scraper otherwise (or if the RPC throws). The
 * two loaders are normalized to the same onProgress/onSnapshot contract so the
 * job machinery doesn't care which one ran.
 */
async function runFullCapture(
  opts: ScrapeOptions | undefined,
  onProgress: (info: { turns: number; iteration: number; atTop: boolean; loading: boolean }) => void,
  onSnapshot: (chat: Chat) => void,
): Promise<Chat> {
  const settings = await getSettings();

  if (settings.useRpcLoader) {
    try {
      // scrapeFullChatViaRpc pings the main-world bridge first and throws if the
      // RPC path isn't usable, so this cleanly falls through to scrolling.
      return await scrapeFullChatViaRpc({
        pageSize: settings.historyPageSize,
        onProgress: (i) => onProgress({ turns: i.turns, iteration: i.page, atTop: i.done, loading: !i.done }),
        onSnapshot,
      });
    } catch {
      // RPC unavailable / shape changed — fall through to the scroll scraper so a
      // capture still succeeds.
    }
  }

  return scrapeFullChat({ ...opts, onProgress, onSnapshot });
}

function preflightError(): string | null {
  if (!hasConversation()) {
    return "No open conversation found. Open a Gemini chat, then try again.";
  }
  if (isGenerating()) {
    return "Gemini is still generating a response. Wait for it to finish, then retry.";
  }
  return null;
}

/** Only one persisted capture per tab at a time. */
let activeJobId: string | null = null;

/** Throttle helper so storage isn't hammered on every progress tick. */
function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0;
  let pending: number | null = null;
  let lastArgs = [] as unknown as A;
  const run = () => {
    last = Date.now();
    pending = null;
    fn(...lastArgs);
  };
  return (...args: A) => {
    lastArgs = args;
    const now = Date.now();
    if (now - last >= ms) run();
    else if (pending == null) pending = window.setTimeout(run, ms - (now - last));
  };
}

/**
 * Run a full, persisted capture as a background job. Resolves with the job id
 * as soon as the job record exists; the actual capture continues detached and
 * keeps writing to storage until it finishes.
 */
async function beginJob(
  opts: ScrapeOptions | undefined,
): Promise<{ ok: true; jobId: string; chatId: string } | { ok: false; error: string }> {
  const err = preflightError();
  if (err) return { ok: false, error: err };
  if (activeJobId) return { ok: false, error: "A capture is already running in this tab." };

  const meta = getConversationMeta();
  const jobId = `job-${meta.id}-${Date.now()}`;
  activeJobId = jobId;

  let tabId: number | undefined;
  try {
    tabId = (await browser.runtime.sendMessage({ type: "WHICH_TAB" }))?.tabId;
  } catch {
    /* background may be asleep; tabId is best-effort only */
  }

  await startJob({ id: jobId, chatId: meta.id, title: meta.title, url: meta.url, tabId });

  const writeProgress = throttle((info: Parameters<NonNullable<ScrapeOptions["onProgress"]>>[0]) => {
    void updateJob(jobId, {
      turns: info.turns,
      iteration: info.iteration,
      atTop: info.atTop,
      loading: info.loading,
      status: "scraping",
    });
  }, 700);

  const commitSnapshot = throttle((chat: Chat) => {
    void commitChat(chat, "merge");
  }, 1500);

  // Detached: keep capturing + persisting regardless of who is listening.
  (async () => {
    try {
      const chat = await runFullCapture(opts, writeProgress, commitSnapshot);
      const stored = await commitChat(chat, "merge");
      await finishJob(jobId, "done", {
        chatId: stored.id,
        title: stored.title,
        turns: stored.turns.length,
      });
    } catch (e) {
      await finishJob(jobId, "error", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (activeJobId === jobId) activeJobId = null;
    }
  })();

  return { ok: true, jobId, chatId: meta.id };
}

export default defineContentScript({
  matches: ["https://gemini.google.com/*"],
  main() {
    // Start live-mirroring new turns into the archive as the user chats. Gated
    // internally by the `autoMirror` setting; entirely read-only + best-effort.
    startLiveRecorder();

    // If the user navigates away mid-capture, flag the job as interrupted so the
    // UI doesn't show a phantom spinner. (Best-effort: storage writes from an
    // unloading page can be dropped; the stall reconciler is the backstop.)
    window.addEventListener("pagehide", () => {
      if (activeJobId) {
        void finishJob(activeJobId, "canceled", {
          error: "Interrupted — navigated away before the capture finished.",
        });
      }
    });

    browser.runtime.onMessage.addListener(
      (
        message: { type?: string; opts?: ScrapeOptions; text?: string },
        _sender,
        sendResponse,
      ) => {
        if (message?.type === "SEND_PROMPT") {
          submitPrompt(message.text ?? "")
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
          return true; // async
        }

        if (message?.type === "SCRAPE_CHAT") {
          try {
            if (!hasConversation()) {
              sendResponse({
                ok: false,
                error: "No open conversation found. Open a Gemini chat, then try again.",
              });
              return;
            }
            const chat = scrapeCurrentChat();
            void commitChat(chat, "merge");
            sendResponse({ ok: true, chat });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return; // synchronous
        }

        if (message?.type === "START_SCRAPE") {
          beginJob(message.opts).then(sendResponse);
          return true; // async
        }

        if (message?.type === "GET_META") {
          try {
            sendResponse({ ok: true, meta: getConversationMeta(), hasConversation: hasConversation() });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return; // synchronous
        }

        if (message?.type === "SCRAPE_FULL_CHAT") {
          // Legacy await-the-result path (kept for the popup's fallback).
          const err = preflightError();
          if (err) {
            sendResponse({ ok: false, error: err });
          } else {
            scrapeFullChat(message.opts)
              .then((chat) => {
                void commitChat(chat, "merge");
                sendResponse({ ok: true, chat });
              })
              .catch((e) =>
                sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
              );
          }
          return true; // async
        }

        return false;
      },
    );

    // Port-based full scrape with live progress (legacy popup path). Persistence
    // is handled the same way as a background job so closing the popup is safe.
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== "scrape-full") return;
      port.onMessage.addListener((msg: { type?: string; opts?: ScrapeOptions }) => {
        if (msg?.type !== "start") return;
        const err = preflightError();
        if (err) {
          try { port.postMessage({ type: "error", error: err }); } catch { /* closed */ }
          return;
        }
        const meta = getConversationMeta();
        const jobId = `job-${meta.id}-${Date.now()}`;
        void startJob({ id: jobId, chatId: meta.id, title: meta.title, url: meta.url });
        const writeProgress = throttle((info: Parameters<NonNullable<ScrapeOptions["onProgress"]>>[0]) => {
          void updateJob(jobId, { turns: info.turns, iteration: info.iteration, atTop: info.atTop, loading: info.loading });
        }, 700);
        const commitSnapshot = throttle((chat: Chat) => void commitChat(chat, "merge"), 1500);

        const opts: ScrapeOptions = {
          ...msg.opts,
          onProgress: (info) => {
            writeProgress(info);
            try { port.postMessage({ type: "progress", ...info }); } catch { /* popup closed */ }
          },
          onSnapshot: commitSnapshot,
        };
        scrapeFullChat(opts)
          .then(async (chat) => {
            const stored = await commitChat(chat, "merge");
            await finishJob(jobId, "done", { chatId: stored.id, title: stored.title, turns: stored.turns.length });
            try { port.postMessage({ type: "done", chat: stored }); } catch { /* popup closed — already persisted */ }
          })
          .catch(async (e) => {
            const error = e instanceof Error ? e.message : String(e);
            await finishJob(jobId, "error", { error });
            try { port.postMessage({ type: "error", error }); } catch { /* closed */ }
          });
      });
    });
  },
});

export type { ScrapeJob };
