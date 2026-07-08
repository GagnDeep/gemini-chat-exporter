// Live-mirror recorder.
//
// While the user is on ANY Gemini conversation, this watches for newly-completed
// turns and saves them into the archive automatically — so a chat you're actively
// having is captured as it happens, with zero clicks. It deliberately records
// only what's currently rendered (new messages), never back-scrolling for old
// history; a full back-fill is what the explicit "Capture full chat" action /
// RPC loader are for.
//
// Design goals:
//   • Never interfere with Gemini. Read-only DOM access, no scrolling, no clicks.
//   • Never double-write. A per-turn content signature gates redundant commits.
//   • Never capture a half-streamed answer. We wait for generation to finish and
//     for the DOM to settle (debounce) before reading.
//   • Never throw into the page. Every path is guarded; failures are silent.
//   • Survive SPA navigation between conversations without re-initializing.

import {
  scrapeCurrentChat,
  hasConversation,
  isGenerating,
  getConversationMeta,
} from "./scraper";
import { commitChat, turnContentSig } from "./chats-store";
import { getSettings } from "./settings";

const SETTLE_MS = 1400; // quiet period after the last mutation before we read
const MIN_GAP_MS = 800; // floor between commits, even under heavy mutation

let started = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastCommitAt = 0;
/** conversationId → signature of the last turn we committed, to skip no-ops. */
const lastSigByConv = new Map<string, string>();

/** Compute a cheap fingerprint of the conversation's tail so we can tell when
 *  something genuinely new has finished rendering. */
function tailFingerprint(): { convId: string; sig: string; turns: number } | null {
  try {
    if (!hasConversation()) return null;
    const meta = getConversationMeta();
    const chat = scrapeCurrentChat();
    if (!chat.turns.length) return null;
    const last = chat.turns[chat.turns.length - 1];
    const sig = turnContentSig(last.question, last.answerText) || `${last.question}|${last.answerText.length}`;
    return { convId: meta.id, sig, turns: chat.turns.length };
  } catch {
    return null;
  }
}

async function maybeCommit(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.autoMirror) return;
    if (isGenerating()) return; // don't capture mid-stream
    if (Date.now() - lastCommitAt < MIN_GAP_MS) return;

    const fp = tailFingerprint();
    if (!fp) return;
    if (lastSigByConv.get(fp.convId) === fp.sig) return; // nothing new finished

    const chat = scrapeCurrentChat();
    if (!chat.turns.length) return;

    await commitChat(chat, "merge");
    lastCommitAt = Date.now();
    lastSigByConv.set(fp.convId, fp.sig);
  } catch {
    /* best-effort; never disturb the page */
  }
}

function scheduleCommit(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void maybeCommit();
  }, SETTLE_MS);
}

/** Begin observing. Idempotent — safe to call once from the content script. */
export function startLiveRecorder(): void {
  if (started) return;
  started = true;

  const observer = new MutationObserver(() => scheduleCommit());
  const attach = () => {
    try {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch {
      /* body not ready yet — retry shortly */
      setTimeout(attach, 500);
    }
  };
  attach();

  // SPA route changes swap the whole conversation without a page load. Poll the
  // URL cheaply and force a re-evaluation so switching chats starts recording the
  // new one promptly (the MutationObserver also fires, this is just a backstop).
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      scheduleCommit();
    }
  }, 1500);

  // One initial pass shortly after load, in case the user lands directly on an
  // in-progress chat that then finishes.
  setTimeout(() => scheduleCommit(), 2500);
}
