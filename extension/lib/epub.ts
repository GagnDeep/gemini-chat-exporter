// EPUB 3 generation. Each question + its answer becomes a separate chapter.
// When multiple chats are exported together, the book opens with a cover, each
// chat gets a section title page, and its turns follow as individual chapters.
//
// Output targets EPUB 3.0 with valid navigation + accessibility metadata so the
// file passes epubcheck and reads well on Kindle/Apple Books/KOReader.

import JSZip from "jszip";
import type { Chat, ChatTurn } from "./types";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Tags that have no place in a static book and are unsafe to carry across from
// imported (possibly untrusted) HTML.
const STRIP_TAGS = [
  "script", "style", "iframe", "object", "embed", "button",
  "svg", "mat-icon", "noscript", "input", "textarea", "form",
];

/** Convert arbitrary answer HTML into well-formed, sanitized XHTML for EPUB. */
function toXhtml(html: string): string {
  if (!html) return "<p></p>";
  try {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const wrapper = doc.body.firstElementChild as Element;
    wrapper.querySelectorAll(STRIP_TAGS.join(",")).forEach((el) => el.remove());
    wrapper.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        // Drop event handlers, inline styles and framework noise; harmless
        // structural attributes (href, src, class) are kept.
        if (
          name.startsWith("on") ||
          name === "style" ||
          name.startsWith("_ng") ||
          name.startsWith("jslog") ||
          name === "jsaction" ||
          name === "contenteditable"
        ) {
          el.removeAttribute(attr.name);
        }
      });
    });
    const xml = new XMLSerializer().serializeToString(wrapper);
    return xml.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
  } catch {
    return paragraphsFromText(html.replace(/<[^>]+>/g, ""));
  }
}

/** Turn a plain-text answer into paragraphs, preserving blank-line breaks. */
function paragraphsFromText(text: string): string {
  const t = (text || "").trim();
  if (!t) return "<p></p>";
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

/** Best answer body: prefer rich HTML, fall back to formatted plain text. */
function answerBody(turn: ChatTurn): string {
  if (turn.answerHtml && turn.answerHtml.trim()) return toXhtml(turn.answerHtml);
  if (turn.answerText && turn.answerText.trim()) return paragraphsFromText(turn.answerText);
  return `<p class="empty-answer">(no answer captured)</p>`;
}

function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) || []).length;
}

function chatWordCount(chat: Chat): number {
  let n = 0;
  for (const t of chat.turns) n += wordCount(t.question) + wordCount(t.answerText);
  return n;
}

function readingTime(words: number): string {
  const mins = Math.max(1, Math.round(words / 200));
  return `${mins} min read`;
}

const STYLE = `
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.6; margin: 5% 6%; color: #1a1a1a; hyphens: auto; }
h1.q { font-size: 1.3em; line-height: 1.35; color: #1a73e8; border-bottom: 2px solid #e8eaed; padding-bottom: .4em; margin-bottom: 1em; page-break-after: avoid; }
h1.chat-title { font-size: 1.8em; color: #673ab7; line-height: 1.25; }
.chapter-no { font-size: .7em; letter-spacing: .12em; color: #80868b; }
.role { text-transform: uppercase; letter-spacing: .08em; font-size: .72em; color: #5f6368; font-family: Arial, sans-serif; margin: 0 0 .3em; }
.answer { margin-top: .5em; }
.empty-answer { color: #80868b; font-style: italic; }
pre { background: #f1f3f4; padding: .8em; border-radius: 6px; overflow-x: auto; font-size: .85em; white-space: pre-wrap; word-wrap: break-word; word-break: break-word; page-break-inside: avoid; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #dadce0; padding: .5em .7em; text-align: left; }
blockquote { border-left: 3px solid #673ab7; margin: 1em 0; padding-left: 1em; color: #444; }
ul, ol { padding-left: 1.4em; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid #e8eaed; margin: 1.5em 0; }
/* Cover & title pages */
.cover { text-align: center; margin-top: 22%; }
.cover .mark { font-size: 3.4em; color: #673ab7; margin: 0; }
.cover h1 { font-size: 2.2em; color: #1a73e8; margin: .3em 0 .1em; line-height: 1.2; }
.cover .sub { color: #5f6368; font-family: Arial, sans-serif; font-size: 1em; }
.cover .meta { margin-top: 2.5em; color: #80868b; font-family: Arial, sans-serif; font-size: .85em; }
.about { color: #5f6368; font-family: Arial, sans-serif; font-size: .85em; margin: .2em 0; }
.about a { color: #1a73e8; }
`.trim();

