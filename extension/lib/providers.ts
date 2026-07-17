// Provider adapter layer.
//
// The extension started life as Gemini-only. To capture Claude and ChatGPT too,
// every site-specific fact (URL patterns, DOM selectors, how a "turn" is laid
// out, how the composer + send button look, how to read the conversation id and
// title) is described here as a data-driven `Provider` profile. The scraper,
// composer, live-recorder, content-runtime, background worker and popup are all
// generic and driven by the active provider — so adding a fourth site later is
// "add one profile", not "fork the engine".
//
// Two DOM shapes are supported:
//   • "container" — each turn is ONE element holding both the question and the
//     answer (Gemini's <div class="conversation-container">).
//   • "stream"    — the page is a flat sequence of message blocks, each either a
//     user message or an assistant message, that must be PAIRED into Q&A turns
//     (Claude and ChatGPT). Roles come either from separate selectors or from a
//     role attribute on each message.
//
// Selectors are ordered fallback lists (first match wins), matching the
// resilience approach used throughout the codebase: one class-name change on a
// vendor's side degrades gracefully instead of breaking capture outright.
//
// Selectors below were verified against the live DOM of each site (July 2026).

export type ProviderId = "gemini" | "claude" | "chatgpt";

export interface Provider {
  /** Stable machine id, also used as the chat-id namespace prefix. */
  id: ProviderId;
  /** Human label shown in the popup / archive ("Gemini", "Claude", "ChatGPT"). */
  label: string;
  /** Brand accent used for the source badge. */
  accent: string;
  /** One-glyph mark for compact UI. */
  glyph: string;
  /** Manifest match patterns for this site. Keep in sync with each content
   *  script's literal `matches` and with wxt.config.ts host_permissions. */
  matches: string[];
  /** Hostname substrings used to detect "the active tab is this provider". */
  urlIncludes: string[];

  /** DOM layout of the conversation. */
  mode: "container" | "stream";

  // --- container mode (Gemini) ---------------------------------------------
  /** Selector for one Q&A container. */
  turnSelector?: string;
  /** Where the user's prompt lives inside a container. */
  questionSelectors?: string[];
  /** Where the model's answer lives inside a container. */
  answerSelectors?: string[];

  // --- stream mode (Claude, ChatGPT) ---------------------------------------
  /** Selector(s) matching a user message block. */
  userSelectors?: string[];
  /** Selector(s) matching an assistant message block. */
  assistantSelectors?: string[];
  /** When set, messages are matched by `messageSelectors` and the role is read
   *  from this attribute ("user" / "assistant"). */
  roleAttr?: string;
  /** Selector(s) matching any message block (used with `roleAttr`). */
  messageSelectors?: string[];
  /** Where readable text lives inside a user message (falls back to the block). */
  userContentSelectors?: string[];
  /** Where the answer lives inside an assistant message (falls back to block). */
  assistantContentSelectors?: string[];
  /**
   * Elements to strip from captured question/answer content before reading text
   * and HTML: interactive chrome (copy/edit buttons), collapsed reasoning chips,
   * tool-use badges. Keeps the archive clean and text/HTML consistent.
   */
  answerExcludeSelectors?: string[];

  // --- shared detection -----------------------------------------------------
  /** Visible => older turns are streaming in from the server. */
  loadingSelectors: string[];
  /** Visible => the model is actively generating (don't scrape mid-stream). */
  generatingSelectors: string[];
  /** Candidate scroll containers (nearest-scrollable-ancestor is tried first). */
  scrollContainerSelectors: string[];

  // --- composer -------------------------------------------------------------
  composerSelectors: string[];
  sendSelectors: string[];
  /** Pressing Enter submits (used as a fallback when no send button is found). */
  submitByEnter: boolean;

  // --- meta -----------------------------------------------------------------
  /** Accessibility/prefix noise to strip from a captured question (e.g. Gemini's
   *  "You said"). */
  questionPrefix?: RegExp;
  /** Trailing " - <Brand>" removed from document.title. */
  titleSuffix?: RegExp;
  /** Bare titles that should be treated as "no title" (fall back to first Q). */
  genericTitle: RegExp;
  /** Namespace prefix for the stored chat id. Empty for Gemini (kept bare for
   *  backward-compat with archives + the companion web app). */
  idPrefix: string;
  /** URL-path segments that are NOT a conversation id (so `/app`, `/new` etc.
   *  don't masquerade as a chat). */
  nonChatSegments?: RegExp;
}

export const GEMINI: Provider = {
  id: "gemini",
  label: "Gemini",
  accent: "#4285f4",
  glyph: "✦",
  matches: ["https://gemini.google.com/*"],
  urlIncludes: ["gemini.google.com"],
  mode: "container",
  turnSelector: ".conversation-container",
  questionSelectors: ["user-query .query-text", "user-query-content .query-text", "user-query"],
  answerSelectors: [
    "model-response message-content .markdown",
    "model-response message-content",
    "model-response .markdown",
    "model-response",
  ],
  loadingSelectors: ["[role='progressbar']", "mat-progress-spinner", "mat-spinner", ".loading-indicator"],
  generatingSelectors: [
    "[data-test-id='stop-generating-button']",
    "button[aria-label*='Stop' i]",
    ".response-generating",
    ".generating",
  ],
  scrollContainerSelectors: [
    "infinite-scroller",
    "cdk-virtual-scroll-viewport",
    "[data-test-id='chat-window']",
    ".chat-history",
    "main",
  ],
  composerSelectors: [
    "rich-textarea .ql-editor[contenteditable='true']",
    ".ql-editor[contenteditable='true']",
    "div[contenteditable='true'][role='textbox']",
    "textarea[aria-label*='prompt' i]",
    "textarea[aria-label*='Enter a prompt' i]",
    "textarea",
  ],
  sendSelectors: [
    "button.send-button",
    "button[aria-label*='Send' i]",
    "[data-test-id='send-button']",
    "button[mattooltip*='Send' i]",
  ],
  submitByEnter: false,
  answerExcludeSelectors: ["button", "[role='button']", ".citation-marker", ".source-footnote", "mat-icon", "mat-tooltip"],
  questionPrefix: /^\s*You said\s*/i,
  titleSuffix: /\s*-\s*Google Gemini\s*$/i,
  genericTitle: /^gemini$/i,
  idPrefix: "",
  nonChatSegments: /^(app|new)$/i,
};

