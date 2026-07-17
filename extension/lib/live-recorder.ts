// Live-mirror recorder — provider-driven.
//
// While the user is on ANY supported conversation (Gemini, Claude, ChatGPT), this
// watches for newly-completed turns and saves them into the archive automatically
// — so a chat you're actively having is captured as it happens, with zero clicks.
// It records only what's currently rendered (new messages), never back-scrolling
// for old history; a full back-fill is what the explicit "Capture full chat"
// action is for.
//
// Design goals:
//   • Never interfere with the site. Read-only DOM access, no scrolling, no clicks.
//   • Never double-write. A per-turn content signature gates redundant commits.
//   • Never capture a half-streamed answer. Wait for generation to finish and for
//     the DOM to settle (debounce) before reading.
//   • Never throw into the page. Every path is guarded; failures are silent.
//   • Survive SPA navigation between conversations without re-initializing.

import { scrapeCurrentChat, hasConversation, isGenerating, getConversationMeta } from "./scraper";
import { commitChat, turnContentSig } from "./chats-store";
import { getSettings } from "./settings";
import { activeProvider, type Provider } from "./providers";

const SETTLE_MS = 1400; // quiet period after the last mutation before we read
const MIN_GAP_MS = 800; // floor between commits, even under heavy mutation

let started = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastCommitAt = 0;
/** conversationId → signature of the last turn we committed, to skip no-ops. */
const lastSigByConv = new Map<string, string>();

function tailFingerprint(provider: Provider): { convId: string; sig: string; turns: number } | null {
  try {
    if (!hasConversation(provider)) return null;
    const meta = getConversationMeta(provider);
    const chat = scrapeCurrentChat(provider);
    if (!chat.turns.length) return null;
    const last = chat.turns[chat.turns.length - 1];
    const sig = turnContentSig(last.question, last.answerText) || `${last.question}|${last.answerText.length}`;
    return { convId: meta.id, sig, turns: chat.turns.length };
  } catch {
    return null;
  }
}

async function maybeCommit(provider: Provider): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.autoMirror) return;
    if (isGenerating(provider)) return; // don't capture mid-stream
    if (Date.now() - lastCommitAt < MIN_GAP_MS) return;

    const fp = tailFingerprint(provider);
    if (!fp) return;
    if (lastSigByConv.get(fp.convId) === fp.sig) return; // nothing new finished

    const chat = scrapeCurrentChat(provider);
    if (!chat.turns.length) return;

    await commitChat(chat, "merge");
    lastCommitAt = Date.now();
    lastSigByConv.set(fp.convId, fp.sig);
  } catch {
    /* best-effort; never disturb the page */
  }
}

function scheduleCommit(provider: Provider): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void maybeCommit(provider);
  }, SETTLE_MS);
}

/** Begin observing. Idempotent — safe to call once from a content script. */
export function startLiveRecorder(provider: Provider = activeProvider()): void {
  if (started) return;
  started = true;

  const observer = new MutationObserver(() => scheduleCommit(provider));
  const attach = () => {
    try {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch {
      setTimeout(attach, 500);
    }
  };
  attach();

  // SPA route changes swap the whole conversation without a page load. Poll the
  // URL cheaply and force a re-evaluation so switching chats starts recording the
  // new one promptly (the MutationObserver also fires; this is just a backstop).
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      scheduleCommit(provider);
    }
  }, 1500);

  setTimeout(() => scheduleCommit(provider), 2500);
}
