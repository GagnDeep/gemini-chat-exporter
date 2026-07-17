// Shared content-script runtime.
//
// This is the body every per-site content script installs. It OWNS the capture
// lifecycle and persists everything itself, so a scrape is never lost when the
// popup closes or the service worker is evicted:
//
//   • progress       -> written (throttled) to the `scrape_jobs` registry
//   • partial result -> committed (throttled) to `collected_chats`
//   • final result   -> committed to `collected_chats`, job marked done
//
// It is provider-driven (Gemini / Claude / ChatGPT). The only site-specific hook
// is an optional `rpcFullCapture` — Gemini can pull full history via its own
// authenticated RPC (fast, no scrolling); the other sites use the generic
// auto-scroll capture engine.

import {
  scrapeCurrentChat,
  scrapeFullChat,
  hasConversation,
  isGenerating,
  getConversationMeta,
  type ScrapeOptions,
} from "./scraper";
import type { Chat } from "./types";
import { commitChat } from "./chats-store";
import { startJob, updateJob, finishJob } from "./jobs";
import { submitPrompt } from "./compose";
import { startLiveRecorder } from "./live-recorder";
import type { Provider } from "./providers";

type ProgressInfo = { turns: number; iteration: number; atTop: boolean; loading: boolean };

export interface ContentRuntimeOptions {
  /** Optional fast full-capture path (Gemini RPC). Falls back to scrolling on throw. */
  rpcFullCapture?: (hooks: {
    onProgress: (info: ProgressInfo) => void;
    onSnapshot: (chat: Chat) => void;
  }) => Promise<Chat>;
}

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

export function installContentRuntime(provider: Provider, opts: ContentRuntimeOptions = {}): void {
  async function runFullCapture(
    scrapeOpts: ScrapeOptions | undefined,
    onProgress: (info: ProgressInfo) => void,
    onSnapshot: (chat: Chat) => void,
  ): Promise<Chat> {
    if (opts.rpcFullCapture) {
      try {
        return await opts.rpcFullCapture({ onProgress, onSnapshot });
      } catch {
        // RPC unavailable / shape changed — fall through to the scroll scraper.
      }
    }
    return scrapeFullChat({ ...scrapeOpts, provider, onProgress, onSnapshot });
  }

  function preflightError(): string | null {
    if (!hasConversation(provider)) {
      return `No open conversation found. Open a ${provider.label} chat, then try again.`;
    }
    if (isGenerating(provider)) {
      return `${provider.label} is still generating a response. Wait for it to finish, then retry.`;
    }
    return null;
  }

  /** Only one persisted capture per tab at a time. */
  let activeJobId: string | null = null;

  async function beginJob(
    scrapeOpts: ScrapeOptions | undefined,
  ): Promise<{ ok: true; jobId: string; chatId: string } | { ok: false; error: string }> {
    const err = preflightError();
    if (err) return { ok: false, error: err };
    if (activeJobId) return { ok: false, error: "A capture is already running in this tab." };

    const meta = getConversationMeta(provider);
    const jobId = `job-${meta.id}-${Date.now()}`;
    activeJobId = jobId;

    let tabId: number | undefined;
    try {
      tabId = (await browser.runtime.sendMessage({ type: "WHICH_TAB" }))?.tabId;
    } catch {
      /* background may be asleep; tabId is best-effort only */
    }

    await startJob({ id: jobId, chatId: meta.id, title: meta.title, url: meta.url, tabId, source: provider.id });

    const writeProgress = throttle((info: ProgressInfo) => {
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
        const chat = await runFullCapture(scrapeOpts, writeProgress, commitSnapshot);
        const stored = await commitChat(chat, "merge");
        await finishJob(jobId, "done", { chatId: stored.id, title: stored.title, turns: stored.turns.length });
      } catch (e) {
        await finishJob(jobId, "error", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (activeJobId === jobId) activeJobId = null;
      }
    })();

    return { ok: true, jobId, chatId: meta.id };
  }

  // Start live-mirroring new turns into the archive as the user chats. Gated
  // internally by the `autoMirror` setting; entirely read-only + best-effort.
  startLiveRecorder(provider);

  // If the user navigates away mid-capture, flag the job as interrupted.
  window.addEventListener("pagehide", () => {
    if (activeJobId) {
      void finishJob(activeJobId, "canceled", {
        error: "Interrupted — navigated away before the capture finished.",
      });
    }
  });

  browser.runtime.onMessage.addListener(
    (message: { type?: string; opts?: ScrapeOptions; text?: string }, _sender, sendResponse) => {
      if (message?.type === "SEND_PROMPT") {
        submitPrompt(message.text ?? "", provider)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        return true; // async
      }

      if (message?.type === "SCRAPE_CHAT") {
        try {
          if (!hasConversation(provider)) {
            sendResponse({ ok: false, error: `No open conversation found. Open a ${provider.label} chat, then try again.` });
            return;
          }
          const chat = scrapeCurrentChat(provider);
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
          sendResponse({ ok: true, meta: getConversationMeta(provider), hasConversation: hasConversation(provider) });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return; // synchronous
      }

      return false;
    },
  );
}
