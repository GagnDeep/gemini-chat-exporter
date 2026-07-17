// Conversation DOM scraping — provider-driven.
//
// The scroll/stitch capture ENGINE (auto-scroll to the top, wait out lazy-loads,
// stitch overlapping windows into a global order) is generic and unchanged from
// the original Gemini-only implementation. Everything SITE-SPECIFIC — which
// element is a turn, where the question/answer live, how "generating" looks, the
// scroll container — comes from a `Provider` profile (see lib/providers.ts), so
// the same engine captures Gemini, Claude and ChatGPT.
//
// Two DOM shapes are handled by `collectFrame`:
//   • container mode (Gemini): each `.conversation-container` holds a Q and an A.
//   • stream mode (Claude, ChatGPT): a flat list of user/assistant message blocks
//     that are paired into Q&A turns.
//
// Content cleanliness (validated against live DOM, July 2026): answer/question
// text is read with a read-only walker that SKIPS interactive chrome (copy/edit
// buttons, Claude's collapsed extended-thinking chips, tool-use badges) and the
// HTML is sanitized with the same exclusions — so text and HTML stay consistent
// and the archive isn't polluted with UI noise.

import type { Chat, ChatTurn } from "./types";
import { activeProvider, type Provider } from "./providers";

const DEFAULT_EXCLUDE = ["button", "[role='button']"];

function firstMatch(root: ParentNode, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function matchesAny(el: Element, selectors: string[]): boolean {
  return selectors.some((s) => {
    try {
      return el.matches(s);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Read-only, layout-free text extraction
//
// innerText needs layout (and returns "" on a detached clone), and it can't skip
// sub-elements — so to drop buttons/thinking-chips without mutating the live page
// we walk the tree ourselves. Block elements insert newlines (approximating
// innerText); <pre> subtrees keep their raw whitespace so code survives.
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "LI", "UL", "OL", "PRE", "BLOCKQUOTE",
  "TABLE", "TR", "THEAD", "TBODY", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "FIGURE", "FIGCAPTION",
]);

function textFrom(root: Element, exclude: string[]): string {
  let out = "";
  const walk = (node: Node, pre: boolean) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const raw = child.nodeValue || "";
        out += pre ? raw : raw.replace(/\s+/g, " ");
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.tagName === "BR") {
          out += "\n";
          continue;
        }
        if (matchesAny(el, exclude)) continue;
        const block = BLOCK_TAGS.has(el.tagName);
        if (block) out += "\n";
        walk(el, pre || el.tagName === "PRE");
        if (block) out += "\n";
      }
    }
  };
  walk(root, false);
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Remove tracking query strings + inline handlers, drop interactive chrome and
 * any provider-specified noise, keeping the structural HTML that makes answers
 * readable in the EPUB / web app.
 */
function sanitizeHtml(html: string, exclude: string[] = []): string {
  if (!html) return "";
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const dropSel =
    "button, [role='button'], .citation-marker, .source-footnote, mat-icon, script, style, mat-tooltip" +
    (exclude.length ? ", " + exclude.join(", ") : "");
  tpl.content.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "style" ||
        name.startsWith("_ng") ||
        name.startsWith("jslog") ||
        name === "jsaction" ||
        name.startsWith("data-")
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
    try {
      if (el.matches(dropSel)) el.remove();
    } catch {
      /* invalid selector guard */
    }
  });
  return tpl.innerHTML.trim();
}

/** Clean {text, html} from a content root, dropping chrome/noise consistently. */
function extractContent(el: Element, exclude: string[]): { text: string; html: string } {
  return { text: textFrom(el, exclude), html: sanitizeHtml(el.innerHTML, exclude) };
}

/** Strip a provider's question-prefix noise (e.g. Gemini's "You said") + trim. */
function cleanQuestion(provider: Provider, raw: string): string {
  let q = raw || "";
  if (provider.questionPrefix) q = q.replace(provider.questionPrefix, "");
  return q.trim();
}

// ---------------------------------------------------------------------------
// Identity + meta
// ---------------------------------------------------------------------------

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

function conversationId(provider: Provider): string {
  const parts = location.pathname.split("/").filter(Boolean);
  let seg = parts[parts.length - 1] || "";
  if (seg && provider.nonChatSegments && provider.nonChatSegments.test(seg)) seg = "";
  if (!seg) seg = fnv1a(location.pathname || "session"); // deterministic per unsaved chat
  return provider.idPrefix + seg;
}

