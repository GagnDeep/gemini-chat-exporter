/// <reference lib="webworker" />
//
// On-device embeddings worker for semantic search.
//
// Unlike the companion web app (which imports transformers.js from a CDN at
// runtime), an MV3 extension page may not execute remote code, so the library
// is *bundled* into this worker. Only the model weights + the ONNX WebAssembly
// runtime are fetched over the network — no remote scripts are run. The model
// (~25 MB, quantized) is cached by the browser after the first download.

import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

// --- ONNX runtime backend wiring (the fix for "no available backend found") ---
//
// onnxruntime-web normally dynamically `import()`s its WASM glue from a `blob:`
// URL, which the manifest CSP (`script-src 'self' 'wasm-unsafe-eval'`) blocks.
// We instead serve the runtime from extension-local files copied into
// `public/ort/` (see scripts/copy-ort.mjs), which resolves under `'self'`.
//
//  - numThreads = 1  → single-threaded; avoids the nested-worker/blob path and
//    the COOP/COEP cross-origin-isolation an extension page can't satisfy.
//  - proxy = false   → no proxy worker (another blob script source).
//  - wasmPaths       → the extension-local directory holding ort-wasm-*.{wasm,mjs}.
const ORT_BASE = `${self.location.origin}/ort/`;
// `env.backends.onnx.wasm` is typed loosely across transformers/ORT versions.
const wasm = (env.backends as any)?.onnx?.wasm;
if (wasm) {
  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.wasmPaths = ORT_BASE;
}

// Prefer extension-local model weights when present (offline + instant first
// index — see scripts/fetch-model.mjs). Falls back to the Hugging Face CDN when
// the weights weren't bundled, so semantic search works either way.
env.allowLocalModels = true;
env.localModelPath = `${self.location.origin}/models/`;
env.allowRemoteModels = true;
env.useBrowserCache = true;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
      progress_callback: (p: unknown) => {
        (self as DedicatedWorkerGlobalScope).postMessage({ type: "progress", payload: p });
      },
    });
  }
  return extractorPromise;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}

interface InMsg {
  type: "warmup" | "embed" | "embedQuery";
  items?: { id: string; text: string }[];
  text?: string;
  batchId?: string;
  queryId?: string;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data || ({} as InMsg);
  const post = (m: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(m);
  try {
    if (msg.type === "warmup") {
      await getExtractor();
      post({ type: "ready" });
      return;
    }
    if (msg.type === "embed" && msg.items) {
      const texts = msg.items.map((it) => it.text || "");
      const vectors = await embedTexts(texts);
      const result = msg.items.map((it, i) => ({ id: it.id, embedding: vectors[i] }));
      post({ type: "embedded", batchId: msg.batchId, result });
      return;
    }
    if (msg.type === "embedQuery") {
      const [vec] = await embedTexts([msg.text || ""]);
      post({ type: "queryEmbedded", queryId: msg.queryId, embedding: vec });
      return;
    }
  } catch (err) {
    post({
      type: "error",
      batchId: msg.batchId,
      queryId: msg.queryId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
