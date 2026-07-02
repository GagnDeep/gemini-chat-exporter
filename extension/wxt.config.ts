import { defineConfig } from "wxt";

// WXT configuration. See https://wxt.dev/api/config.html
export default defineConfig({
  // React powers the in-extension Gemini-style archive page.
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Gemini Chat Exporter + Archive",
    description:
      "Capture your Google Gemini conversations into a private, searchable archive — Gemini-style UI, keyword/fuzzy/on-device semantic search, EPUB/JSON/Markdown export.",
    version: "1.2.0",
    // "tabs" is needed to find/create tabs (web app sync + open-in-archive);
    // "contextMenus" powers the right-click capture; "unlimitedStorage" keeps a
    // large archive from hitting the default storage.local quota.
    permissions: [
      "activeTab",
      "tabs",
      "scripting",
      "storage",
      "unlimitedStorage",
      "downloads",
      "contextMenus",
    ],
    host_permissions: [
      "https://gemini.google.com/*",
      // Companion web app origin for auto-sync. Keep in sync with the bridge
      // content script matches (webapp-bridge.content.ts) and DEFAULT_SETTINGS
      // (lib/settings.ts). Deployed host first, localhost kept for dev.
      "https://epub-viewer.xn--lkv.com/*",
      "http://localhost:3000/*",
    ],
    action: {
      default_title: "Gemini Chat Exporter + Archive",
    },
    // The archive page is the options page, opened in its own full tab.
    options_ui: {
      open_in_tab: true,
    },
    // 'wasm-unsafe-eval' lets the bundled transformers.js worker instantiate the
    // ONNX WebAssembly runtime for on-device semantic search. Model weights are
    // fetched over the network (no remote *code* is executed).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    // The embeddings worker loads the ONNX WASM runtime (ort/) — and optionally
    // local model weights (models/) — as extension-local assets. Exposing them
    // as web-accessible resources lets the worker context fetch them reliably.
    web_accessible_resources: [
      {
        resources: ["ort/*", "models/*"],
        matches: ["https://gemini.google.com/*"],
      },
    ],
    // Keyboard shortcut for a full background capture of the active Gemini tab.
    commands: {
      "scrape-full-chat": {
        suggested_key: { default: "Alt+Shift+G" },
        description: "Capture the full Gemini conversation in the active tab",
      },
    },
  },
  // Keep manifest version 3 (Chrome default).
  manifestVersion: 3,
});