function deriveTitle(provider: Provider, turns: { question: string }[]): string {
  let pageTitle = document.title || "";
  if (provider.titleSuffix) pageTitle = pageTitle.replace(provider.titleSuffix, "");
  pageTitle = pageTitle.trim();
  if (pageTitle && !provider.genericTitle.test(pageTitle)) return pageTitle;
  const firstQ = turns.find((t) => t.question?.trim())?.question?.trim();
  if (firstQ) return firstQ.length > 70 ? firstQ.slice(0, 67) + "…" : firstQ;
  return "Untitled chat";
}

/** Best-known {id, title, url, source} for the open conversation. */
export function getConversationMeta(
  provider: Provider = activeProvider(),
): { id: string; title: string; url: string; source: Provider["id"] } {
  const raw = collectFrame(provider, new Map());
  const title = deriveTitle(provider, raw.map((k) => ({ question: k.question })));
  return { id: conversationId(provider), title, url: location.href, source: provider.id };
}

// ---------------------------------------------------------------------------
// Per-frame capture (both DOM shapes)
// ---------------------------------------------------------------------------

interface TurnData {
  question: string;
  answerText: string;
  answerHtml: string;
}

interface RawTurn extends TurnData {
  key: string;
}

function contentKey(question: string, answerText: string): string {
  return `h:${fnv1a(normForKey(question) + " " + normForKey(answerText).slice(0, 512))}`;
}

function containerKey(question: string, answerText: string, el: Element): string {
  const attr =
    el.getAttribute("id") ||
    el.getAttribute("data-conversation-id") ||
    el.getAttribute("data-turn-id") ||
    el.getAttribute("data-mat-id");
  if (attr) return `a:${attr}`;
  return contentKey(question, answerText);
}

function excludeFor(provider: Provider): string[] {
  return provider.answerExcludeSelectors ?? DEFAULT_EXCLUDE;
}

function roleOf(provider: Provider, el: Element): "user" | "assistant" | null {
  if (provider.roleAttr) {
    const r = el.getAttribute(provider.roleAttr);
    return r === "user" || r === "assistant" ? r : null;
  }
  if (provider.userSelectors && matchesAny(el, provider.userSelectors)) return "user";
  if (provider.assistantSelectors && matchesAny(el, provider.assistantSelectors)) return "assistant";
  return null;
}

function readUserText(provider: Provider, el: Element): string {
  const inner = provider.userContentSelectors ? firstMatch(el, provider.userContentSelectors) : null;
  const target = inner || el;
  return cleanQuestion(provider, textFrom(target, excludeFor(provider)));
}

function readAssistant(provider: Provider, el: Element): { text: string; html: string } {
  const inner = provider.assistantContentSelectors ? firstMatch(el, provider.assistantContentSelectors) : null;
  const target = inner || el;
  return extractContent(target, excludeFor(provider));
}

/** All stream message blocks on the page, in document order, tagged by role. */
function streamMessages(provider: Provider): { role: "user" | "assistant"; el: Element }[] {
  const sels =
    provider.messageSelectors ?? [...(provider.userSelectors ?? []), ...(provider.assistantSelectors ?? [])];
  const seen = new Set<Element>();
  const els: Element[] = [];
  for (const sel of sels) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!seen.has(el)) {
        seen.add(el);
        els.push(el);
      }
    }
  }
  els.sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  const out: { role: "user" | "assistant"; el: Element }[] = [];
  for (const el of els) {
    const role = roleOf(provider, el);
    if (role) out.push({ role, el });
  }
  return out;
}

/**
 * Pair a flat user/assistant message stream into ordered Q&A turns. Consecutive
 * user messages before any answer are MERGED into one turn's question (handles
 * image+caption sends and rapid double-sends); consecutive assistant blocks are
 * concatenated into one answer.
 */
function pairStream(provider: Provider): RawTurn[] {
  const msgs = streamMessages(provider);
  const turns: RawTurn[] = [];
  let cur: TurnData | null = null;
  const flush = () => {
    if (cur && (cur.question || cur.answerText)) turns.push({ ...cur, key: contentKey(cur.question, cur.answerText) });
    cur = null;
  };
  for (const m of msgs) {
    if (m.role === "user") {
      const q = readUserText(provider, m.el);
      if (cur && cur.answerText) {
        // A complete turn already has an answer — this starts a new one.
        flush();
        cur = { question: q, answerText: "", answerHtml: "" };
      } else if (cur) {
        // Consecutive user messages before any answer — merge into one question.
        cur.question = cur.question ? cur.question + "\n\n" + q : q;
      } else {
        cur = { question: q, answerText: "", answerHtml: "" };
      }
    } else {
      const a = readAssistant(provider, m.el);
      if (!cur) cur = { question: "", answerText: "", answerHtml: "" };
      cur.answerText = cur.answerText ? cur.answerText + "\n\n" + a.text : a.text;
      cur.answerHtml = cur.answerHtml ? cur.answerHtml + "\n" + a.html : a.html;
    }
  }
  flush();
  return turns;
}

