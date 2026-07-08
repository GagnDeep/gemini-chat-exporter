import React, { useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { normalizeOrigin } from "@/lib/settings";
import { commitChat, CHATS_KEY, setChats } from "@/lib/chats-store";
import { META_KEY, getChatMeta } from "@/lib/meta";
import type { Chat, GeminiExport } from "@/lib/types";
import { useChats, useSettings, useChatMeta, clearChats } from "./store";
import { segmentsFromChats, chatWordCount } from "./segments";
import { useSemanticIndex } from "./useSemanticIndex";
import { exportEpub, exportMarkdown, exportJson } from "./exporters";
import { sanitizeAnswerHtml } from "./sanitize";
import { ArchiveManager } from "./ArchiveManager";
import { showToast } from "./toast";
import { JobBanner } from "./JobBanner";
import * as I from "./icons";

function clamp(n: number, min: number, max: number, fb: number): number {
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function SettingsView() {
  const chats = useChats();
  const meta = useChatMeta();
  const [settings, update] = useSettings();
  const segments = useMemo(() => segmentsFromChats(chats), [chats]);
  const index = useSemanticIndex(segments);
  const [status, setStatus] = useState<{ msg: string; kind: "" | "ok" | "err" }>({ msg: "", kind: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const [storage, setStorage] = useState<{ local: number; idb: number }>({ local: 0, idb: 0 });
  const [theme, setTheme] = useState(() => localStorage.getItem("archive-theme") || "dark");
  const [density, setDensity] = useState(() => localStorage.getItem("archive-density") || "comfortable");

  useEffect(() => {
    (async () => {
      let local = 0, idb = 0;
      try { local = await browser.storage.local.getBytesInUse(null); } catch { /* not all browsers */ }
      try { const est = await navigator.storage?.estimate?.(); idb = est?.usage ?? 0; } catch { /* ignore */ }
      setStorage({ local, idb });
    })();
  }, [chats, index.embedded]);

  // Local form state mirrors settings; saved explicitly. Re-seed when the loaded
  // settings change (e.g. on first async load from storage).
  const [form, setForm] = useState(settings);
  useEffect(() => { setForm(settings); }, [settings.webappOrigin, settings.maxIterations]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    let turns = 0, words = 0;
    for (const c of chats) { turns += c.turns.length; words += chatWordCount(c); }
    return { chats: chats.length, turns, words };
  }, [chats]);

  async function save() {
    await update({
      autoScroll: form.autoScroll,
      scrollDelayMs: clamp(Number(form.scrollDelayMs), 50, 5000, 350),
      maxIterations: clamp(Number(form.maxIterations), 10, 2000, 400),
      autoSyncToWebapp: form.autoSyncToWebapp,
      mergeMode: form.mergeMode === "replace" ? "replace" : "merge",
      webappOrigin: normalizeOrigin(form.webappOrigin),
      autoBuildIndex: form.autoBuildIndex,
      useRpcLoader: form.useRpcLoader,
      historyPageSize: clamp(Number(form.historyPageSize), 5, 200, 50),
      autoMirror: form.autoMirror,
    });
    setStatus({ msg: "Settings saved.", kind: "ok" });
    showToast("Settings saved.", "ok");
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function backup() {
    const payload = {
      format: "gemini-archive-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      chats,
      settings,
      meta: await getChatMeta(),
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gemini-archive-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus({ msg: "Backup downloaded.", kind: "ok" });
  }

  async function restore(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const isBackup = data?.format === "gemini-archive-backup";
      const isExport = data?.format === "gemini-chat-export";
      if (!isBackup && !isExport) throw new Error("Unrecognized file.");
      if (!confirm(isBackup
        ? "Restore this backup? It replaces your current chats, pins, and settings."
        : "Import these chats into your archive?")) return;
      if (isBackup) {
        const safeChats: Chat[] = (Array.isArray(data.chats) ? data.chats : []).map((c: Chat) => ({
          ...c, turns: (c.turns || []).map((t) => ({ ...t, answerHtml: sanitizeAnswerHtml(t.answerHtml) })),
        }));
        await setChats(safeChats);
        if (data.settings) await update(data.settings);
        if (data.meta) await browser.storage.local.set({ [META_KEY]: data.meta });
        setStatus({ msg: `Restored ${safeChats.length} chats.`, kind: "ok" });
      } else {
        let n = 0;
        for (const chat of (data as GeminiExport).chats || []) {
          if (!chat?.id || !Array.isArray(chat.turns)) continue;
          await commitChat({ ...chat, turns: chat.turns.map((t) => ({ ...t, answerHtml: sanitizeAnswerHtml(t.answerHtml) })) }, settings.mergeMode);
          n++;
        }
        setStatus({ msg: `Imported ${n} chats.`, kind: "ok" });
      }
    } catch (err) {
      setStatus({ msg: "Restore failed: " + (err instanceof Error ? err.message : String(err)), kind: "err" });
    } finally {
      if (backupRef.current) backupRef.current.value = "";
    }
  }

  const setThemePref = (t: string) => { setTheme(t); window.dispatchEvent(new CustomEvent("set-theme", { detail: t })); };
  const setDensityPref = (d: string) => { setDensity(d); window.dispatchEvent(new CustomEvent("set-density", { detail: d })); };
  void CHATS_KEY; // referenced for clarity that chats live under this key

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as GeminiExport;
      const incoming = Array.isArray(data?.chats) ? data.chats : [];
      let n = 0;
      for (const chat of incoming) {
        if (!chat?.id || !Array.isArray(chat.turns)) continue;
        const safe: Chat = { ...chat, turns: chat.turns.map((t) => ({ ...t, answerHtml: sanitizeAnswerHtml(t.answerHtml) })) };
        await commitChat(safe, settings.mergeMode);
        n++;
      }
      setStatus({ msg: `Imported ${n} chat${n === 1 ? "" : "s"}.`, kind: "ok" });
    } catch (err) {
      setStatus({ msg: "Import failed: " + (err instanceof Error ? err.message : String(err)), kind: "err" });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <JobBanner />
      <div className="col settings">
        <h1>Archive &amp; Settings</h1>
        <p className="sub">Everything is stored locally in your browser. Nothing is uploaded.</p>

        <div className="card">
          <h2>Your archive</h2>
          <div className="toolbar" style={{ marginBottom: 14 }}>
            <Stat label="Chats" value={totals.chats} />
            <Stat label="Q&A" value={totals.turns} />
            <Stat label="Words" value={totals.words.toLocaleString()} />
            <Stat label="Vectorized" value={`${index.embedded}/${index.total}`} />
          </div>
          <div className="toolbar">
            <button className="btn" onClick={() => void exportEpub(chats)} disabled={!chats.length}><I.Download size={16} /> Export all EPUB</button>
            <button className="btn" onClick={() => exportMarkdown(chats)} disabled={!chats.length}><I.Doc size={16} /> Markdown</button>
            <button className="btn" onClick={() => exportJson(chats)} disabled={!chats.length}><I.Json size={16} /> JSON</button>
            <button className="btn" onClick={() => fileRef.current?.click()}><I.Open size={16} /> Import JSON</button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onImport} />
          </div>
        </div>

        <ArchiveManager />

        <div className="card">
          <h2>On-device semantic / vector index</h2>
          <p className="sub" style={{ marginBottom: 12 }}>
            Powers Smart &amp; Semantic search. The model (~25 MB) downloads once and runs entirely in your browser.
          </p>
          {index.message && <p className="status">{index.message}</p>}
          {index.progress && (
            <div className="progress-track" style={{ margin: "8px 0" }}>
              <div className="progress-fill" style={{ width: `${(index.progress.done / Math.max(1, index.progress.total)) * 100}%` }} />
            </div>
          )}
          <div className="toolbar">
            <button className="btn primary" disabled={index.building || index.upToDate} onClick={() => void index.buildIndex()}>
              {index.building ? <span className="spinner" /> : <I.Brain size={16} />}
              {index.upToDate ? "Index up to date" : "Build vector index"}
            </button>
            <button className="btn ghost" disabled={index.building || !index.embedded} onClick={() => void index.rebuild()}>
              Rebuild from scratch
            </button>
          </div>
          <label className="row-check" style={{ marginTop: 14, marginBottom: 0 }}>
            <input type="checkbox" checked={form.autoBuildIndex} onChange={(e) => setForm({ ...form, autoBuildIndex: e.target.checked })} />
            <span>
              <strong>Auto-build the vector index</strong>
              <em>Keep Smart &amp; Semantic search instant by embedding new turns automatically (after the first manual build).</em>
            </span>
          </label>
        </div>

        <div className="card">
          <h2>Appearance</h2>
          <div className="field">
            <label>Theme</label>
            <select value={theme} onChange={(e) => setThemePref(e.target.value)}>
              <option value="system">Match system</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="field">
            <label>Density</label>
            <select value={density} onChange={(e) => setDensityPref(e.target.value)}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </div>

        <div className="card">
          <h2>Backup &amp; restore</h2>
          <p className="sub" style={{ marginBottom: 12 }}>
            A backup includes every chat, your pins &amp; custom titles, and settings — one file to move your whole archive.
          </p>
          <div className="toolbar">
            <button className="btn" onClick={() => void backup()} disabled={!chats.length}><I.Download size={16} /> Download backup</button>
            <button className="btn" onClick={() => backupRef.current?.click()}><I.Open size={16} /> Restore from backup</button>
            <input ref={backupRef} type="file" accept="application/json,.json" hidden onChange={restore} />
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="status" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Chats &amp; metadata (storage)</span><span>{fmtBytes(storage.local)}</span>
            </div>
            <div className="status" style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
              <span>Vectors &amp; cache (IndexedDB)</span><span>{fmtBytes(storage.idb)}</span>
            </div>
            <div className="meter"><div style={{ width: `${Math.min(100, (storage.local + storage.idb) / (50 * 1024 * 1024) * 100)}%` }} /></div>
            <p className="status">{fmtBytes(storage.local + storage.idb)} used · {meta && Object.values(meta).filter((m) => m.pinned).length} pinned</p>
          </div>
        </div>

        <div className="card">
          <h2>Fast capture &amp; live mirror</h2>
          <label className="row-check">
            <input type="checkbox" checked={form.useRpcLoader} onChange={(e) => setForm({ ...form, useRpcLoader: e.target.checked })} />
            <span>
              <strong>Fast history loader (recommended)</strong>
              <em>Fetches the whole conversation through Gemini's own history API — no scrolling, far faster. Automatically falls back to scrolling if unavailable.</em>
            </span>
          </label>
          <div className="field">
            <label>Turns per fetch</label>
            <input type="number" min={5} max={200} step={5} value={form.historyPageSize}
              onChange={(e) => setForm({ ...form, historyPageSize: Number(e.target.value) })} />
            <em>Higher pulls more per request (fewer round-trips). 50 is a good default.</em>
          </div>
          <label className="row-check">
            <input type="checkbox" checked={form.autoMirror} onChange={(e) => setForm({ ...form, autoMirror: e.target.checked })} />
            <span>
              <strong>Live-mirror new messages</strong>
              <em>As you chat on any Gemini page, newly-finished turns are saved to your archive automatically (new messages only — no back-scraping).</em>
            </span>
          </label>
        </div>

        <div className="card">
          <h2>Full-conversation capture (scroll fallback)</h2>
          <label className="row-check">
            <input type="checkbox" checked={form.autoScroll} onChange={(e) => setForm({ ...form, autoScroll: e.target.checked })} />
            <span>
              <strong>Auto-scroll to capture the whole chat</strong>
              <em>Scrolls a long conversation so virtualized turns are all collected. Used when the fast loader is off or unavailable.</em>
            </span>
          </label>
          <div className="field">
            <label>Scroll delay (ms)</label>
            <input type="number" min={50} max={5000} step={50} value={form.scrollDelayMs}
              onChange={(e) => setForm({ ...form, scrollDelayMs: Number(e.target.value) })} />
            <em>Raise this on slow machines if turns are missed.</em>
          </div>
          <div className="field">
            <label>Max scroll iterations</label>
            <input type="number" min={10} max={2000} step={10} value={form.maxIterations}
              onChange={(e) => setForm({ ...form, maxIterations: Number(e.target.value) })} />
          </div>
        </div>

        <div className="card">
          <h2>Sync to companion web app</h2>
          <label className="row-check">
            <input type="checkbox" checked={form.autoSyncToWebapp} onChange={(e) => setForm({ ...form, autoSyncToWebapp: e.target.checked })} />
            <span>
              <strong>Auto-sync captured chats to the web app</strong>
              <em>Also writes into the companion archive's database after a capture.</em>
            </span>
          </label>
          <div className="field">
            <label>Merge mode</label>
            <select value={form.mergeMode} onChange={(e) => setForm({ ...form, mergeMode: e.target.value === "replace" ? "replace" : "merge" })}>
              <option value="merge">Merge (keep vectors, add new turns)</option>
              <option value="replace">Replace (rebuild the chat each time)</option>
            </select>
          </div>
          <div className="field">
            <label>Web app origin</label>
            <input type="text" placeholder="https://epub-viewer.xn--lkv.com" value={form.webappOrigin}
              onChange={(e) => setForm({ ...form, webappOrigin: e.target.value })} />
          </div>
        </div>

        <div className="toolbar">
          <button className="btn primary" onClick={() => void save()}>Save settings</button>
          <button className="btn ghost" style={{ color: "var(--danger)" }}
            onClick={() => { if (confirm("Remove ALL chats from the archive? This cannot be undone.")) void clearChats().then(() => showToast("Archive cleared.", "ok")); }}>
            <I.Trash size={16} /> Clear archive
          </button>
          {status.msg && <span className={"status " + status.kind}>{status.msg}</span>}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ background: "var(--bg-elev-2)", borderRadius: 12, padding: "8px 14px", textAlign: "center", minWidth: 80 }}>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-mute)" }}>{label}</div>
    </div>
  );
}
