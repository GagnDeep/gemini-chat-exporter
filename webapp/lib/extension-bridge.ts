// Receiver for chats pushed from the browser extension.
//
// The extension's bridge content script (running on this same origin) relays a
// scraped conversation via window.postMessage; this listener validates the
// message, imports the chats into IndexedDB, and posts an acknowledgement back.
// IndexedDB is origin-partitioned, so this same-origin hop is the sanctioned
// way for the extension to reach the archive's database.

import { importChats } from "./db";
import { normalizeChats } from "./import-export";

const EXTENSION_SOURCE = "gemini-exporter-extension";
const PAGE_SOURCE = "gemini-exporter-webapp";

interface ImportMessage {
  source: typeof EXTENSION_SOURCE;
  type: "IMPORT_CHATS";
  payload: unknown;
  mode?: "merge" | "replace";
}

function isImportMessage(data: unknown): data is ImportMessage {
  return (
    !!data &&
    typeof data === "object" &&
    (data as ImportMessage).source === EXTENSION_SOURCE &&
    (data as ImportMessage).type === "IMPORT_CHATS"
  );
}

/** Mount the extension → web app bridge. Returns an unsubscribe function. */
export function installExtensionBridge(): () => void {
  if (typeof window === "undefined") return () => {};

  const handler = async (event: MessageEvent) => {
    // Only trust messages this same window posted to its own origin.
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (!isImportMessage(event.data)) return;

    const ack = (payload: Record<string, unknown>) =>
      window.postMessage(
        { source: PAGE_SOURCE, type: "IMPORT_ACK", ...payload },
        window.location.origin,
      );

    try {
      const chats = normalizeChats(event.data.payload);
      if (!chats.length) {
        ack({ ok: false, error: "No valid chats in the sync payload." });
        return;
      }
      const mode = event.data.mode === "replace" ? "replace" : "merge";
      const imported = await importChats(chats, { mode });
      ack({ ok: true, imported });
    } catch (e) {
      ack({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
