// Content script injected into Gemini pages. Listens for a scrape request from
// the popup and returns the structured conversation.
//
// Two channels:
//   • runtime message (SCRAPE_CHAT / SCRAPE_FULL_CHAT) — request/response.
//   • a long-lived Port ("scrape-full") — streams live progress while a full
//     scroll-capture runs, then delivers the final chat.

import {
  scrapeCurrentChat,
  scrapeFullChat,
  hasConversation,
  isGenerating,
  type ScrapeOptions,
} from "@/lib/scraper";

function preflightError(): string | null {
  if (!hasConversation()) {
    return "No open conversation found. Open a Gemini chat, then try again.";
  }
  if (isGenerating()) {
    return "Gemini is still generating a response. Wait for it to finish, then retry.";
  }
  return null;
}

export default defineContentScript({
  matches: ["https://gemini.google.com/*"],
  main() {
    browser.runtime.onMessage.addListener(
      (
        message: { type?: string; opts?: ScrapeOptions },
        _sender,
        sendResponse,
      ) => {
        if (message?.type === "SCRAPE_CHAT") {
          try {
            if (!hasConversation()) {
              sendResponse({
                ok: false,
                error: "No open conversation found. Open a Gemini chat, then try again.",
              });
              return;
            }
            sendResponse({ ok: true, chat: scrapeCurrentChat() });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        } else if (message?.type === "SCRAPE_FULL_CHAT") {
          const err = preflightError();
          if (err) {
            sendResponse({ ok: false, error: err });
          } else {
            // Async: the listener returns true below to keep the channel open.
            scrapeFullChat(message.opts)
              .then((chat) => sendResponse({ ok: true, chat }))
              .catch((e) =>
                sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
              );
          }
        }
        // Returning true keeps the message channel open for the async response.
        return true;
      },
    );

    // Port-based full scrape with live progress.
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== "scrape-full") return;
      port.onMessage.addListener((msg: { type?: string; opts?: ScrapeOptions }) => {
        if (msg?.type !== "start") return;
        const err = preflightError();
        if (err) {
          port.postMessage({ type: "error", error: err });
          return;
        }
        const opts: ScrapeOptions = {
          ...msg.opts,
          onProgress: (info) => {
            try {
              port.postMessage({ type: "progress", ...info });
            } catch {
              /* port closed (popup dismissed) — scrape continues regardless */
            }
          },
        };
        scrapeFullChat(opts)
          .then((chat) => port.postMessage({ type: "done", chat }))
          .catch((e) =>
            port.postMessage({ type: "error", error: e instanceof Error ? e.message : String(e) }),
          );
      });
    });
  },
});