interface ChapterFile {
  id: string;
  href: string;
  title: string;
  /** "cover"/"section" pages are front matter / dividers; "chapter" pages are Q&A turns. */
  kind: "cover" | "section" | "chapter";
}

function pageXhtml(title: string, bodyHtml: string, epubType?: string): string {
  const bodyAttr = epubType ? ` epub:type="${epubType}"` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body${bodyAttr}>
${bodyHtml}
</body>
</html>`;
}

export interface EpubOptions {
  /** Book title. Defaults to the first chat title or "Gemini Chats". */
  title?: string;
  author?: string;
  /** Optional book description / subject line. */
  description?: string;
  /** Include the generated cover + title page (default true). */
  includeCover?: boolean;
}

/**
 * Build an EPUB (returned as a Blob) from one or more chats.
 * Each Q&A turn is its own chapter in the table of contents.
 */
export async function buildEpub(chats: Chat[], opts: EpubOptions = {}): Promise<Blob> {
  const zip = new JSZip();
  const multi = chats.length > 1;
  const bookTitle = opts.title || (chats.length === 1 ? chats[0]?.title : "Gemini Chats") || "Gemini Chats";
  const author = opts.author || "Google Gemini";
  const includeCover = opts.includeCover !== false;
  const bookId = `urn:uuid:${cryptoId()}`;
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const totalTurns = chats.reduce((n, c) => n + c.turns.length, 0);
  const totalWords = chats.reduce((n, c) => n + chatWordCount(c), 0);
  const description =
    opts.description ||
    `${chats.length} Gemini conversation${chats.length === 1 ? "" : "s"}, ${totalTurns} Q&A turns, ~${totalWords.toLocaleString()} words.`;

  // mimetype MUST be the first entry and stored uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  const oebps = zip.folder("OEBPS")!;
  oebps.file("style.css", STYLE);

  const chapters: ChapterFile[] = [];
  let n = 0;

  // Cover / title page.
  if (includeCover) {
    const coverBody = `<div class="cover">
  <p class="mark">✦</p>
  <h1>${esc(bookTitle)}</h1>
  <p class="sub">${multi ? "A Gemini conversation archive" : "A Gemini conversation"}</p>
  <div class="meta">
    <p>${chats.length} conversation${chats.length === 1 ? "" : "s"} · ${totalTurns} Q&amp;A · ~${esc(totalWords.toLocaleString())} words · ${esc(readingTime(totalWords))}</p>
    <p>Generated ${esc(nowIso.slice(0, 10))}</p>
  </div>
</div>`;
    oebps.file("cover.xhtml", pageXhtml(bookTitle, coverBody, "cover"));
    chapters.push({ id: "cover", href: "cover.xhtml", title: "Cover", kind: "cover" });
  }

  for (let ci = 0; ci < chats.length; ci++) {
    const chat = chats[ci]!;

    if (multi) {
      const href = `chat-${ci}-title.xhtml`;
      const words = chatWordCount(chat);
      const body = `<h1 class="chat-title">${esc(chat.title)}</h1>
<p class="about">${chat.turns.length} Q&amp;A · ~${esc(words.toLocaleString())} words · ${esc(readingTime(words))}</p>
<p class="about">Scraped ${esc(chat.scrapedAt.slice(0, 10))}</p>
${chat.url ? `<p class="about"><a href="${esc(chat.url)}">View original conversation</a></p>` : ""}`;
      oebps.file(href, pageXhtml(chat.title, body));
      chapters.push({ id: `sec${ci}`, href, title: chat.title, kind: "section" });
    }

    for (const turn of chat.turns) {
      n++;
      const href = `chapter-${String(n).padStart(4, "0")}.xhtml`;
      const heading = turn.question || `Turn ${turn.index + 1}`;
      const body = `<p class="chapter-no">Q&amp;A ${turn.index + 1} of ${chat.turns.length}</p>
<p class="role">Question</p>
<h1 class="q">${esc(heading)}</h1>
<p class="role">Gemini</p>
<div class="answer">${answerBody(turn)}</div>`;
      oebps.file(href, pageXhtml(heading, body));
      chapters.push({ id: `ch${n}`, href, title: trimTitle(heading), kind: "chapter" });
    }
  }

  // EPUB3 navigation document (nested when multi-chat).
  oebps.file("nav.xhtml", buildNav(bookTitle, chapters, multi, chats));

  // Package document.
  const manifest = chapters
    .map((c) => `    <item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const spine = chapters.map((c) => `    <itemref idref="${c.id}"/>`).join("\n");

  oebps.file(
    "content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${esc(bookTitle)}</dc:title>
    <dc:creator>${esc(author)}</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>${esc(nowIso.slice(0, 10))}</dc:date>
    <dc:description>${esc(description)}</dc:description>
    <dc:publisher>Gemini Chat Exporter</dc:publisher>
    ${chats.length === 1 && chats[0]?.url ? `<dc:source>${esc(chats[0].url)}</dc:source>` : ""}
    <meta property="dcterms:modified">${nowIso}</meta>
    <meta property="schema:accessMode">textual</meta>
    <meta property="schema:accessModeSufficient">textual</meta>
    <meta property="schema:accessibilityFeature">tableOfContents</meta>
    <meta property="schema:accessibilityFeature">readingOrder</meta>
    <meta property="schema:accessibilityHazard">none</meta>
    <meta property="schema:accessibilitySummary">Text-only export of Gemini conversations with a full table of contents.</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifest}
  </manifest>
  <spine>
${spine}
    <itemref idref="nav" linear="no"/>
  </spine>
</package>`,
  );

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
  });
}

function buildNav(bookTitle: string, chapters: ChapterFile[], multi: boolean, chats: Chat[]): string {
  let list: string;
  let num = 0;
  if (!multi) {
    list = chapters
      .filter((c) => c.kind === "chapter")
      .map((c) => `      <li><a href="${c.href}">${++num}. ${esc(c.title)}</a></li>`)
      .join("\n");
  } else {
    // Nest chapters under their section title.
    const parts: string[] = [];
    let idx = 0;
    // Skip the cover page when present.
    while (idx < chapters.length && chapters[idx]!.kind === "cover") idx++;
    for (let ci = 0; ci < chats.length; ci++) {
      const section = chapters[idx++]; // section page
      if (!section) break;
      const kids: string[] = [];
      let kn = 0;
      while (idx < chapters.length && chapters[idx]!.kind === "chapter") {
        const c = chapters[idx]!;
        kids.push(`          <li><a href="${c.href}">${++kn}. ${esc(c.title)}</a></li>`);
        idx++;
      }
      parts.push(`      <li><a href="${section.href}">${esc(section.title)}</a>
        <ol>
${kids.join("\n")}
        </ol>
      </li>`);
    }
    list = parts.join("\n");
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8" /><title>${esc(bookTitle)}</title><link rel="stylesheet" type="text/css" href="style.css" /></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${list}
    </ol>
  </nav>
</body>
</html>`;
}

function trimTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
