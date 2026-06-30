# Gemini Chat Exporter + Archive

Two-part toolkit for capturing your Google Gemini conversations and making them
readable, searchable, and portable.

1. **`extension/`** — a [WXT](https://wxt.dev) Chrome/Firefox extension that captures
   the conversation open in your Gemini tab into a **built-in, Gemini-style archive
   page** with best-in-class **search** (keyword · fuzzy · on-device semantic ·
   smart **hybrid**), and exports to **EPUB**, **Markdown**, or **JSON**. Captures run
   as **persisted background jobs** that survive closing the popup or the service
   worker — progress and results are written straight to storage, so nothing is lost.
2. **`webapp/`** — a [Next.js 16](https://nextjs.org) web app (shadcn/ui, custom
   Gemini theme) that imports the JSON, stores it locally in your browser, and lets
   you read and search every chat with **keyword**, **fuzzy**, and on-device
   **semantic** search — and re-export to EPUB.

Everything runs locally. No chat content is ever sent to a server. (The semantic
model weights are the only network fetch — and they download once, from the model
hub, then run entirely on-device.)

> The web app remains available as an optional companion, but the extension is now
> self-contained: the in-extension **Archive** page reads captured chats live from
> extension storage, so you no longer need the export→import dance to search and read.

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
- **Open this chat in Archive** — captures the conversation currently open on
  `gemini.google.com` (full auto-scroll capture) and opens the built-in archive
  page, deep-linked to that chat.
- **Background capture that never loses work** — the capture is owned by the content
  script and persists *partial snapshots* and the *final result* directly to
  `browser.storage.local`. Close the popup, switch tabs, let the service worker
  sleep — progress keeps being written and the finished chat is committed safely.
  Live job status shows in the popup and the archive (and survives reopening).
- **Archive page (the options page)** — a Gemini-style UI: a slim icon rail, a
  prominent search box, a reader for each conversation, dark/light themes.
- **Best-in-class search** over everything captured:
  - **Smart (hybrid)** — fuses BM25 lexical ranking with semantic vectors via
    Reciprocal Rank Fusion (falls back to BM25 + fuzzy before the vector index is
    built). This is the default.
  - **Keyword** — every term must appear; title/question matches are boosted.
  - **Fuzzy** — typo-tolerant (Fuse.js).
  - **Semantic / vector** — meaning-based, using `all-MiniLM-L6-v2` running fully
    on-device (bundled transformers.js worker; the ONNX runtime is self-hosted in
    the extension, only model weights are fetched once and cached). Vectors are
    cached in IndexedDB and only changed turns are re-embedded.
- **Builds a collection** in extension storage so you can capture several chats
  across visits.
- **Export** — all (or any single chat) as **EPUB** (each Q&A its own chapter),
  **Markdown**, or **JSON**. Import JSON back into the archive too.

#### Power features
- **Results grouped by conversation** — one card per chat with its best match and
  an expandable "N more matches in this chat", each jumping straight to that turn.
- **Query-linked reading** — opening a result highlights every match in the
  conversation and jumps to the first; press **F** for in-chat find with **N /
  Shift+N** to step through matches.
- **Command palette** (**⌘/Ctrl+K**) — jump to any chat or run any action; **?**
  shows all keyboard shortcuts.
- **Filters & sort** — any-time / 7d / 30d / 1y, relevance or recency, plus
  remembered **recent searches**.
- **Pin & rename** chats (custom titles never touch the captured content).
- **Copy** any answer or code block in one click; **prev/next** chat navigation.
- **Backup & restore** the whole archive (chats + pins + settings) as one file,
  with a live **storage-usage meter**.
- **"Update this chat"** — the popup detects a chat already in your archive and
  shows how many new turns a re-capture added.
- **Appearance** — dark / light / match-system theme and a compact density.

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
2. Click the extension icon → **Open this chat in Archive** (or press **Alt+Shift+G**
   to capture in the background without opening the popup).
3. The Archive opens to that chat. Capture more chats anytime; they all appear in the
   archive's search.
4. Search with **Smart / Keyword / Fuzzy / Semantic**, read any chat, and **export**
   to EPUB / Markdown / JSON from the chat header or Settings.

> First-time semantic/smart search: click **Build vector index** (in the search
> banner or Settings) once. The model downloads a single time and then runs offline.
>
> If a capture reports it can't reach the page, reload the Gemini tab once so the
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
Extension: WXT 0.20, React 19, TypeScript 5.9, JSZip 3.10, Fuse.js 7,
transformers.js 4 (`all-MiniLM-L6-v2`, bundled + self-hosted ONNX runtime).
Web app: Next 16.2, React 19.2, Tailwind 4.3, Dexie 4.2, Fuse.js 7.4,
transformers.js 4.2 (`all-MiniLM-L6-v2`).

## Notes & limits
- Scraping depends on Gemini's current DOM; if Google ships a major markup change,
  update the selector lists in `extension/lib/scraper.ts`.
- The extension scrapes the conversation already loaded in the page; very long
  chats should be scrolled to the top first so all turns are in the DOM.
- The web app is local-first and statically deployable (Vercel, Netlify, GitHub
  Pages, or any static host).
