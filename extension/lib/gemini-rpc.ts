// Programmatic Gemini history loader.
//
// Instead of synthetically scrolling the virtualized conversation (slow, and a
// more bot-like signal than a normal API call), this module talks to the *same*
// internal RPC the Gemini web app itself uses to page in turns:
//
//   POST https://gemini.google.com/u/<n>/_/BardChatUi/data/batchexecute
//        ?rpcids=hNvQHb&...     (the conversation-history RPC)
//
// Empirically validated live (July 2026) against gemini.google.com:
//   • request arg:  [convId, pageSize, cursor, 1, [1], [4], null, 1]
//        - convId  : "c_<conversationId>"  (the id from the /app/<id> URL, c_-prefixed)
//        - pageSize : how many turns to return (the app uses 10; larger values
//                     are honoured — a single pageSize:100 call returned an
//                     entire 54-turn chat with status 200)
//        - cursor   : null for the newest page; the previous response's cursor
//                     to page further back in time
//   • response inner: [ turns[], nextCursor|null, null, meta ]
//   • per turn:  question       = turn[2][0][0]
//                answer markdown = turn[3][0][0][1][0]
//                responseId      = turn[0][1]   ("r_…", stable per turn)
//                timestamp       = turn[4]      ([seconds, nanos], newest-first
//                                                within a page)
//
// Because the call runs inside the Gemini page (content-script context) with
// `credentials: "include"`, it carries the user's own cookies + XSRF token and
// is indistinguishable from the app's own request. It performs NO scrolling and
// touches the DOM only to read the page's WIZ tokens.
//
// Everything here is defensive: token discovery, envelope parsing, and per-turn
// field extraction all have fallbacks, and the caller (content script) keeps the
// auto-scroll scraper as a fallback path, toggled by a setting.

import type { Chat, ChatTurn } from "./types";
import { mdToHtml } from "./md-to-html";

/** The conversation-history RPC id (validated live). Kept in one place so a
 *  future rename is a one-line change. */
export const HISTORY_RPC = "hNvQHb";

// ---------------------------------------------------------------------------
// Main-world bridge transport
//
// The tokens + authenticated fetch live in the MAIN-world bridge
// (entrypoints/gemini-world.content.ts) because this module runs in the ISOLATED
// content-script world, which cannot see `window.WIZ_global_data`. We reach the
// bridge over window.postMessage and it returns the raw batchexecute response
// text, which we parse here.
// ---------------------------------------------------------------------------

const BRIDGE_REQ = "GCE_RPC_REQ";
const BRIDGE_RES = "GCE_RPC_RES";

let bridgeSeq = 0;

interface BridgeReply {
  ok: boolean;
  status?: number;
  text?: string;
  error?: string;
}

/** Post a message to the main-world bridge and await its matching reply. */
function bridgeCall(
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<BridgeReply> {
  return new Promise((resolve) => {
    const id = `gce-${++bridgeSeq}-${Date.now()}`;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d = e.data as (BridgeReply & { source?: string; id?: string }) | undefined;
      if (!d || d.source !== BRIDGE_RES || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(d);
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "bridge-timeout" });
    }, timeoutMs);
    window.addEventListener("message", onMsg);
    window.postMessage({ source: BRIDGE_REQ, id, ...message }, location.origin);
  });
}

/** True when the main-world bridge is present AND the page exposes session
 *  tokens — i.e. the fast RPC path is usable right now. */
export async function canUseRpc(): Promise<boolean> {
  const res = await bridgeCall({ ping: true }, 2000);
  return res.ok === true;
}

/** "c_<id>" form of the conversation id the RPC expects, from the page URL. */
export function conversationRpcId(url = location.href): string {
  let path = url;
  try {
    path = new URL(url, location.href).pathname;
  } catch {
    /* use raw */
  }
  const last = path.split("/").filter(Boolean).pop() || "";
  const id = last.split("?")[0];
  return id.startsWith("c_") ? id : "c_" + id;
}

/**
 * Robustly extract the first complete top-level JSON array from a batchexecute
 * response body (which is `)]}'\n\n<len>\n<json>\n<len>\n<json>…`). Length
 * prefixes are byte counts that desync from JS UTF-16 offsets on multibyte
 * content, so we bracket-scan (string/escape aware) instead of trusting them.
 */
