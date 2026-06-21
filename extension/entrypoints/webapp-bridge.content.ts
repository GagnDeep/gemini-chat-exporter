// Bridge content script, injected into the companion web app's origin.
//
// IndexedDB is origin-partitioned, so the extension cannot write the web app's
// GeminiChatArchive database directly. Sanctioned path:
//   popup/background  --runtime msg-->  this content script
//                     --window.postMessage-->  web app page listener  -->  importChats()
//
// Keep `matches` in sync with host_permissions in wxt.config.ts.

const EXTENSION_SOURCE = "gemini-exporter-extension";
const PAGE_SOURCE = "gemini-exporter-webapp";

export default defineContentScript({
  matches: ["http://localhost:3000/*"],
  main() {
    browser.runtime.onMessage.addListener(
      (
        message: { type?: string; chats?: unknown; mode?: "merge" | "replace" },
        _sender,
        sendResponse,
      ) => {
        if (message?.type !== "SYNC_TO_WEBAPP") return;

        // Wait for the web app page to acknowledge the import, then relay the
        // result back to the extension.
        const onAck = (event: MessageEvent) => {
          if (event.source !== window) return;
          if (event.origin !== location.origin) return;
          const data = event.data;
          if (!data || data.source !== PAGE_SOURCE || data.type !== "IMPORT_ACK") return;
          window.removeEventListener("message", onAck);
          clearTimeout(timer);
          sendResponse(
            data.ok
              ? { ok: true, imported: data.imported ?? 0 }
              : { ok: false, error: data.error || "Web app rejected the import." },
          );
        };

        const timer = setTimeout(() => {
          window.removeEventListener("message", onAck);
          sendResponse({
            ok: false,
            error: "Web app did not respond. Make sure the archive page is open and up to date.",
          });
        }, 15_000);

        window.addEventListener("message", onAck);

        window.postMessage(
          {
            source: EXTENSION_SOURCE,
            type: "IMPORT_CHATS",
            payload: message.chats,
            mode: message.mode === "replace" ? "replace" : "merge",
          },
          location.origin,
        );

        // Keep the message channel open for the async sendResponse above.
        return true;
      },
    );
  },
});
