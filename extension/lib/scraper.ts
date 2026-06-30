// Gemini DOM scraping logic.
//
// Validated empirically against gemini.google.com (June 2026 markup):
//   .conversation-container        -> one Q&A turn
//     user-query .query-text       -> the user's prompt (prefixed with "You said")
//     model-response message-content .markdown -> Gemini's answer
//
// Long conversations are rendered by a custom <infinite-scroller> that:
//   1. RECYCLES off-screen turns (only ~30-40 stay in the DOM at once), and
//   2. lazily LOADS older turns from the server when you scroll to the top,
//      showing a <mat-progress-spinner> and PREPENDING the results.
// Both behaviours were confirmed live (a 50+ turn chat surfaced 10 turns at a
// time, scrollHeight grew 22k -> 73k+ as older turns streamed in). The
// full-capture engine below is built around those facts.
//
// Selectors are ordered fallback lists so a single class-name change on
// Google's side does not break extraction outright.

import type { Chat, ChatTurn } from "./types";

const TURN_SELECTOR = ".conversation-container";

const QUESTION_SELECTORS = [
  "user-query .query-text",
  "user-query-content .query-text",
  "user-query",
];

const ANSWER_SELECTORS = [
  "model-response message-content .markdown",
  "model-response message-content",
  "model-response .markdown",
  "model-response",
];

function firstMatch(root: Element, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Strip Gemini's "You said" accessibility prefix and trim. */
function cleanQuestion(raw: string): string {
  return (raw || "").replace(/^\s*You said\s*/i, "").trim();
}

/**
 * Remove attributes that leak tracking query strings and inline event handlers,
 * keeping the structural HTML that makes answers readable in the EPUB / web app.
 */
function sanitizeHtml(html: string): string {
  if (!html) return "";
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "style" ||
        name.startsWith("_ng") ||
        name.startsWith("jslog") ||
        name === "jsaction"
      ) {
        el.removeAttribute(attr.name);
      }
      if ((name === "href" || name === "src") && attr.value) {
        try {
          const u = new URL(attr.value, location.href);
          el.setAttribute(name, u.origin + u.pathname);
        } catch {
          /* leave relative/invalid values as-is */
        }
      }
    });
    if (el.matches("button, .citation-marker, .source-footnote, mat-icon, script, style, mat-tooltip")) {
      el.remove();
    }
  });
  return tpl.innerHTML.trim();
}

/** Derive a readable title: page title, else the first question, else fallback. */
function deriveTitle(turns: { question: string }[]): string {
  const pageTitle = document.title.replace(/\s*-\s*Google Gemini\s*$/i, "").trim();
  if (pageTitle && !/^gemini$/i.test(pageTitle)) return pageTitle;
  const firstQ = turns.find((t) => t.question?.trim())?.question?.trim();
  if (firstQ) return firstQ.length > 70 ? firstQ.slice(0, 67) + "…" : firstQ;
  return "Untitled chat";
}

function conversationId(): string {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || `chat-${Date.now()}`;
}

/** Best-known {id, title, url} for the open conversation, before a full scrape. */
export function getConversationMeta(): { id: string; title: string; url: string } {
  const pageTitle = document.title.replace(/\s*-\s*Google Gemini\s*$/i, "").trim();
  const firstQEl = firstMatch(document.body, QUESTION_SELECTORS);
  const firstQ = firstQEl ? cleanQuestion((firstQEl as HTMLElement).innerText) : "";
  let title = pageTitle && !/^gemini$/i.test(pageTitle) ? pageTitle : firstQ || "Untitled chat";
  if (title.length > 80) title = title.slice(0, 77) + "…";
  return { id: conversationId(), title, url: location.href };
}

// ---------------------------------------------------------------------------
// Turn identity
// ---------------------------------------------------------------------------

/** Cheap synchronous FNV-1a hash → short base36 string. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function normForKey(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Dedup key that is stable across virtual-scroller re-renders. Prefers a stable
 * DOM id/attribute when Gemini exposes one; otherwise hashes normalized content.
 * Positional index is deliberately NOT used — it shifts as turns recycle/prepend.
 */
function turnKey(question: string, answerText: string, el: Element): string {
  const attr =
    el.getAttribute("id") ||
    el.getAttribute("data-conversation-id") ||
    el.getAttribute("data-turn-id") ||
    el.getAttribute("data-mat-id");
  if (attr) return `a:${attr}`;
  return `h:${fnv1a(normForKey(question) + " " + normForKey(answerText).slice(0, 512))}`;
}

// ---------------------------------------------------------------------------
// Single-frame (visible turns only) scrape
// ---------------------------------------------------------------------------