function extractFirstArray(raw: string): unknown[] {
  const afterPrefix = raw.replace(/^\)\]\}'\s*/, "");
  const start = afterPrefix.indexOf("[");
  if (start < 0) throw new Error("Gemini response had no JSON payload.");
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let k = start; k < afterPrefix.length; k++) {
    const ch = afterPrefix[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = k + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error("Gemini response JSON was truncated.");
  return JSON.parse(afterPrefix.slice(start, end)) as unknown[];
}

/** Low-level: call a single batchexecute RPC (via the main-world bridge) and
 *  return its parsed inner value. Throws when the bridge is unavailable or the
 *  request fails, so callers can fall back to the scroll scraper. */
export async function callRpc(rpcid: string, arg: unknown, timeoutMs = 25_000): Promise<unknown> {
  const res = await bridgeCall({ rpcid, arg }, timeoutMs);
  if (!res.ok || typeof res.text !== "string") {
    throw new Error(`Gemini RPC ${rpcid} failed (${res.error || "HTTP " + res.status}).`);
  }
  const rows = extractFirstArray(res.text);
  const row = (rows as unknown[][]).find(
    (r) => Array.isArray(r) && r[0] === "wrb.fr" && r[1] === rpcid,
  ) as unknown[] | undefined;
  if (!row || typeof row[2] !== "string") {
    // A row with no payload string means "no data" (e.g. empty result), not an
    // error — return null so callers can treat it as an empty page.
    return null;
  }
  return JSON.parse(row[2] as string);
}

// ---------------------------------------------------------------------------
// Turn extraction
// ---------------------------------------------------------------------------

interface RawTurn {
  question: string;
  answerMarkdown: string;
  responseId: string;
  sortKey: number;
}

/** Deep-find the longest string in a subtree — a resilient fallback used when a
 *  primary path (question/answer) doesn't resolve to the expected string. */
function longestString(node: unknown, depth = 0): string {
  if (depth > 9) return "";
  if (typeof node === "string") return node;
  if (!Array.isArray(node)) return "";
  let best = "";
  for (const child of node) {
    const s = longestString(child, depth + 1);
    if (s.length > best.length) best = s;
  }
  return best;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Extract {question, answerMarkdown, responseId, timestamp} from one raw turn.
 *  Primary paths are validated live; each has a defensive fallback. */
export function parseRawTurn(turn: unknown): RawTurn | null {
  if (!Array.isArray(turn)) return null;
  const t = turn as unknown[];

  // question: turn[2][0][0]
  let question = asString((((t[2] as unknown[])?.[0]) as unknown[])?.[0]);
  if (!question) question = longestString(t[2]);

  // answer markdown: turn[3][0][0][1][0]
  const t3 = t[3] as unknown[] | undefined;
  let answerMarkdown = asString(
    ((((t3?.[0] as unknown[])?.[0] as unknown[])?.[1]) as unknown[])?.[0],
  );
  if (!answerMarkdown) answerMarkdown = longestString(t3);

  // responseId: turn[0][1]
  const responseId = asString((t[0] as unknown[])?.[1]) || asString((t[0] as unknown[])?.[0]);

  // timestamp: turn[4] = [seconds, nanos]; newest-first within a page.
  const ts = t[4] as unknown[] | undefined;
  const sec = typeof ts?.[0] === "number" ? (ts[0] as number) : 0;
  const nanos = typeof ts?.[1] === "number" ? (ts[1] as number) : 0;
  const sortKey = sec * 1e9 + nanos;

  if (!question && !answerMarkdown) return null;
  return { question, answerMarkdown, responseId, sortKey };
}

export interface RpcScrapeOptions {
  /** Turns fetched per request (the app uses 10; larger is faster & accepted). */
  pageSize?: number;
  /** Hard cap on pages fetched, so a runaway never loops forever. */
  maxPages?: number;
  /** Polite delay between page fetches (ms) to mirror organic paging. */
  pageDelayMs?: number;
  /** Overall wall-clock cap. */
  maxDurationMs?: number;
  /** Fired after each page with the turns accumulated so far. */
  onProgress?: (info: { turns: number; page: number; done: boolean }) => void;
  /** Periodic partial-result callback so progress can be persisted incrementally. */
  onSnapshot?: (chat: Chat) => void;
}

const RPC_DEFAULTS: Required<Omit<RpcScrapeOptions, "onProgress" | "onSnapshot">> = {
  pageSize: 50,
  maxPages: 200,
  pageDelayMs: 220,
  maxDurationMs: 180_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function titleFromDoc(): string {
  const t = (typeof document !== "undefined" ? document.title : "").replace(
    /\s*-\s*Google Gemini\s*$/i,
    "",
  ).trim();
  return t && !/^gemini$/i.test(t) ? t : "";
}

/** Turn a de-duplicated, chronologically-sorted RawTurn list into a Chat. */
function buildChatFromRaw(raw: RawTurn[], convUrl: string): Chat {
  const turns: ChatTurn[] = raw.map((r, i) => ({
    index: i,
    // Prefer Gemini's own stable response id; this survives re-scrapes and never
    // collides across turns. The store's content-signature dedup reconciles it
    // with DOM-scraped copies of the same turn.
    key: r.responseId ? `r:${r.responseId}` : undefined,
    question: r.question,
    answerText: r.answerMarkdown,
    answerHtml: mdToHtml(r.answerMarkdown),
  }));
  const id = conversationRpcId(convUrl).replace(/^c_/, "");
  const title =
    titleFromDoc() ||
    (turns.find((t) => t.question?.trim())?.question || "").slice(0, 70) ||
    "Untitled chat";
  return {
    id,
    title,
    url: convUrl,
    scrapedAt: new Date().toISOString(),
    turns,
  };
}

/**
 * Load a full conversation by paging the history RPC from newest to oldest,
 * following the response cursor until it runs out. Turns are de-duplicated by
 * responseId and sorted ascending by timestamp, so the result is correct
 * regardless of intra-page ordering. NO scrolling is performed.
 *
 * Throws if the page tokens aren't available or the first call fails — the
 * caller falls back to the auto-scroll scraper in that case.
 */
export async function scrapeFullChatViaRpc(opts: RpcScrapeOptions = {}): Promise<Chat> {
  const cfg = { ...RPC_DEFAULTS, ...opts };
  if (!(await canUseRpc())) {
    throw new Error("Gemini history RPC unavailable (bridge or session tokens missing).");
  }

  const convId = conversationRpcId();
  const convUrl = location.href;
  const byId = new Map<string, RawTurn>();
  const seen: RawTurn[] = []; // insertion order kept for keyless turns

  let cursor: string | null = null;
  let page = 0;
  const start = Date.now();

  do {
    const arg = [convId, cfg.pageSize, cursor, 1, [1], [4], null, 1];
    const inner = (await callRpc(HISTORY_RPC, arg)) as unknown[] | null;
    page++;

    const rawTurns = Array.isArray(inner?.[0]) ? (inner![0] as unknown[]) : [];
    for (const rt of rawTurns) {
      const parsed = parseRawTurn(rt);
      if (!parsed) continue;
      const dedupeKey = parsed.responseId || `q:${parsed.question}␟${parsed.answerMarkdown.slice(0, 80)}`;
      if (byId.has(dedupeKey)) {
        // Keep the richer copy (streaming edge cases can yield a shorter one).
        const prev = byId.get(dedupeKey)!;
        if (parsed.answerMarkdown.length > prev.answerMarkdown.length) byId.set(dedupeKey, parsed);
      } else {
        byId.set(dedupeKey, parsed);
        seen.push(parsed);
      }
    }

    const next = inner && typeof inner[1] === "string" ? (inner[1] as string) : null;
    cursor = next;

    // Sort what we have so far and emit a snapshot for incremental persistence.
    const ordered = [...byId.values()].sort((a, b) => a.sortKey - b.sortKey || seen.indexOf(a) - seen.indexOf(b));
    cfg.onProgress?.({ turns: ordered.length, page, done: !cursor });
    if (cfg.onSnapshot) {
      try {
        cfg.onSnapshot(buildChatFromRaw(ordered, convUrl));
      } catch {
        /* persistence is best-effort */
      }
    }

    if (!cursor) break;
    if (page >= cfg.maxPages) break;
    if (Date.now() - start > cfg.maxDurationMs) break;
    if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs);
  } while (cursor);

  const ordered = [...byId.values()].sort(
    (a, b) => a.sortKey - b.sortKey || seen.indexOf(a) - seen.indexOf(b),
  );
  return buildChatFromRaw(ordered, convUrl);
}
