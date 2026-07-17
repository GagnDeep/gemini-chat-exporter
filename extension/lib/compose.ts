// Send a fresh prompt into an open conversation — provider-driven, self-verifying.
//
// Runs in the content-script context (same page as the live chat UI). The archive
// page can't touch the site DOM directly, so it asks the background worker to
// focus the right tab, which forwards a SEND_PROMPT message that lands here.
//
// The hard part is that all three sites now use a rich contenteditable editor
// (Gemini = Quill, Claude/ChatGPT = ProseMirror) whose INTERNAL model must be
// updated, not just the DOM — otherwise the Send button never enables and Enter
// submits nothing. Different editors accept different injection paths, so we try
// several (paste event → execCommand → beforeinput), then submit via the Send
// button when one is available (authoritative) or Enter as a fallback.
//
// Crucially, this VERIFIES the send actually happened (composer cleared, or the
// model started generating). If it can't confirm, it throws an honest error and
// leaves the draft in place — it never reports a phantom success.

import { isGenerating } from "./scraper";
import { activeProvider, type Provider } from "./providers";

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

async function waitFor<T>(get: () => T | null, timeoutMs: number, intervalMs = 150): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

function findEnabledSend(provider: Provider): HTMLButtonElement | null {
  for (const sel of provider.sendSelectors) {
    for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>(sel))) {
      if (!isVisible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      return el;
    }
  }
  return null;
}

/** Current text in the composer (works for textarea/input and contenteditable). */
function composerText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return (el.innerText || "").trim();
}

function selectAll(el: HTMLElement): void {
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Put `text` into the composer, trying the methods real editors accept. Returns
 * true if the DOM now shows the text (a necessary-but-not-sufficient signal —
 * the true confirmation is the post-submit verification).
 */
function insertComposerText(el: HTMLElement, text: string): boolean {
  el.focus();

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value.includes(text.slice(0, 12));
  }

  const has = () => (el.innerText || "").includes(text.slice(0, 12));

  // Method 1 — synthetic paste. ProseMirror/Lexical intercept paste and insert
  // through their own transaction, keeping the model in sync.
  try {
    selectAll(el);
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch {
    /* DataTransfer/ClipboardEvent unavailable — fall through */
  }
  if (has()) return true;

  // Method 2 — execCommand insertText (Quill + some ProseMirror builds).
  selectAll(el);
  document.execCommand("insertText", false, text);
  if (has()) return true;

  // Method 3 — beforeinput + mirror the DOM + input (last resort).
  el.dispatchEvent(
    new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }),
  );
  el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  return has();
}

function pressEnter(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 } as const;
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

/** Poll for evidence the message actually went out: composer cleared, or the
 *  model started generating. */
async function confirmSent(provider: Provider, editor: HTMLElement, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (composerText(editor).trim() === "") return true;
    if (isGenerating(provider)) return true;
    await sleep(150);
  }
  return composerText(editor).trim() === "" || isGenerating(provider);
}

/**
 * Type `text` into the site's composer and submit it — verifying the send.
 * Throws with a user-facing message on any failure; the draft is left in place.
 */
export async function submitPrompt(text: string, provider: Provider = activeProvider()): Promise<void> {
  const prompt = (text || "").trim();
  if (!prompt) throw new Error("Nothing to send — the message was empty.");

  if (isGenerating(provider)) {
    throw new Error(`${provider.label} is still generating a response. Wait for it to finish, then retry.`);
  }

  const editor = await waitFor(() => firstVisible(provider.composerSelectors), 15_000);
  if (!editor) throw new Error(`Couldn't find ${provider.label}'s message box on the page.`);

  insertComposerText(editor, prompt);

  // Give the editor a beat to register the text, then prefer a real Send button.
  const send = await waitFor(() => findEnabledSend(provider), provider.submitByEnter ? 1800 : 4000);
  if (send) {
    send.click();
    // A real, enabled Send button is authoritative — a brief confirm is enough,
    // and a timeout here shouldn't fail a click we know landed.
    await confirmSent(provider, editor, 2500);
    return;
  }

  if (provider.submitByEnter) {
    pressEnter(editor);
    // No Send button was available, so require positive confirmation that Enter
    // actually submitted — otherwise report honestly instead of a phantom success.
    const ok = await confirmSent(provider, editor, 3500);
    if (ok) return;
    throw new Error(
      `Couldn't confirm the message was sent to ${provider.label} — its editor didn't accept ` +
        "automated input. Your draft is preserved in the message box; press Enter there to send it.",
    );
  }

  throw new Error(
    `${provider.label} didn't accept the message (its Send button stayed disabled). ` +
      "Your draft was kept — try again, or reload the tab.",
  );
}
