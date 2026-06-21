// Options page controller: load settings into the form, persist on save.

import { getSettings, setSettings, normalizeOrigin, type Settings } from "@/lib/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  autoScroll: $<HTMLInputElement>("autoScroll"),
  scrollDelayMs: $<HTMLInputElement>("scrollDelayMs"),
  maxIterations: $<HTMLInputElement>("maxIterations"),
  autoSyncToWebapp: $<HTMLInputElement>("autoSyncToWebapp"),
  mergeMode: $<HTMLSelectElement>("mergeMode"),
  webappOrigin: $<HTMLInputElement>("webappOrigin"),
  save: $<HTMLButtonElement>("save"),
  status: $<HTMLParagraphElement>("status"),
};

function fill(s: Settings) {
  els.autoScroll.checked = s.autoScroll;
  els.scrollDelayMs.value = String(s.scrollDelayMs);
  els.maxIterations.value = String(s.maxIterations);
  els.autoSyncToWebapp.checked = s.autoSyncToWebapp;
  els.mergeMode.value = s.mergeMode;
  els.webappOrigin.value = s.webappOrigin;
}

function setStatus(msg: string, kind: "" | "ok" | "err" = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

els.save.addEventListener("click", async () => {
  const patch: Partial<Settings> = {
    autoScroll: els.autoScroll.checked,
    scrollDelayMs: clamp(Number(els.scrollDelayMs.value), 50, 5000, 350),
    maxIterations: clamp(Number(els.maxIterations.value), 10, 2000, 400),
    autoSyncToWebapp: els.autoSyncToWebapp.checked,
    mergeMode: els.mergeMode.value === "replace" ? "replace" : "merge",
    webappOrigin: normalizeOrigin(els.webappOrigin.value),
  };
  const saved = await setSettings(patch);
  fill(saved);
  setStatus("Settings saved.", "ok");
});

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

getSettings().then(fill);
