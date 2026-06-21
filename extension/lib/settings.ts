// Extension settings, persisted in browser.storage.local under a single key.
// Shared by the popup, the options page, and the background script.

export interface Settings {
  /** Use the auto-scroll full-conversation capture path by default. */
  autoScroll: boolean;
  /** Pause between scroll steps (ms) — raise on slow machines. */
  scrollDelayMs: number;
  /** Hard cap on scroll iterations during a full scrape. */
  maxIterations: number;
  /** After a scrape, push the chat into the companion web app's local DB. */
  autoSyncToWebapp: boolean;
  /** How the web app should fold a re-scrape into the existing copy. */
  mergeMode: "merge" | "replace";
  /** Origin of the companion web app (where the archive DB lives). */
  webappOrigin: string;
}

export const DEFAULT_SETTINGS: Settings = {
  autoScroll: true,
  scrollDelayMs: 350,
  maxIterations: 400,
  autoSyncToWebapp: false,
  mergeMode: "merge",
  webappOrigin: "http://localhost:3000",
};

const SETTINGS_KEY = "settings";

/** Read settings, filling any missing fields from defaults. */
export async function getSettings(): Promise<Settings> {
  const res = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

/** Merge a partial update into the stored settings and return the result. */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Normalize a user-entered origin to a bare scheme://host[:port] form. */
export function normalizeOrigin(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return DEFAULT_SETTINGS.webappOrigin;
  try {
    return new URL(raw).origin;
  } catch {
    try {
      return new URL(`http://${raw}`).origin;
    } catch {
      return DEFAULT_SETTINGS.webappOrigin;
    }
  }
}