/** Extract the conversation currently rendered in the page (no scrolling). */
export function scrapeCurrentChat(): Chat {
  const containers = Array.from(document.querySelectorAll(TURN_SELECTOR));
  const turns: ChatTurn[] = [];
  containers.forEach((c, i) => {
    const qEl = firstMatch(c, QUESTION_SELECTORS);
    const aEl = firstMatch(c, ANSWER_SELECTORS);
    const question = cleanQuestion(qEl ? (qEl as HTMLElement).innerText : "");
    const answerText = aEl ? (aEl as HTMLElement).innerText.trim() : "";
    const answerHtml = aEl ? sanitizeHtml(aEl.innerHTML) : "";
    if (question || answerText) {
      turns.push({ index: i, key: turnKey(question, answerText, c), question, answerText, answerHtml });
    }
  });
  return {
    id: conversationId(),
    title: deriveTitle(turns),
    url: location.href,
    scrapedAt: new Date().toISOString(),
    turns,
  };
}

/** True when the current page looks like an open Gemini conversation. */
export function hasConversation(): boolean {
  return document.querySelector(TURN_SELECTOR) !== null;
}

// ---------------------------------------------------------------------------
// Loading / streaming detection
// ---------------------------------------------------------------------------

// Spinners shown while older turns stream in. NB: Gemini keeps a permanently
// HIDDEN progress spinner in the DOM, so presence alone is not enough — we must
// check that the spinner is actually visible.
const LOADING_SELECTORS = [
  "[role='progressbar']",
  "mat-progress-spinner",
  "mat-spinner",
  ".loading-indicator",
];

function isElementVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.offsetParent === null && getComputedStyle(h).position !== "fixed") return false;
  if (el.getClientRects().length === 0) return false;
  const s = getComputedStyle(h);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
}

/** True while older turns are being fetched/rendered (a visible spinner shows). */
export function isLoadingOlder(): boolean {
  for (const sel of LOADING_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (isElementVisible(el)) return true;
    }
  }
  return false;
}

// Indicators that a response is still streaming; scraping mid-stream would
// capture a half-rendered turn.
const GENERATING_SELECTORS = [
  "[data-test-id='stop-generating-button']",
  "button[aria-label*='Stop' i]",
  ".response-generating",
  ".generating",
];

/** True while Gemini is actively generating a response. */
export function isGenerating(): boolean {
  return GENERATING_SELECTORS.some((sel) => {
    const el = document.querySelector(sel);
    return el !== null && isElementVisible(el);
  });
}

// ---------------------------------------------------------------------------
// Scroll container discovery
// ---------------------------------------------------------------------------

const SCROLL_CONTAINER_SELECTORS = [
  "infinite-scroller",
  "cdk-virtual-scroll-viewport",
  "[data-test-id='chat-window']",
  ".chat-history",
  "main",
];

function isScrollable(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  const oy = style.overflowY;
  return (oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 4;
}

/**
 * Find the element that actually scrolls the conversation. The nearest
 * scrollable ancestor of a real turn is the most reliable signal (confirmed to
 * be <infinite-scroller class="chat-history"> live), so it is tried first.
 */
export function findScrollContainer(): HTMLElement | null {
  const anchor = document.querySelector(TURN_SELECTOR);
  if (anchor) {
    let node: HTMLElement | null = anchor.parentElement;
    while (node && node !== document.body) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }
  }
  for (const sel of SCROLL_CONTAINER_SELECTORS) {
    for (const c of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (isScrollable(c)) return c;
    }
  }
  const root = (document.scrollingElement as HTMLElement | null) || document.documentElement;
  if (root && root.scrollHeight > root.clientHeight + 4) return root;
  return null;
}

// ---------------------------------------------------------------------------
// Ordering: overlap-stitch
//
// The DOM only ever holds a contiguous WINDOW of the full chronological turn
// sequence. As we scroll up, successive windows overlap (and older turns get
// prepended). We rebuild the global order by stitching each snapshot's key list
// onto the running order using the overlapping run as the anchor. This is
// robust to both recycling (turns leaving the DOM) and prepends (older turns
// arriving above) — unlike pixel-offset ordering, which prepends corrupt.
// ---------------------------------------------------------------------------

/**
 * Merge a freshly-captured snapshot of turn keys (in DOM/chronological order)
 * into the running global order. Exported for unit testing.
 */
