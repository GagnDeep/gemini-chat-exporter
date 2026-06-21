// Defense-in-depth HTML sanitizer for answer HTML.
//
// The extension already strips event handlers and tracking params at scrape
// time, but a JSON file imported from disk (or a bridge payload) is untrusted.
// Since the web app renders answer HTML with dangerouslySetInnerHTML, we
// re-sanitize on import: drop dangerous elements and any on*/style/href:js
// attributes, keeping the structural markup that makes answers readable.

const DANGEROUS_TAGS = [
  "script", "style", "iframe", "object", "embed", "noscript",
  "form", "input", "textarea", "select", "button", "link", "meta", "base",
];

/**
 * Sanitize a fragment of answer HTML. Runs in the browser (uses DOMParser);
 * on the server / during SSR it returns the input unchanged — answer HTML is
 * only ever rendered client-side after a client import, so this is sufficient.
 */
export function sanitizeAnswerHtml(html: string): string {
  if (!html) return "";
  if (typeof window === "undefined" || typeof DOMParser === "undefined") return html;
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
      // Block javascript:/data: URIs on href/src.
      if ((name === "href" || name === "src" || name === "xlink:href") && /^\s*(javascript|data|vbscript):/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    });
  });

  return root.innerHTML;
}
