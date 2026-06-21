/* Embeddings Web Worker.
 *
 * Runs the all-MiniLM-L6-v2 sentence-embedding model fully in the browser via
 * transformers.js (loaded from CDN at runtime so nothing needs bundling). The
 * model weights (~25 MB, quantized) download once and are cached by the browser.
 *
 * Loaded as a module worker: new Worker('/embeddings-worker.js', { type: 'module' }).
 */

const TRANSFORMERS_CDN =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS_CDN);
      // Browser mode: fetch models from the HF hub, no local filesystem.
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      return pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
        progress_callback: (p) => {
          self.postMessage({ type: "progress", payload: p });
        },
      });
    })();
  }
  return extractorPromise;
}

async function embedTexts(texts) {
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  // out.tolist() -> number[][] (one normalized vector per input)
  return out.tolist();
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "warmup") {
      await getExtractor();
      self.postMessage({ type: "ready" });
      return;
    }

    if (msg.type === "embed") {
      // msg.items: [{ id, text }]
      const texts = msg.items.map((it) => it.text || "");
      const vectors = await embedTexts(texts);
      const result = msg.items.map((it, i) => ({ id: it.id, embedding: vectors[i] }));
      self.postMessage({ type: "embedded", batchId: msg.batchId, result });
      return;
    }

    if (msg.type === "embedQuery") {
      const [vec] = await embedTexts([msg.text || ""]);
      self.postMessage({ type: "queryEmbedded", queryId: msg.queryId, embedding: vec });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      batchId: msg.batchId,
      queryId: msg.queryId,
      message: err && err.message ? err.message : String(err),
    });
  }
};
