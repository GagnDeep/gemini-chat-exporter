// Tiny, dependency-free Markdown → HTML renderer.
//
// The history RPC returns answers as Markdown (unlike the DOM scraper, which
// reads rendered HTML). We store the Markdown verbatim as `answerText` (great
// for search + previews) and render this HTML into `answerHtml` for the reader.
//
// Deliberately small and SAFE: the whole input is HTML-escaped first, so no raw
// markup from the model can inject nodes; we then re-introduce only a fixed set
// of structural tags. The archive additionally runs `sanitizeAnswerHtml` on
// display, so this is defense-in-depth, not the only guard.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inline spans: code, bold, italic, links. Input is already HTML-escaped. */
function renderInline(text: string): string {
  let out = text;
  // inline code first so its contents aren't further formatted
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // links [text](url) — only http(s) URLs are emitted
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safe = /^https?:\/\//i.test(url) ? url : "";
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
  });
  // bold, then italic
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return out;
}

/**
 * Render a Markdown string to a safe HTML fragment. Handles fenced code blocks,
 * ATX headings, unordered/ordered lists, blockquotes, horizontal rules, and
 * paragraphs. Good enough for a faithful, readable answer; not a spec-complete
 * CommonMark implementation.
 */
export function mdToHtml(md: string): string {
  if (!md) return "";
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];

  let i = 0;
  let listType: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(escapeHtml(paragraph.join(" ")))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushParagraph();
      closeList();
      const lang = fence[1].trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      html.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList();
      i++;
      continue;
    }

    // heading
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push("<hr />");
      i++;
      continue;
    }

    // blockquote
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(escapeHtml(quote[1]))}</blockquote>`);
      i++;
      continue;
    }

    // list items
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushParagraph();
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (listType && listType !== want) closeList();
      if (!listType) {
        listType = want;
        html.push(`<${want}>`);
      }
      html.push(`<li>${renderInline(escapeHtml((ul ? ul[1] : ol![1]).trim()))}</li>`);
      i++;
      continue;
    }

    // paragraph text
    closeList();
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  closeList();
  return html.join("\n");
}
