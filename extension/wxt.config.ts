import { defineConfig } from "wxt";

// WXT configuration. See https://wxt.dev/api/config.html
export default defineConfig({
  // React powers the in-extension archive page.
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "AI Chat Exporter + Archive",
    description:
      "Capture your Gemini, Claude, and ChatGPT conversations into one private, searchable archive — keyword/fuzzy/on-device semantic search, EPUB/JSON/Markdown export.",
    version: "1.5.0",
    // "tabs" is needed to find/create tabs (web app sync + open-in-archive + send);
    // "contextMenus" powers the right-click capture; "unlimitedStorage" keeps a
    // large archive from hitting the default storage.local quota.
    permissions: ["activeTab", "tabs", "scripting", "storage", "unlimitedStorage", "downloads", "contextMenus"],
    host_permissions: [
      "https://gemini.google.com/*",
      "https://claude.ai/*",
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      // Companion web app origin for auto-sync. Keep in sync with the bridge
      // content script matches (webapp-bridge.content.ts) and DEFAULT_SETTINGS.
      "https://epub-viewer.xn--lkv.com/*",
      "http://localhost:3000/*",
    ],
    action: {
      default_title: "AI Chat Exporter + Archive",
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
    // The embeddings worker loads the ONNX WASM runtime (ort/) and optionally local
    // model weights (models/) as extension-local assets. Exposing them as
    // web-accessible resources lets a page context fetch them reliably.
    web_accessible_resources: [
      {
        resources: ["ort/*", "models/*"],
        matches: [
          "https://gemini.google.com/*",
          "https://claude.ai/*",
          "https://chatgpt.com/*",
          "https://chat.openai.com/*",
        ],
      },
    ],
    // Keyboard shortcut for a full background capture of the active supported tab.
    commands: {
      "scrape-full-chat": {
        suggested_key: { default: "Alt+Shift+G" },
        description: "Capture the full conversation in the active tab (Gemini/Claude/ChatGPT)",
      },
    },
  },
  // Keep manifest version 3 (Chrome default).
  manifestVersion: 3,
});