/** Container-mode turns (Gemini). */
function collectContainers(provider: Provider): RawTurn[] {
  const turns: RawTurn[] = [];
  const exclude = excludeFor(provider);
  for (const c of Array.from(document.querySelectorAll(provider.turnSelector!))) {
    const qEl = provider.questionSelectors ? firstMatch(c, provider.questionSelectors) : null;
    const aEl = provider.answerSelectors ? firstMatch(c, provider.answerSelectors) : null;
    const question = cleanQuestion(provider, qEl ? textFrom(qEl, exclude) : "");
    const answer = aEl ? extractContent(aEl, exclude) : { text: "", html: "" };
    if (question || answer.text) {
      turns.push({ key: containerKey(question, answer.text, c), question, answerText: answer.text, answerHtml: answer.html });
    }
  }
  return turns;
}

/**
 * Capture the currently-rendered turns for either DOM shape. Returns the ordered
 * key list (document order) and folds answer content into `data`, keeping the
 * richest copy seen (answers can be partially rendered near the viewport edge).
 */
function collectFrame(provider: Provider, data: Map<string, TurnData>): RawTurn[] {
  const raw = provider.mode === "container" ? collectContainers(provider) : pairStream(provider);
  for (const t of raw) {
    const prev = data.get(t.key);
    if (!prev || t.answerText.length > prev.answerText.length || (!prev.question && t.question)) {
      data.set(t.key, {
        question: t.question || prev?.question || "",
        answerText: t.answerText || prev?.answerText || "",
        answerHtml: t.answerHtml || prev?.answerHtml || "",
      });
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Single-frame (visible turns only) scrape
// ---------------------------------------------------------------------------

export function scrapeCurrentChat(provider: Provider = activeProvider()): Chat {
  const data = new Map<string, TurnData>();
  const raw = collectFrame(provider, data);
  const turns: ChatTurn[] = raw.map((t, i) => {
    const d = data.get(t.key)!;
    return { index: i, key: t.key, question: d.question, answerText: d.answerText, answerHtml: d.answerHtml };
  });
  return {
    id: conversationId(provider),
    title: deriveTitle(provider, turns),
    url: location.href,
    source: provider.id,
    scrapedAt: new Date().toISOString(),
    turns,
  };
}

export function hasConversation(provider: Provider = activeProvider()): boolean {
  if (provider.mode === "container") return document.querySelector(provider.turnSelector!) !== null;
  return streamMessages(provider).length > 0;
}

// ---------------------------------------------------------------------------
// Loading / generating detection
// ---------------------------------------------------------------------------

function isElementVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.offsetParent === null && getComputedStyle(h).position !== "fixed") return false;
  if (el.getClientRects().length === 0) return false;
  const s = getComputedStyle(h);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
}

function anyVisible(selectors: string[]): boolean {
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (isElementVisible(el)) return true;
    }
  }
  return false;
}

export function isLoadingOlder(provider: Provider = activeProvider()): boolean {
  return anyVisible(provider.loadingSelectors);
}

export function isGenerating(provider: Provider = activeProvider()): boolean {
  return anyVisible(provider.generatingSelectors);
}

// ---------------------------------------------------------------------------
// Scroll container discovery
// ---------------------------------------------------------------------------

function isScrollable(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  const oy = style.overflowY;
  return (oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 4;
}

export function findScrollContainer(provider: Provider = activeProvider()): HTMLElement | null {
  const anchorSel =
    provider.mode === "container"
      ? provider.turnSelector!
      : provider.messageSelectors?.[0] ??
        provider.userSelectors?.[0] ??
        provider.assistantSelectors?.[0] ??
        "main";
  const anchor = document.querySelector(anchorSel);
  if (anchor) {
    let node: HTMLElement | null = anchor.parentElement;
    while (node && node !== document.body) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }
  }
  for (const sel of provider.scrollContainerSelectors) {
    for (const c of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (isScrollable(c)) return c;
    }
  }
  const root = (document.scrollingElement as HTMLElement | null) || document.documentElement;
  if (root && root.scrollHeight > root.clientHeight + 4) return root;
  return null;
}

// ---------------------------------------------------------------------------
// Ordering: overlap-stitch (unchanged — works on opaque key lists)
// ---------------------------------------------------------------------------

