// Markdown-structure analysis for the reader outline.
//
// Gemini answers are rendered HTML that preserves markdown structure (h1–h6,
// lists, tables, code, blockquotes) through sanitize.ts. `annotateSections`
// parses an (already enriched) answer once: it stamps a stable anchor id onto
// each structural block AND returns the matching outline nodes, so the ids in
// the rendered HTML and the ids the outline links to can never drift apart.

export type SectionKind = "heading" | "list" | "table" | "code" | "quote";

export interface OutlineSection {
  /** Anchor id, also set as the element's id in the returned HTML. */
  id: string;
  kind: SectionKind;
  /** Indent depth (1 = top). Headings use their tag level; blocks nest under it. */
  level: number;
  label: string;
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const STRUCTURAL = "h1,h2,h3,h4,h5,h6,ul,ol,table,pre,blockquote";

function clip(s: string, n = 80): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

/** True when a list/table/pre is nested inside another structural block we'll
 *  already capture — keeps the outline to the outermost blocks only. */
function isNested(el: Element): boolean {
  let p = el.parentElement;
  while (p && p.tagName !== "BODY") {
    const t = p.tagName;
    if (t === "UL" || t === "OL" || t === "LI" || t === "TABLE" || t === "PRE" || t === "BLOCKQUOTE") return true;
    p = p.parentElement;
  }
  return false;
}

function labelFor(el: Element): string {
  const tag = el.tagName;
  if (HEADING_TAGS.has(tag)) return clip(el.textContent || "");
  if (tag === "UL" || tag === "OL") {
    const n = el.querySelectorAll(":scope > li").length;
    const lead = clip(el.querySelector(":scope > li")?.textContent || "", 48);
    return `List · ${n} item${n === 1 ? "" : "s"}${lead ? ` — ${lead}` : ""}`;
  }
  if (tag === "TABLE") {
    const rows = el.querySelectorAll("tr").length;
    const cols = el.querySelector("tr")?.children.length || 0;
    return `Table · ${rows}×${cols}`;
  }
  if (tag === "PRE") {
    const lang = el.querySelector(".code-lang")?.textContent
      || el.querySelector("code")?.className.match(/language-([a-z0-9+#-]+)/i)?.[1]
      || "code";
    return `Code · ${lang}`;
  }
  if (tag === "BLOCKQUOTE") return `Quote — ${clip(el.textContent || "", 56)}`;
  return clip(el.textContent || "");
}

function kindFor(el: Element): SectionKind {
  const tag = el.tagName;
  if (HEADING_TAGS.has(tag)) return "heading";
  if (tag === "TABLE") return "table";
  if (tag === "PRE") return "code";
  if (tag === "BLOCKQUOTE") return "quote";
  return "list";
}

/**
 * Stamp anchor ids onto structural blocks and return both the updated HTML and
 * the ordered outline sections. Pure + memoizable per turn.
 */
export function annotateSections(html: string, turnIndex: number): { html: string; sections: OutlineSection[] } {
  if (!html) return { html, sections: [] };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return { html, sections: [] };
  }
  const sections: OutlineSection[] = [];
  let n = 0;
  let lastHeadingLevel = 1;
  doc.body.querySelectorAll(STRUCTURAL).forEach((el) => {
    const kind = kindFor(el);
    if (kind !== "heading" && isNested(el)) return; // outermost blocks only
    const label = labelFor(el);
    if (!label) return;
    const id = `t${turnIndex}-s${n++}`;
    el.id = id;
    let level: number;
    if (kind === "heading") {
      level = Math.min(4, Number(el.tagName.slice(1)) || 1);
      lastHeadingLevel = level;
    } else {
      level = Math.min(5, lastHeadingLevel + 1); // nest blocks under current heading
    }
    sections.push({ id, kind, level, label });
  });
  return { html: doc.body.innerHTML, sections };
}
