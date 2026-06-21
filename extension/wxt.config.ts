import { defineConfig } from "wxt";

// WXT configuration. See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: "Gemini Chat Exporter",
    description:
      "Scrape your Google Gemini conversations and export them as EPUB (one chapter per Q&A) or JSON for the companion web app.",
    version: "1.0.0",
    // "tabs" is needed to find/create the web app tab for auto-sync; activeTab
    // alone can't reach a non-active background tab. "contextMenus" powers the
    // right-click "Scrape this Gemini chat" entry.
    permissions: ["activeTab", "tabs", "scripting", "storage", "downloads", "contextMenus"],
    host_permissions: [
      "https://gemini.google.com/*",
      // Companion web app origin for auto-sync. Add the deployed host here too
      // before release; keep it in sync with the bridge content script matches.
      "http://localhost:3000/*",
    ],
    action: {
      default_title: "Gemini Chat Exporter",
    },
    // Keyboard shortcut for a full scroll-capture of the active Gemini tab.
    commands: {
      "scrape-full-chat": {
        suggested_key: { default: "Alt+Shift+G" },
        description: "Scrape the full Gemini conversation in the active tab",
      },
    },
  },
  // Keep manifest version 3 (Chrome default).
  manifestVersion: 3,
});
