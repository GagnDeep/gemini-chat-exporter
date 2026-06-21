"use client";

// Renders Gemini's answer HTML. The HTML was sanitized at scrape time AND again
// on import (see lib/sanitize.ts), so this is safe to render directly into a
// constrained, styled container. After mount we progressively enhance it:
//   • code blocks get a language label + a copy button
//   • external links open in a new tab safely

import { useEffect, useRef } from "react";

export function AnswerHtml({ html, text }: { html?: string; text?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    // Harden links.
    root.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });

    // Enhance code blocks (idempotent — skip ones we've already wrapped).
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.dataset.enhanced === "1") return;
      pre.dataset.enhanced = "1";
      const code = pre.querySelector("code");
      const cls = code?.className || "";
      const lang = (cls.match(/language-([\w+#.-]+)/) || [])[1];

      const bar = document.createElement("div");
      bar.className = "code-bar";

      const label = document.createElement("span");
      label.className = "code-lang";
      label.textContent = lang ? lang : "code";
      bar.appendChild(label);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const txt = (code?.textContent ?? pre.textContent) || "";
        try {
          await navigator.clipboard.writeText(txt);
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy"), 1500);
        } catch {
          btn.textContent = "Failed";
          setTimeout(() => (btn.textContent = "Copy"), 1500);
        }
      });
      bar.appendChild(btn);

      pre.classList.add("has-bar");
      pre.insertBefore(bar, pre.firstChild);
    });
  }, [html, text]);

  if (html && html.trim()) {
    return <div ref={ref} className="answer-html" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div className="answer-html whitespace-pre-wrap">{text}</div>;
}