export function stitchOrder(ordered: string[], snap: string[]): string[] {
  if (snap.length === 0) return ordered;
  if (ordered.length === 0) return [...snap];

  const maxM = Math.min(snap.length, ordered.length);

  // Case A (scrolling up): a suffix of `snap` equals a prefix of `ordered`.
  // Prepend snap's leading, newly-revealed turns.
  for (let m = maxM; m >= 1; m--) {
    let ok = true;
    for (let i = 0; i < m; i++) {
      if (snap[snap.length - m + i] !== ordered[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const prefix = snap.slice(0, snap.length - m);
      return prefix.length ? [...prefix, ...ordered] : ordered;
    }
  }

  // Case B (scrolling down / tail sweep): a prefix of `snap` equals a suffix of
  // `ordered`. Append snap's trailing, newly-revealed turns.
  for (let m = maxM; m >= 1; m--) {
    let ok = true;
    for (let i = 0; i < m; i++) {
      if (ordered[ordered.length - m + i] !== snap[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const suffix = snap.slice(m);
      return suffix.length ? [...ordered, ...suffix] : ordered;
    }
  }

  // No edge overlap. If snap is fully contained (nothing new), keep order.
  // Otherwise append unseen keys (rare; only if a scroll jump skipped the
  // overlap window — kept as a non-destructive safety net).
  const have = new Set(ordered);
  const extra = snap.filter((k) => !have.has(k));
  return extra.length ? [...ordered, ...extra] : ordered;
}

// ---------------------------------------------------------------------------
// Full-conversation auto-scroll capture
// ---------------------------------------------------------------------------

export interface ScrapeOptions {
  /** Pause between scroll steps so virtualized turns can render. */
  scrollDelayMs?: number;
  /** Fraction of the viewport height to scroll per step (kept < 1 so windows overlap). */
  stepFraction?: number;
  /** Hard cap on scroll iterations. */
  maxIterations?: number;
  /** Hard cap on total wall-clock time. */
  maxDurationMs?: number;
  /** Max time to wait for a single older-turns load to finish. */
  loadWaitMs?: number;
  /** Consecutive "settled at top" rounds required to stop. */
  stableRounds?: number;
  /** Progress callback. */
  onProgress?: (info: { turns: number; iteration: number; atTop: boolean; loading: boolean }) => void;
  /**
   * Periodic partial-result callback. Fired (throttled by `snapshotIntervalMs`)
   * with the conversation captured *so far*, so the caller can persist progress
   * incrementally and never lose work if the scrape is interrupted.
   */
  onSnapshot?: (chat: Chat) => void;
  /** Minimum gap between `onSnapshot` calls. */
  snapshotIntervalMs?: number;
}

const SCRAPE_DEFAULTS: Required<Omit<ScrapeOptions, "onProgress" | "onSnapshot">> = {
  scrollDelayMs: 350,
  stepFraction: 0.7,
  maxIterations: 1000,
  maxDurationMs: 300_000,
  loadWaitMs: 12_000,
  stableRounds: 3,
  snapshotIntervalMs: 4000,
};

/** Build a Chat object from the accumulated ordered keys + per-turn data. */
function buildChat(ordered: string[], data: Map<string, TurnData>): Chat {
  const turns: ChatTurn[] = ordered.map((key, i) => {
    const d = data.get(key)!;
    return {
      index: i,
      key,
      question: d.question,
      answerText: d.answerText,
      answerHtml: d.answerHtml,
    };
  });
  return {
    id: conversationId(),
    title: deriveTitle(turns),
    url: location.href,
    scrapedAt: new Date().toISOString(),
    turns,
  };
}

interface TurnData {
  question: string;
  answerText: string;
  answerHtml: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Capture the currently-rendered turns. Returns the ordered key list (DOM
 * order) and folds answer content into `data`, keeping the richest copy seen
 * (answers can be partially rendered near the viewport edge). HTML is only
 * (re)extracted when a turn is new or its text grew, to keep big chats cheap.
 */
function captureRendered(data: Map<string, TurnData>): string[] {
  const containers = Array.from(document.querySelectorAll(TURN_SELECTOR));
  const keys: string[] = [];
  for (const c of containers) {
    const qEl = firstMatch(c, QUESTION_SELECTORS);
    const aEl = firstMatch(c, ANSWER_SELECTORS);
    const question = cleanQuestion(qEl ? (qEl as HTMLElement).innerText : "");
    const answerText = aEl ? (aEl as HTMLElement).innerText.trim() : "";
    if (!question && !answerText) continue;
    const key = turnKey(question, answerText, c);
    keys.push(key);
    const prev = data.get(key);
    if (!prev || answerText.length > prev.answerText.length || (!prev.question && question)) {
      data.set(key, {
        question: question || prev?.question || "",
        answerText: answerText || prev?.answerText || "",
        answerHtml: aEl ? sanitizeHtml(aEl.innerHTML) : prev?.answerHtml || "",
      });
    }
  }
  return keys;
}

function scrollTo(container: HTMLElement, top: number) {
  container.scrollTop = top;
  // Some virtual scrollers only react to a dispatched scroll event.
  container.dispatchEvent(new Event("scroll", { bubbles: true }));
}

/**
 * Scrape the COMPLETE conversation by scrolling to the very top while
 * accumulating turns, waiting for the server to stream in older turns whenever
 * a loading spinner appears. Falls back to `scrapeCurrentChat()` when there is
 * no scroll container (a short chat that fits on screen) so this is never worse
 * than the single-frame path.
 */
export async function scrapeFullChat(opts: ScrapeOptions = {}): Promise<Chat> {
  const cfg = { ...SCRAPE_DEFAULTS, ...opts };
  const container = findScrollContainer();
  if (!container) return scrapeCurrentChat();

  const data = new Map<string, TurnData>();
  let ordered: string[] = [];
  let lastSnapshot = 0;

  const scan = () => {
    ordered = stitchOrder(ordered, captureRendered(data));
  };

  const maybeSnapshot = () => {
    if (!cfg.onSnapshot) return;
    const t = Date.now();
    if (t - lastSnapshot < cfg.snapshotIntervalMs) return;
    lastSnapshot = t;
    if (ordered.length) {
      try {
        cfg.onSnapshot(buildChat(ordered, data));
      } catch {
        /* persistence is best-effort; never let it abort the scrape */
      }
    }
  };

  // Anchor at the bottom (latest turn) and capture.
  scrollTo(container, container.scrollHeight);
  await sleep(cfg.scrollDelayMs);
  scan();

  const start = Date.now();
  let stable = 0;
  let lastHeight = container.scrollHeight;

  for (let i = 0; i < cfg.maxIterations; i++) {
    if (Date.now() - start > cfg.maxDurationMs) break;

    const before = ordered.length;
    const step = Math.max(120, container.clientHeight * cfg.stepFraction);
    scrollTo(container, Math.max(0, container.scrollTop - step));
    await sleep(cfg.scrollDelayMs);

    // If reaching the top kicked off a server fetch of older turns, wait for the
    // spinner to clear (bounded), then let the prepended turns settle.
    if (isLoadingOlder()) {
      const waitStart = Date.now();
      while (isLoadingOlder() && Date.now() - waitStart < cfg.loadWaitMs) {
        await sleep(250);
      }
      await sleep(cfg.scrollDelayMs);
    }

    scan();

    let grew = container.scrollHeight > lastHeight + 4;
    lastHeight = container.scrollHeight;
    let atTop = container.scrollTop <= 2;
    let addedNew = ordered.length - before;

    // Reaching the top does NOT reliably auto-load the next older batch — the
    // loader fires when its top sentinel RE-ENTERS the viewport. So before we
    // accept "we're done", bounce down a viewport and back to the top to
    // re-trigger any pending lazy load, then re-measure.
    if (atTop && !grew && addedNew === 0 && !isLoadingOlder()) {
      const beforeBounce = ordered.length;
      scrollTo(container, Math.min(container.scrollHeight, container.clientHeight));
      await sleep(cfg.scrollDelayMs);
      scrollTo(container, 0);
      await sleep(cfg.scrollDelayMs);
      if (isLoadingOlder()) {
        const waitStart = Date.now();
        while (isLoadingOlder() && Date.now() - waitStart < cfg.loadWaitMs) {
          await sleep(250);
        }
        await sleep(cfg.scrollDelayMs);
      }
      scan();
      grew = container.scrollHeight > lastHeight + 4;
      lastHeight = container.scrollHeight;
      addedNew = ordered.length - beforeBounce;
      atTop = container.scrollTop <= 2;
    }

    cfg.onProgress?.({ turns: ordered.length, iteration: i, atTop, loading: isLoadingOlder() });
    maybeSnapshot();

    // Settled only when we're at the top, nothing is loading, the content
    // stopped growing, and the bounce surfaced no new turns.
    if (atTop && !grew && addedNew === 0 && !isLoadingOlder()) {
      if (++stable >= cfg.stableRounds) break;
    } else {
      stable = 0;
    }
  }

  // Confirming sweep back to the bottom — guards against the tail having been
  // evicted from the DOM while we were parked at the top.
  scrollTo(container, container.scrollHeight);
  await sleep(cfg.scrollDelayMs);
  scan();

  return buildChat(ordered, data);
}
