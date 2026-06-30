import React from "react";
import type { ScrapeJob } from "@/lib/types";
import { useJobs } from "./store";
import { navigate } from "./App";
import * as I from "./icons";

function pct(job: ScrapeJob): number {
  // Rough, monotonic-ish progress: turns captured saturate toward "atTop".
  if (job.status !== "scraping") return 100;
  if (job.atTop) return 95;
  const t = Math.min(job.turns, 200);
  return Math.min(90, 8 + t * 0.6);
}

export function JobBanner() {
  const jobs = useJobs();
  // Show the most relevant job: an active one, else the most recent terminal one.
  const active = jobs.find((j) => j.status === "scraping");
  const recent = jobs.find((j) => j.status !== "scraping");
  const job = active || recent;
  if (!job) return null;

  // Hide stale completed banners after a while (older than 30s).
  if (!active && job.finishedAt && Date.now() - Date.parse(job.finishedAt) > 30_000) return null;

  const isErr = job.status === "error" || job.status === "canceled";
  const statusText =
    job.status === "scraping"
      ? `Capturing… ${job.turns} turn${job.turns === 1 ? "" : "s"}${job.loading ? " · loading older" : job.atTop ? " · finishing" : ""}`
      : job.status === "done"
        ? `Captured ${job.turns} turn${job.turns === 1 ? "" : "s"}`
        : job.error || "Capture interrupted";

  return (
    <div className={"jobbar" + (isErr ? " err" : "")}>
      <div className="jobbar-inner">
        {job.status === "scraping" ? (
          <div className="spinner" />
        ) : isErr ? (
          <span style={{ color: "var(--danger)" }}><I.Close size={16} /></span>
        ) : (
          <span style={{ color: "#81c995" }}>✓</span>
        )}
        <div className="grow">
          <div className="title" title={job.title}>{job.title || "Gemini chat"}</div>
          <div className="meta">{statusText}</div>
          {job.status === "scraping" && (
            <div className="progress-track"><div className="progress-fill" style={{ width: pct(job) + "%" }} /></div>
          )}
        </div>
        {job.status === "done" && (
          <button className="btn ghost" onClick={() => navigate(`#/chat/${encodeURIComponent(job.chatId)}`)}>
            <I.Open size={16} /> Open
          </button>
        )}
      </div>
    </div>
  );
}
