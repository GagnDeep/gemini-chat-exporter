// Compose view — send new messages to Gemini straight from the archive.
//
// Picking a conversation (or "New chat") shows its live transcript, sourced from
// the same collected_chats store the rest of the archive reads. Sending routes
// through the background worker's SEND_TO_GEMINI handler, which focuses (or
// opens) the right Gemini tab and types + submits the prompt. The live recorder
// on the Gemini page then mirrors Gemini's answer back into the archive, so the
// transcript here grows on its own — no manual re-capture needed.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { useChats, useChatMeta } from "./store";
import { displayTitle } from "@/lib/meta";
import { sanitizeAnswerHtml } from "./sanitize";
import { navigate, chatLink } from "./App";
import { showToast } from "./toast";
import * as I from "./icons";

const NEW_CHAT = "__new__";

export function ComposeView() {
  const chats = useChats();
  const meta = useChatMeta();
  const [selected, setSelected] = useState<string>(NEW_CHAT);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ msg: string; kind: "" | "ok" | "err" }>({ msg: "", kind: "" });
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Most-recently-updated chats first, so the picker surfaces active ones.
  const sortedChats = useMemo(
    () => [...chats].sort((a, b) => (b.scrapedAt || "").localeCompare(a.scrapedAt || "")),
    [chats],
  );

  const chat = useMemo(
    () => (selected === NEW_CHAT ? undefined : chats.find((c) => c.id === selected)),
    [chats, selected],
  );

  // Track turn count so we can auto-scroll to the newest turn when the live
  // recorder mirrors a fresh answer in.
  const prevCount = useRef(0);
  useEffect(() => {
    const n = chat?.turns.length ?? 0;
    if (n !== prevCount.current) {
      prevCount.current = n;
      const el = bodyRef.current;
      if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }, [chat?.turns.length]);

  // Auto-grow the composer up to its CSS max-height.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  async function send(): Promise<void> {
    const prompt = text.trim();
    if (!prompt || sending) return;
    setSending(true);
    setStatus({ msg: chat ? "Sending to Gemini…" : "Opening a new Gemini chat…", kind: "" });
    try {
      const res = (await browser.runtime.sendMessage({
        type: "SEND_TO_GEMINI",
        text: prompt,
        convId: chat ? chat.id : undefined,
        url: chat?.url || "https://gemini.google.com/app",
      })) as { ok: boolean; error?: string } | undefined;
      if (res?.ok) {
        setText("");
        setStatus({ msg: "Sent — Gemini is answering. It'll appear here once it's done.", kind: "ok" });
        showToast("Message sent to Gemini.", "ok");
      } else {
        setStatus({ msg: res?.error || "Couldn't send the message.", kind: "err" });
      }
    } catch (e) {
      setStatus({ msg: e instanceof Error ? e.message : "Couldn't send the message.", kind: "err" });
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="compose-wrap">
      <div className="compose-head">
        <h1>Chat</h1>
        <div className="compose-picker">
          <label>Conversation</label>
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value={NEW_CHAT}>➕ New chat</option>
            {sortedChats.map((c) => (
              <option key={c.id} value={c.id}>
                {displayTitle(meta, c.id, c.title)} · {c.turns.length} Q&amp;A
              </option>
            ))}
          </select>
          {chat && (
            <button className="btn ghost" title="Open in reader"
              onClick={() => navigate(chatLink(chat.id))}>
              <I.Open size={15} /> Open in reader
            </button>
          )}
        </div>
      </div>

      <div className="compose-body" ref={bodyRef}>
        {!chat && (
          <div className="compose-empty">
            <I.Sparkle size={30} />
            <p><strong>Start a new conversation</strong></p>
            <p className="sub">Type below and hit send. A Gemini tab opens, your message is sent, and the reply is mirrored here automatically.</p>
          </div>
        )}
        {chat && chat.turns.length === 0 && (
          <div className="compose-empty"><p className="sub">No turns captured yet.</p></div>
        )}
        {chat?.turns.map((t) => (
          <div key={t.key ?? t.index} className="compose-turn">
            {t.question && (
              <div className="compose-msg user">
                <div className="compose-bubble">{t.question}</div>
              </div>
            )}
            <div className="compose-msg model">
              <div className="compose-answer"
                dangerouslySetInnerHTML={{ __html: sanitizeAnswerHtml(t.answerHtml) || `<p>${escapeText(t.answerText)}</p>` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="compose-footer">
        {status.msg && <div className={"compose-status status " + status.kind}>{status.msg}</div>}
        <div className="compose-input">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={chat ? "Reply to this conversation…" : "Message Gemini to start a new chat…"}
          />
          <button className="btn primary compose-send" disabled={sending || !text.trim()} onClick={() => void send()}>
            {sending ? <span className="spinner" /> : <I.Send size={16} />}
            Send
          </button>
        </div>
        <p className="compose-hint">Enter to send · Shift+Enter for a newline · replies are saved to your archive automatically</p>
      </div>
    </div>
  );
}

function escapeText(s: string): string {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
}
