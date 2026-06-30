import React from "react";
import type { IndexState } from "./useSemanticIndex";
import * as I from "./icons";

/** Reusable on-device vector-index build prompt: message + progress + Build
 *  button. Shown in global Search and inline in the reader (with onClose). */
export function VectorPrompt({ index, onClose }: { index: IndexState; onClose?: () => void }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="toolbar">
        <span style={{ color: "var(--accent)" }}><I.Brain size={18} /></span>
        <div className="grow" style={{ fontSize: 13 }}>
          {index.message || `On-device vector search needs an index (${index.embedded}/${index.total} turns). Builds once, runs entirely in your browser — nothing leaves your device.`}
          {index.progress && (
            <div className="progress-track" style={{ marginTop: 8 }}>
              <div className="progress-fill" style={{ width: `${(index.progress.done / Math.max(1, index.progress.total)) * 100}%` }} />
            </div>
          )}
        </div>
        <button className="btn primary" disabled={index.building} onClick={() => void index.buildIndex()}>
          {index.building ? <span className="spinner" /> : <I.Brain size={16} />}
          {index.building ? "Building…" : "Build vector index"}
        </button>
        {onClose && (
          <button className="iconbtn" title="Dismiss" aria-label="Dismiss" onClick={onClose}><I.Close size={16} /></button>
        )}
      </div>
    </div>
  );
}