export function stitchOrder(ordered: string[], snap: string[]): string[] {
  if (snap.length === 0) return ordered;
  if (ordered.length === 0) return [...snap];

  const maxM = Math.min(snap.length, ordered.length);

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

  const have = new Set(ordered);
  const extra = snap.filter((k) => !have.has(k));
  return extra.length ? [...ordered, ...extra] : ordered;
}

// ---------------------------------------------------------------------------
// Full-conversation auto-scroll capture
// ---------------------------------------------------------------------------

export interface ScrapeOptions {
  scrollDelayMs?: number;
  stepFraction?: number;
  maxIterations?: number;
  maxDurationMs?: number;
  loadWaitMs?: number;
  stableRounds?: number;
  onProgress?: (info: { turns: number; iteration: number; atTop: boolean; loading: boolean }) => void;
  onSnapshot?: (chat: Chat) => void;
  snapshotIntervalMs?: number;
  /** Provider override (defaults to the active page's provider). */
  provider?: Provider;
}

const SCRAPE_DEFAULTS: Required<Omit<ScrapeOptions, "onProgress" | "onSnapshot" | "provider">> = {
  scrollDelayMs: 350,
  stepFraction: 0.7,
  maxIterations: 1000,
  maxDurationMs: 300_000,
  loadWaitMs: 12_000,
  stableRounds: 3,
  snapshotIntervalMs: 4000,
};

function buildChat(provider: Provider, ordered: string[], data: Map<string, TurnData>): Chat {
  const turns: ChatTurn[] = ordered.map((key, i) => {
    const d = data.get(key)!;
    return { index: i, key, question: d.question, answerText: d.answerText, answerHtml: d.answerHtml };
  });
  return {
    id: conversationId(provider),
    title: deriveTitle(provider, turns),
    url: location.href,
    source: provider.id,
    scrapedAt: new Date().toISOString(),
    turns,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function scrollTo(container: HTMLElement, top: number) {
  container.scrollTop = top;
  container.dispatchEvent(new Event("scroll", { bubbles: true }));
}

export async function scrapeFullChat(opts: ScrapeOptions = {}): Promise<Chat> {
  const provider = opts.provider ?? activeProvider();
  const cfg = { ...SCRAPE_DEFAULTS, ...opts };
  const container = findScrollContainer(provider);
  if (!container) return scrapeCurrentChat(provider);

  const data = new Map<string, TurnData>();
  let ordered: string[] = [];
  let lastSnapshot = 0;

  const scan = () => {
    ordered = stitchOrder(ordered, collectFrame(provider, data).map((t) => t.key));
  };

  const maybeSnapshot = () => {
    if (!cfg.onSnapshot) return;
    const t = Date.now();
    if (t - lastSnapshot < cfg.snapshotIntervalMs) return;
    lastSnapshot = t;
    if (ordered.length) {
      try {
        cfg.onSnapshot(buildChat(provider, ordered, data));
      } catch {
        /* persistence is best-effort; never let it abort the scrape */
      }
    }
  };

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

    if (isLoadingOlder(provider)) {
      const waitStart = Date.now();
      while (isLoadingOlder(provider) && Date.now() - waitStart < cfg.loadWaitMs) {
        await sleep(250);
      }
      await sleep(cfg.scrollDelayMs);
    }

    scan();

    let grew = container.scrollHeight > lastHeight + 4;
    lastHeight = container.scrollHeight;
    let atTop = container.scrollTop <= 2;
    let addedNew = ordered.length - before;

    if (atTop && !grew && addedNew === 0 && !isLoadingOlder(provider)) {
      const beforeBounce = ordered.length;
      scrollTo(container, Math.min(container.scrollHeight, container.clientHeight));
      await sleep(cfg.scrollDelayMs);
      scrollTo(container, 0);
      await sleep(cfg.scrollDelayMs);
      if (isLoadingOlder(provider)) {
        const waitStart = Date.now();
        while (isLoadingOlder(provider) && Date.now() - waitStart < cfg.loadWaitMs) {
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

    cfg.onProgress?.({ turns: ordered.length, iteration: i, atTop, loading: isLoadingOlder(provider) });
    maybeSnapshot();

    if (atTop && !grew && addedNew === 0 && !isLoadingOlder(provider)) {
      if (++stable >= cfg.stableRounds) break;
    } else {
      stable = 0;
    }
  }

  scrollTo(container, container.scrollHeight);
  await sleep(cfg.scrollDelayMs);
  scan();

  return buildChat(provider, ordered, data);
}
