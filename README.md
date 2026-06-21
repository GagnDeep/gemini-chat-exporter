# Gemini Chat Exporter + Archive

Two-part toolkit for capturing your Google Gemini conversations and making them
readable, searchable, and portable.

1. **`extension/`** — a [WXT](https://wxt.dev) Chrome/Firefox extension that scrapes
   the conversation open in your Gemini tab and exports it as **EPUB** (one chapter
   per question + answer) or **JSON**.
2. **`webapp/`** — a [Next.js 16](https://nextjs.org) web app (shadcn/ui, custom
   Gemini theme) that imports the JSON, stores it locally in your browser, and lets
   you read and search every chat with **keyword**, **fuzzy**, and on-device
   **semantic** search — and re-export to EPUB.

Everything runs locally. No chat content is ever sent to a server.

---

## How the pieces fit together

```
 Gemini tab ──(scrape)──▶ Extension ──┬──▶ chat.epub          (read anywhere)
                                       └──▶ gemini-chats.json ──▶ Web app
                                                                   ├─ keyword / fuzzy / semantic search
                                                                   ├─ read with full formatting
                                                                   └─ export EPUB (single or all)
```

The two projects share one JSON shape (`format: "gemini-chat-export"`), so exports
from the extension import cleanly into the web app.

---

## 1. The extension (`extension/`)

Built with **WXT 0.20** + TypeScript, Manifest V3.

### Install from a release (recommended — no build needed)

A pre-built, packaged extension is attached to every
[GitHub Release](https://github.com/GagnDeep/gemini-chat-exporter/releases/latest).

1. Go to the [latest release](https://github.com/GagnDeep/gemini-chat-exporter/releases/latest)
   and download `gemini-chat-exporter-<version>-chrome.zip` from the **Assets** section.
2. **Unzip** it. You'll get a folder containing `manifest.json` and the extension files.
3. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc…).
4. Toggle **Developer mode** on (top-right).
5. Click **Load unpacked** and select the **unzipped folder** (the one with
   `manifest.json` at its root).
6. The **Gemini Chat Exporter** icon appears in your toolbar — pin it for quick access.

> Chrome may warn that you're running an unpacked/developer extension. That's
> expected for extensions installed outside the Web Store; it stays loaded as long
> as you keep the unzipped folder in place.

To update later, download the newer release zip, unzip it (replacing the old
folder), and click the **↻ reload** button on the extension's card in
`chrome://extensions`.

### What it does
- **Scrape this chat** — reads the conversation currently open on
  `gemini.google.com`, pulling each user prompt and Gemini's answer (plain text +
  sanitized HTML).
- Builds a **collection** in extension storage so you can scrape several chats
  across visits.
- **Export all as EPUB** — each Q&A becomes its own chapter; multiple chats are
  grouped with a section title page and nested table of contents.
- **Export JSON** — the file you drop into the web app.
- Per-chat **EPUB** button in the list.

### How it scrapes
Gemini renders each turn as a `.conversation-container` holding a `<user-query>`
and a `<model-response>`. Selectors live in `lib/scraper.ts` as ordered fallback
lists, so a single class-name change on Google's side won't break extraction
outright. The "You said" accessibility prefix is stripped, and answer HTML is
sanitized (event handlers, inline styles, and tracking query-strings removed).

### Run it
```bash
cd extension
pnpm install
pnpm dev          # launches Chrome with the extension loaded + hot reload
# or
pnpm build        # outputs .output/chrome-mv3  (load unpacked in chrome://extensions)
pnpm zip          # packaged zip for the store
pnpm dev:firefox  # Firefox target
```

To load a production build manually: open `chrome://extensions`, enable
**Developer mode**, **Load unpacked**, and select `extension/.output/chrome-mv3`.

### Use it
1. Open a conversation on `gemini.google.com`.
2. Click the extension icon → **Scrape this chat**.
3. Repeat for other chats if you like.
4. **Export JSON** (for the web app) or **Export all as EPUB**.

> If "Scrape" reports it can't reach the page, reload the Gemini tab once so the
> content script loads, then try again.

---

## 2. The web app (`webapp/`)

Built with **Next.js 16 (App Router, Turbopack)**, **React 19**, **Tailwind CSS 4**,
**shadcn/ui** (custom Gemini blue→purple theme, light + dark), **Dexie** (IndexedDB),
**Fuse.js**, and **transformers.js** for embeddings.

### Features
- **Import** — drag-and-drop the extension's JSON (or the bundled
  `public/sample-gemini-chats.json` to try it). Chats are stored in IndexedDB and
  persist across reloads.
- **Read** — open any chat for a clean, formatted, threaded transcript.
- **Search**, three ways:
  - **Keyword** — every term must appear; exact and fast.
  - **Fuzzy** — typo-tolerant matching (Fuse.js) over questions and answers.
  - **Semantic** — meaning-based. Embeds every Q&A turn with
    `all-MiniLM-L6-v2` running **entirely in your browser** (Web Worker +
    transformers.js), stores the vectors in IndexedDB, and ranks by cosine
    similarity. Click **Build semantic index** once; the model (~25 MB, quantized)
    downloads once and is cached.
- **Export** — re-export any single chat, or all chats, to EPUB.

### Run it
```bash
cd webapp
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # production build
pnpm start        # serve the build
pnpm typecheck
```

### Try it without the extension
On first load, drop `webapp/public/sample-gemini-chats.json` onto the import area
(or fetch it at `/sample-gemini-chats.json`).

### Privacy / how semantic search stays local
The embedding model runs in a Web Worker via transformers.js loaded from a CDN at
runtime. Inference happens on your device; only the model weights are fetched
(from the Hugging Face CDN), never your chat text.

---

## EPUB structure

Per your spec, **each question + its answer is a separate chapter**:

- One chat → a book whose chapters are its Q&A turns, in order.
- Multiple chats → each chat gets a section title page, with its Q&A chapters
  nested beneath it in the table of contents.

Generation is shared (`lib/epub.ts` in both projects): a hand-built EPUB 3 package
(JSZip) with `mimetype`, `META-INF/container.xml`, `OEBPS/content.opf`, an EPUB3
`nav.xhtml`, per-chapter XHTML, and a print stylesheet. Answer HTML is converted to
well-formed XHTML so it renders in any reader (Apple Books, Calibre, Kindle via
conversion, etc.).

---

## Requirements
- Node 20+ and **pnpm** (`npm i -g pnpm`).
- A Chromium browser (or Firefox) for the extension.

## Tech versions
Extension: WXT 0.20, TypeScript 5.9, JSZip 3.10.
Web app: Next 16.2, React 19.2, Tailwind 4.3, Dexie 4.2, Fuse.js 7.4,
transformers.js 4.2 (`all-MiniLM-L6-v2`).

## Notes & limits
- Scraping depends on Gemini's current DOM; if Google ships a major markup change,
  update the selector lists in `extension/lib/scraper.ts`.
- The extension scrapes the conversation already loaded in the page; very long
  chats should be scrolled to the top first so all turns are in the DOM.
- The web app is local-first and statically deployable (Vercel, Netlify, GitHub
  Pages, or any static host).
