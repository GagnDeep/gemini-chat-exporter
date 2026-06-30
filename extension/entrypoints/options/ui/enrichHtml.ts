// Enriches sanitized answer HTML for the reader: syntax-highlights code blocks
// (highlight.js, with a language label) and renders LaTeX math (KaTeX). Runs in
// the page (DOMParser available), returns an HTML string for React to render.
// Pure + memoizable per chat.

import hljs from "highlight.js/lib/common";
import katex from "katex";

function highlightCode(doc: Document) {
  doc.querySelectorAll("pre > code, pre code").forEach((codeEl) => {
    const pre = codeEl.closest("pre");
    if (!pre || pre.querySelector(".code-lang")) return; // already enriched
    const raw = codeEl.textContent || "";
    if (!raw.trim()) return;
    const cls = codeEl.getAttribute("class") || "";
    const declared = cls.match(/language-([a-z0-9+#-]+)/i)?.[1]?.toLowerCase();
    let lang = declared;
    let html: string;
    try {
      if (declared && hljs.getLanguage(declared)) {
        html = hljs.highlight(raw, { language: declared, ignoreIllegals: true }).value;
      } else {
        const auto = hljs.highlightAuto(raw);
        html = auto.value;
        lang = lang || auto.language || undefined;
      }
    } catch {
      return; // leave the code block untouched on any failure
    }
    codeEl.innerHTML = html;
    codeEl.classList.add("hljs");
    const label = doc.createElement("span");
    label.className = "code-lang";
    label.textContent = lang || "code";
    pre.insertBefore(label, pre.firstChild);
    pre.classList.add("has-lang");
  });
}

// Inline `$...$` is only treated as math when it looks LaTeX-ish, to avoid
// turning prices ("$5 to $10") into math.
const LATEXISH = /[\\^_{}]|\\[a-zA-Z]+/;

function renderMathInText(text: string, doc: Document): DocumentFragment | null {
  // Match $$...$$, \[...\], \(...\), and $...$
  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
  let m: RegExpExecArray | null;
  let last = 0;
  let any = false;
  const frag = doc.createDocumentFragment();
  while ((m = re.exec(text))) {
    const display = m[1] != null || m[2] != null;
    const tex = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    const isInlineDollar = m[4] != null;
    if (isInlineDollar && !LATEXISH.test(tex)) continue; // skip non-math $…$
    if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
    try {
      const span = doc.createElement("span");
      span.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
      frag.appendChild(span);
      any = true;
    } catch {
      frag.appendChild(doc.createTextNode(m[0]));
    }
    last = re.lastIndex;
  }
  if (!any) return null;
  if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
  return frag;
}

function renderMath(doc: Document) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const el = (n as Text).parentElement;
    if (el && el.closest("pre, code")) continue;
    if (((n as Text).nodeValue || "").indexOf("$") === -1 && !/\\[([]/.test((n as Text).nodeValue || "")) continue;
    targets.push(n as Text);
  }
  for (const tn of targets) {
    const frag = renderMathInText(tn.nodeValue || "", doc);
    if (frag) tn.parentNode?.replaceChild(frag, tn);
  }
}

export function enrichAnswerHtml(sanitizedHtml: string): string {
  if (!sanitizedHtml) return sanitizedHtml;
  try {
    const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");
    highlightCode(doc);
    renderMath(doc);
    return doc.body.innerHTML;
  } catch {
    return sanitizedHtml;
  }
}
