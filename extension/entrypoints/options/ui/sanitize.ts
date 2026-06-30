// Defense-in-depth sanitizer for answer HTML before rendering it with
// dangerouslySetInnerHTML. The scraper already strips handlers/styles, but data
// can also arrive from imported JSON, so we re-sanitize at render time.

const DANGEROUS_TAGS = [
  "script", "style", "iframe", "object", "embed", "noscript",
  "form", "input", "textarea", "select", "button", "link", "meta", "base",
];

export function sanitizeAnswerHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, "text/html");
  } catch {
    return html.replace(/<[^>]+>/g, "");
  }
  const root = doc.getElementById("__root");
  if (!root) return "";

  root.querySelectorAll(DANGEROUS_TAGS.join(",")).forEach((el) => el.remove());

  root.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || "";
      if (name.startsWith("on") || name === "style") {
        el.removeAttribute(attr.name);
        return;
      }
      if (
        (name === "href" || name === "src" || name === "xlink:href") &&
        /^\s*(javascript|data|vbscript):/i.test(value)
      ) {
        el.removeAttribute(attr.name);
      }
    });
    // Force external links to open safely in a new tab.
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });

  return root.innerHTML;
}
