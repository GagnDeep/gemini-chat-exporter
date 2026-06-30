import React, { useEffect, useState } from "react";
import { SearchView } from "./SearchView";
import { ChatView } from "./ChatView";
import { SettingsView } from "./SettingsView";
import { BrowseView } from "./BrowseView";
import { ChatNav } from "./ChatNav";
import { CommandPalette } from "./CommandPalette";
import { HelpOverlay } from "./HelpOverlay";
import { Toaster } from "./Toaster";
import { usePersistentWidth } from "./resize";
import * as I from "./icons";

type Route =
  | { view: "search" }
  | { view: "browse" }
  | { view: "chat"; chatId: string; turn?: number; query?: string; mode?: string }
  | { view: "settings" };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("chat/")) {
    const rest = decodeURIComponent(h.slice("chat/".length));
    const tokens = rest.split("~");
    const chatId = tokens.shift() || "";
    let turn: number | undefined;
    let query: string | undefined;
    let mode: string | undefined;
    for (const tk of tokens) {
      if (tk.startsWith("q=")) query = decodeURIComponent(tk.slice(2));
      else if (tk.startsWith("m=")) mode = decodeURIComponent(tk.slice(2));
      else if (tk !== "" && Number.isFinite(Number(tk))) turn = Number(tk);
    }
    if (chatId) return { view: "chat", chatId, turn, query, mode };
  }
  if (h.startsWith("settings")) return { view: "settings" };
  if (h.startsWith("browse")) return { view: "browse" };
  return { view: "search" };
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

/** Jump to the search view and run a query (used by Browse chips, insights). */
export function searchFor(query: string): void {
  navigate("#/search");
  // Defer so SearchView has mounted and its listener is attached.
  setTimeout(() => window.dispatchEvent(new CustomEvent("set-search", { detail: query })), 0);
}

/** Build a chat deep-link that carries an optional turn + search query + the
 *  search mode (so the chat can highlight the match the same way it ranked). */
export function chatLink(chatId: string, turn?: number, query?: string, mode?: string): string {
  let s = `#/chat/${encodeURIComponent(chatId)}`;
  if (turn != null) s += `~${turn}`;
  if (query && query.trim()) s += `~q=${encodeURIComponent(query.trim())}`;
  if (mode) s += `~m=${encodeURIComponent(mode)}`;
  return s;
}

type ThemePref = "system" | "dark" | "light";

function resolveTheme(pref: ThemePref): "dark" | "light" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return pref;
}

function useTheme(): ["dark" | "light", () => void] {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem("archive-theme") as ThemePref) || "dark");
  const [resolved, setResolved] = useState<"dark" | "light">(() => resolveTheme(pref));

  useEffect(() => {
    const r = resolveTheme(pref);
    setResolved(r);
    document.documentElement.setAttribute("data-theme", r);
    localStorage.setItem("archive-theme", pref);
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => { const rr = resolveTheme("system"); setResolved(rr); document.documentElement.setAttribute("data-theme", rr); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  // Density: applied as a data attribute, persisted in localStorage.
  useEffect(() => {
    const apply = (d: string) => document.documentElement.setAttribute("data-density", d);
    apply(localStorage.getItem("archive-density") || "comfortable");
    const onDensity = (e: Event) => {
      const d = (e as CustomEvent<string>).detail || "comfortable";
      localStorage.setItem("archive-density", d);
      apply(d);
    };
    const onSetTheme = (e: Event) => setPref(((e as CustomEvent<ThemePref>).detail || "dark"));
    const onToggle = () => setPref((p) => (resolveTheme(p) === "dark" ? "light" : "dark"));
    window.addEventListener("set-density", onDensity);
    window.addEventListener("set-theme", onSetTheme);
    window.addEventListener("toggle-theme", onToggle);
    return () => {
      window.removeEventListener("set-density", onDensity);
      window.removeEventListener("set-theme", onSetTheme);
      window.removeEventListener("toggle-theme", onToggle);
    };
  }, []);

  return [resolved, () => setPref((p) => (resolveTheme(p) === "dark" ? "light" : "dark"))];
}

/** Chat sidebar default: remembered choice, else open on wide viewports. */
function navOpenDefault(): boolean {
  const v = localStorage.getItem("nav-open");
  if (v === "1") return true;
  if (v === "0") return false;
  return typeof window !== "undefined" && window.matchMedia("(min-width: 1100px)").matches;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [theme, toggleTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(navOpenDefault);
  const [navW, setNavW] = usePersistentWidth("nav-width", 260, 200, 420);

  useEffect(() => { localStorage.setItem("nav-open", navOpen ? "1" : "0"); }, [navOpen]);
  // Publish the sidebar width so the fixed Outline dock can offset past it.
  useEffect(() => {
    document.documentElement.style.setProperty("--nav-w", (navOpen ? navW : 0) + "px");
  }, [navOpen, navW]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Global shortcuts: ⌘/Ctrl+K palette, ? help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "?" && !typing) {
        e.preventDefault();
        setHelpOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-logo" title="Gemini Chat Archive"><I.Sparkle size={18} /></div>
        <button className="rail-btn" title="New search"
          onClick={() => { navigate("#/search"); window.dispatchEvent(new Event("focus-search")); }}>
          <I.Plus />
        </button>
        <button className={"rail-btn" + (navOpen ? " active" : "")} title="Toggle chat sidebar"
          aria-pressed={navOpen} onClick={() => setNavOpen((o) => !o)}>
          <I.PanelLeft />
        </button>
        <button className={"rail-btn" + (route.view === "search" ? " active" : "")} title="Search (/)"
          onClick={() => navigate("#/search")}>
          <I.Search />
        </button>
        <button className={"rail-btn" + (route.view === "browse" ? " active" : "")} title="Browse topics, people & links"
          onClick={() => navigate("#/browse")}>
          <I.Globe />
        </button>
        <button className="rail-btn" title="Command palette (⌘/Ctrl+K)" onClick={() => setPaletteOpen(true)}>
          <I.Command />
        </button>
        <div className="rail-spacer" />
        <button className="rail-btn" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
          <I.Help />
        </button>
        <button className="rail-btn" title={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggleTheme}>
          {theme === "dark" ? <I.Sun /> : <I.Moon />}
        </button>
        <button className={"rail-btn" + (route.view === "settings" ? " active" : "")} title="Settings"
          onClick={() => navigate("#/settings")}>
          <I.SettingsIcon />
        </button>
      </nav>

      {navOpen && (
        <ChatNav activeChatId={"chatId" in route ? route.chatId : undefined}
          width={navW} onWidthChange={setNavW} onClose={() => setNavOpen(false)} />
      )}

      <main className="main" key={route.view + ("chatId" in route ? route.chatId : "")}>
        {route.view === "search" && <SearchView />}
        {route.view === "browse" && <BrowseView />}
        {route.view === "chat" && <ChatView chatId={route.chatId} turn={route.turn} query={route.query} mode={route.mode} />}
        {route.view === "settings" && <SettingsView />}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toaster />
    </div>
  );
}
