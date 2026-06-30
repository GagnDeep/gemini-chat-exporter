// Owns the on-device vector index: loads cached embeddings, attaches them to
// segments, and (re)builds missing/stale vectors with the embeddings worker.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "@/lib/types";
import { hashText } from "./segments";
import { getAllEmbeddings, putEmbeddings, clearEmbeddings, pruneEmbeddings, type EmbRecord } from "./idb";
import { getEmbeddings } from "./embeddings";

export interface IndexState {
  /** segments with their cached vector attached when the text hash still matches. */
  segments: Segment[];
  total: number;
  embedded: number;
  upToDate: boolean;
  building: boolean;
  progress: { done: number; total: number } | null;
  message: string;
  buildIndex: () => Promise<void>;
  rebuild: () => Promise<void>;
}

/** Split long text into ~1200-char windows (with light overlap), capped, so a
 *  long answer is covered by several embeddings instead of being truncated. */
function chunkText(text: string, size = 1200, overlap = 150, max = 6): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < max; i += size - overlap) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

/** Mean-pool a set of unit vectors, then re-normalize to unit length. */
function meanNormalize(vecs: number[][]): number[] {
  if (!vecs.length) return [];
  const n = vecs[0]!.length;
  const out = new Array(n).fill(0);
  for (const v of vecs) for (let i = 0; i < n; i++) out[i] += v[i]!;
  let norm = 0;
  for (let i = 0; i < n; i++) { out[i] /= vecs.length; norm += out[i] * out[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) out[i] /= norm;
  return out;
}

export function useSemanticIndex(rawSegments: Segment[]): IndexState {
  const [cache, setCache] = useState<Map<string, EmbRecord>>(new Map());
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState("");
  const loadedRef = useRef(false);

  // Load cached vectors once.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    getAllEmbeddings().then(setCache).catch(() => setCache(new Map()));
  }, []);

  // Attach cached vectors to segments where the content hash still matches.
  const segments = useMemo(() => {
    if (!cache.size) return rawSegments;
    return rawSegments.map((s) => {
      const rec = cache.get(s.id);
      return rec && rec.hash === hashText(s.text) ? { ...s, embedding: rec.vec } : s;
    });
  }, [rawSegments, cache]);

  const total = rawSegments.length;
  const embedded = useMemo(() => segments.filter((s) => s.embedding && s.embedding.length).length, [segments]);
  const upToDate = total > 0 && embedded === total;

  const embedMissing = useCallback(async () => {
    const todo = segments.filter((s) => !(s.embedding && s.embedding.length));
    if (!todo.length) {
      setMessage("Vector index up to date.");
      return;
    }
    setBuilding(true);
    setMessage("Loading on-device model…");
    const emb = getEmbeddings();
    const off = emb.onProgress((p) => {
      if (p.status === "progress" && typeof p.progress === "number") setMessage(`Downloading model… ${p.progress}%`);
      else if (p.status === "ready" || p.status === "done") setMessage("Embedding turns…");
    });
    try {
      setProgress({ done: 0, total: todo.length });
      const BATCH = 16;
      const added = new Map<string, EmbRecord>();
      for (let i = 0; i < todo.length; i += BATCH) {
        const segs = todo.slice(i, i + BATCH);
        // Multi-window: chunk long turns into overlapping windows and embed each,
        // then mean-pool into a single normalized vector per turn. Captures the
        // whole answer (no 2000-char truncation) without changing the IDB schema.
        const items: { id: string; text: string }[] = [];
        for (const s of segs) chunkText(s.text).forEach((c, ci) => items.push({ id: `${s.id}@@${ci}`, text: c }));
        const res = await emb.embedBatch(items);
        const byBase = new Map<string, number[][]>();
        for (const r of res) {
          const base = r.id.slice(0, r.id.lastIndexOf("@@"));
          (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(r.embedding);
        }
        const recs: EmbRecord[] = segs.map((s) => ({
          id: s.id, hash: hashText(s.text), vec: meanNormalize(byBase.get(s.id) ?? []),
        })).filter((r) => r.vec.length > 0);
        await putEmbeddings(recs);
        recs.forEach((r) => added.set(r.id, r));
        setProgress({ done: Math.min(todo.length, i + BATCH), total: todo.length });
      }
      setCache((prev) => {
        const next = new Map(prev);
        added.forEach((v, k) => next.set(k, v));
        return next;
      });
      await pruneEmbeddings(new Set(rawSegments.map((s) => s.id)));
      setMessage("Vector index ready.");
      // Let read-only vector consumers (find-similar, useChatSearch) refresh.
      window.dispatchEvent(new Event("vectors-updated"));
    } catch (e) {
      setMessage("Indexing failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      off();
      setBuilding(false);
      setProgress(null);
    }
  }, [segments, rawSegments]);

  const rebuild = useCallback(async () => {
    await clearEmbeddings();
    setCache(new Map());
    // allow state to settle, then embed everything
    setTimeout(() => void embedMissing(), 0);
  }, [embedMissing]);

  return {
    segments,
    total,
    embedded,
    upToDate,
    building,
    progress,
    message,
    buildIndex: embedMissing,
    rebuild,
  };
}
