// Persistent scrape-job registry, stored in browser.storage.local.
//
// Jobs let any UI (popup, archive page) observe an in-flight capture in real
// time and recover its outcome after the surface that started it has gone away.
// The content script that runs the capture is the writer; everyone else reads.

import type { ScrapeJob, ScrapeJobStatus } from "./types";
import type { ProviderId } from "./providers";

export const JOBS_KEY = "scrape_jobs";

/** Jobs older than this in a terminal state are pruned on the next write. */
const TERMINAL_TTL_MS = 1000 * 60 * 60 * 6; // 6h
/** A "scraping" job untouched for this long is treated as stalled/dead. */
export const STALL_MS = 1000 * 25;

export async function getJobs(): Promise<ScrapeJob[]> {
  const res = await browser.storage.local.get(JOBS_KEY);
  return (res[JOBS_KEY] as ScrapeJob[]) ?? [];
}

async function setJobs(jobs: ScrapeJob[]): Promise<void> {
  await browser.storage.local.set({ [JOBS_KEY]: jobs });
}

function now(): string {
  return new Date().toISOString();
}

/** Drop old terminal jobs so the registry doesn't grow without bound. */
function prune(jobs: ScrapeJob[]): ScrapeJob[] {
  const cutoff = Date.now() - TERMINAL_TTL_MS;
  return jobs.filter((j) => {
    if (j.status === "scraping") return true;
    const t = Date.parse(j.finishedAt || j.updatedAt || j.startedAt);
    return Number.isFinite(t) ? t > cutoff : true;
  });
}

/**
 * Create (or restart) the job for a chat. Only one active job per chatId is
 * kept — restarting replaces any prior terminal job for the same chat.
 */
export async function startJob(init: {
  id: string;
  chatId: string;
  title: string;
  url: string;
  tabId?: number;
  source?: ProviderId;
}): Promise<ScrapeJob> {
  const jobs = prune(await getJobs()).filter((j) => j.chatId !== init.chatId);
  const job: ScrapeJob = {
    ...init,
    status: "scraping",
    turns: 0,
    atTop: false,
    loading: false,
    iteration: 0,
    startedAt: now(),
    updatedAt: now(),
  };
  jobs.unshift(job);
  await setJobs(jobs);
  return job;
}

/** Patch an existing job by id. No-op if the job is gone. */
export async function updateJob(id: string, patch: Partial<ScrapeJob>): Promise<void> {
  const jobs = await getJobs();
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return;
  jobs[i] = { ...jobs[i]!, ...patch, updatedAt: now() };
  await setJobs(jobs);
}

export async function finishJob(
  id: string,
  status: Extract<ScrapeJobStatus, "done" | "error" | "canceled">,
  extra: Partial<ScrapeJob> = {},
): Promise<void> {
  const jobs = prune(await getJobs());
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return;
  jobs[i] = { ...jobs[i]!, status, ...extra, updatedAt: now(), finishedAt: now() };
  await setJobs(jobs);
}

export async function getActiveJob(): Promise<ScrapeJob | undefined> {
  return (await getJobs()).find((j) => j.status === "scraping");
}

export function isStalled(job: ScrapeJob): boolean {
  if (job.status !== "scraping") return false;
  return Date.now() - Date.parse(job.updatedAt) > STALL_MS;
}

/**
 * Reconcile jobs on startup / popup open: any "scraping" job that hasn't been
 * touched within STALL_MS (its owning tab was closed or navigated) is marked
 * canceled so the UI doesn't show a phantom spinner forever.
 */
export async function reconcileStalled(): Promise<void> {
  const jobs = await getJobs();
  let changed = false;
  for (const j of jobs) {
    if (j.status === "scraping" && isStalled(j)) {
      j.status = "canceled";
      j.error = "Interrupted — the tab was closed or navigated away.";
      j.finishedAt = now();
      changed = true;
    }
  }
  if (changed) await setJobs(prune(jobs));
}
