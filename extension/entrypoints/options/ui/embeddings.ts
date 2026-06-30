// Promise-based client around the bundled embeddings worker, with model-load
// progress reporting and a cosine-similarity helper.

export interface LoadProgress {
  status: string;
  file?: string;
  progress?: number; // 0..100
  loaded?: number;
  total?: number;
}

type ProgressListener = (p: LoadProgress) => void;

interface WorkerMessage {
  type: "ready" | "progress" | "embedded" | "queryEmbedded" | "error";
  payload?: LoadProgress;
  batchId?: string;
  queryId?: string;
  result?: { id: string; embedding: number[] }[];
  embedding?: number[];
  message?: string;
}

class EmbeddingsClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private progressListeners = new Set<ProgressListener>();
  // LRU cache of recent query embeddings so re-typed/edited queries don't re-embed.
  private queryCache = new Map<string, number[]>();
  private static QUERY_CACHE_MAX = 50;

  private ensureWorker(): Worker {
    if (!this.worker) {
      // Bundled by Vite/WXT — the URL resolves to an extension-local chunk.
      this.worker = new Worker(new URL("../embeddings.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        for (const { reject } of this.pending.values()) reject(new Error(e.message || "Worker error"));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private onMessage(msg: WorkerMessage) {
    if (msg.type === "progress" && msg.payload) {
      const p = msg.payload;
      this.progressListeners.forEach((l) =>
        l({
          status: p.status,
          file: p.file,
          progress: typeof p.progress === "number" ? Math.round(p.progress) : undefined,
          loaded: p.loaded,
          total: p.total,
        }),
      );
      return;
    }
    if (msg.type === "embedded" && msg.batchId) {
      this.pending.get(msg.batchId)?.resolve(msg.result ?? []);
      this.pending.delete(msg.batchId);
      return;
    }
    if (msg.type === "queryEmbedded" && msg.queryId) {
      this.pending.get(msg.queryId)?.resolve(msg.embedding ?? []);
      this.pending.delete(msg.queryId);
      return;
    }
    if (msg.type === "error") {
      const key = msg.batchId || msg.queryId;
      if (key) {
        this.pending.get(key)?.reject(new Error(msg.message || "Embedding failed"));
        this.pending.delete(key);
      }
    }
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  embedBatch(items: { id: string; text: string }[]): Promise<{ id: string; embedding: number[] }[]> {
    const worker = this.ensureWorker();
    const batchId = `b${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(batchId, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ type: "embed", batchId, items });
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    const key = text.trim().toLowerCase();
    const cached = this.queryCache.get(key);
    if (cached) {
      // refresh recency
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      return cached;
    }
    const worker = this.ensureWorker();
    const queryId = `q${++this.seq}`;
    const vec = await new Promise<number[]>((resolve, reject) => {
      this.pending.set(queryId, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ type: "embedQuery", queryId, text });
    });
    this.queryCache.set(key, vec);
    if (this.queryCache.size > EmbeddingsClient.QUERY_CACHE_MAX) {
      this.queryCache.delete(this.queryCache.keys().next().value as string);
    }
    return vec;
  }

  warmup(): void {
    this.ensureWorker().postMessage({ type: "warmup" });
  }
}

let singleton: EmbeddingsClient | null = null;
export function getEmbeddings(): EmbeddingsClient {
  if (!singleton) singleton = new EmbeddingsClient();
  return singleton;
}

/** Cosine similarity for unit-normalized vectors (dot product). */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