export const CLAUDE: Provider = {
  id: "claude",
  label: "Claude",
  accent: "#d97757",
  glyph: "✳",
  matches: ["https://claude.ai/*"],
  urlIncludes: ["claude.ai"],
  mode: "stream",
  // Verified live: user prompts carry data-testid="user-message"; assistant
  // answers render inside .font-claude-response; the whole assistant turn is
  // wrapped by a div carrying data-is-streaming ("true" while generating).
  userSelectors: ['[data-testid="user-message"]', ".font-user-message"],
  assistantSelectors: [".font-claude-response", ".font-claude-message"],
  userContentSelectors: [".whitespace-pre-wrap"],
  assistantContentSelectors: [".font-claude-response", ".font-claude-message"],
  loadingSelectors: [],
  generatingSelectors: [
    '[data-is-streaming="true"]',
    'button[aria-label="Stop response"]',
    'button[aria-label*="Stop" i]',
  ],
  scrollContainerSelectors: [
    "div.overflow-y-auto.overflow-x-hidden",
    "div.overflow-y-scroll",
    "main",
  ],
  composerSelectors: [
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ],
  sendSelectors: [
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i]',
    'fieldset button[type="submit"]',
    'button[type="submit"]',
  ],
  submitByEnter: true,
  // Claude's .font-claude-response wraps collapsed extended-thinking chips and
  // tool-use badges (rendered as buttons) alongside the answer prose — strip them.
  answerExcludeSelectors: ["button", "[role='button']", "[aria-label='Copy']"],
  titleSuffix: /\s*-\s*Claude\s*$/i,
  genericTitle: /^claude$/i,
  idPrefix: "claude:",
  nonChatSegments: /^(new|projects|recents)$/i,
};

export const CHATGPT: Provider = {
  id: "chatgpt",
  label: "ChatGPT",
  accent: "#10a37f",
  glyph: "◍",
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  urlIncludes: ["chatgpt.com", "chat.openai.com"],
  mode: "stream",
  // Verified live: each message exposes data-message-author-role ("user" /
  // "assistant"); user text sits in .whitespace-pre-wrap, the answer in .markdown.
  roleAttr: "data-message-author-role",
  messageSelectors: ["[data-message-author-role]"],
  userContentSelectors: [".whitespace-pre-wrap"],
  assistantContentSelectors: [".markdown", ".whitespace-pre-wrap"],
  loadingSelectors: [],
  generatingSelectors: ['button[data-testid="stop-button"]', ".result-streaming"],
  scrollContainerSelectors: [
    "main div.overflow-y-auto",
    "main .overflow-y-auto",
    "div[class*='react-scroll-to-bottom']",
    "main",
  ],
  composerSelectors: [
    "div.ProseMirror#prompt-textarea",
    "#prompt-textarea",
    "textarea#prompt-textarea",
    'div[contenteditable="true"][id="prompt-textarea"]',
    "textarea",
  ],
  sendSelectors: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
  submitByEnter: true,
  answerExcludeSelectors: ["button", "[role='button']"],
  titleSuffix: /\s*-\s*ChatGPT\s*$/i,
  genericTitle: /^(chatgpt|new chat)$/i,
  idPrefix: "chatgpt:",
  nonChatSegments: /^(c|new)$/i,
};

export const PROVIDERS: Provider[] = [GEMINI, CLAUDE, CHATGPT];

/** All match patterns across every provider (manifest + context-menu helper). */
export const ALL_MATCHES: string[] = PROVIDERS.flatMap((p) => p.matches);

/** Resolve the provider that owns a URL (or hostname), or null. */
export function providerForUrl(url: string | undefined): Provider | null {
  if (!url) return null;
  for (const p of PROVIDERS) {
    if (p.urlIncludes.some((h) => url.includes(h))) return p;
  }
  return null;
}

/** Resolve the provider for the current page (used inside content scripts). */
export function activeProvider(): Provider {
  return providerForUrl(location.href) ?? GEMINI;
}

/** Look up a provider by id (e.g. to render a badge from a stored chat.source). */
export function providerById(id: string | undefined): Provider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Label for a stored chat's source id (falls back to a capitalized id). */
export function sourceLabel(id: string | undefined): string {
  const p = providerById(id);
  if (p) return p.label;
  if (!id) return "Chat";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Brand accent for a stored chat's source id (falls back to a neutral gray). */
export function sourceAccent(id: string | undefined): string {
  return providerById(id)?.accent ?? "#9aa0a6";
}
