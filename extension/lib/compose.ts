// Send a fresh prompt into an open Gemini conversation.
//
// Runs in the content-script context (same page as the live Gemini UI). The
// archive page can't touch the Gemini DOM directly, so it asks the background
// worker to focus the right tab, and the background forwards a SEND_PROMPT
// message here.
//
// Two things have to happen, in order and robustly:
//   1. Put the user's text into Gemini's composer. It's a Quill `.ql-editor`
//      contenteditable (not a <textarea>), so we drive it through the browser's
//      own editing path (execCommand insertText) which keeps Quill's internal
//      model in sync — naively setting textContent leaves it thinking the box is
//      still empty and the send button stays disabled.
//   2. Click the send button once it enables (it flips from disabled to enabled
//      a tick after the text lands). Enter-key dispatch is the fallback.
//
// Selectors are ordered fallback lists, matching the resilience approach in
// scraper.ts, so a single Google class-name change doesn't break sending.

import { isGenerating } from "./scraper";

const COMPOSER_SELECTORS = [
  "rich-textarea .ql-editor[contenteditable='true']",
  ".ql-editor[contenteditable='true']",
  "div[contenteditable='true'][role='textbox']",
  "textarea[aria-label*='prompt' i]",
  "textarea[aria-label*='Enter a prompt' i]",
  "textarea",
];

const SEND_SELECTORS = [
  "button.send-button",
  "button[aria-label*='Send' i]",
  "[data-test-id='send-button']",
  "button[mattooltip*='Send' i]",
];

/** True when an element is actually laid out and visible (not a hidden clone). */
function isVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.offsetParent === null && getComputedStyle(h).position !== "fixed") return false;
  if (el.getClientRects().length === 0) return false;
  const s = getComputedStyle(h);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
}

function firstVisible(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `get` until it returns a truthy value or the timeout elapses. */
async function waitFor<T>(get: () => T | null, timeoutMs: number, intervalMs = 150): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

/** An enabled, visible send button — or null while it's still disabled/absent. */
function findEnabledSend(): HTMLButtonElement | null {
  for (const sel of SEND_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>(sel))) {
      if (!isVisible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      return el;
    }
  }
  return null;
}

/** Replace the composer's current draft with `text`, keeping the editor in sync. */
function setComposerText(el: HTMLElement, text: string): void {
  el.focus();

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // Contenteditable (Quill). Select everything, then insert — execCommand's
  // insertText replaces the selection and fires the editor's own input handling.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  const ok = document.execCommand("insertText", false, text);
  if (!ok) {
    // Fallback for engines that reject execCommand. Fire `beforeinput` FIRST —
    // that's the event Quill's change-detection actually processes to update its
    // internal Delta; setting textContent alone leaves the editor thinking it's
    // still empty (send stays disabled). Then mirror the DOM + trailing `input`.
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
}

/**
 * Type `text` into Gemini's composer and submit it. Waits for the composer to
 * exist (the SPA may still be booting on a freshly-opened tab) and for the send
 * button to enable. Throws with a user-facing message on any failure.
 */
export async function submitPrompt(text: string): Promise<void> {
  const prompt = (text || "").trim();
  if (!prompt) throw new Error("Nothing to send — the message was empty.");

  if (isGenerating()) {
    throw new Error("Gemini is still generating a response. Wait for it to finish, then retry.");
  }

  const editor = await waitFor(() => firstVisible(COMPOSER_SELECTORS), 15_000);
  if (!editor) throw new Error("Couldn't find Gemini's message box on the page.");

  setComposerText(editor, prompt);

  // The send button flips from disabled → enabled a tick after Gemini's editor
  // registers the new text. If it never enables, the text didn't take (Quill's
  // model is still empty) — so this is a hard failure, NOT a silent success:
  // reporting "sent" here would clear the user's draft while nothing was sent.
  const send = await waitFor(findEnabledSend, 4_000);
  if (!send) {
    throw new Error(
      "Gemini didn't accept the message (its Send button stayed disabled). " +
        "Your draft was kept — try again, or reload the Gemini tab.",
    );
  }
  send.click();
}
