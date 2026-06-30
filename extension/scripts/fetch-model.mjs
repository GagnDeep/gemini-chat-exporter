// Downloads the MiniLM embedding model into public/models/ so semantic search
// works offline and indexes instantly on first run (no CDN round-trip / race).
// Optional — run `pnpm fetch-model`. Files are git-ignored (see .gitignore).
// The worker loads them via env.localModelPath; without them it falls back to
// the Hugging Face CDN.

import { mkdirSync, createWriteStream, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outRoot = join(extensionRoot, "public", "models", MODEL_ID);

async function fetchTo(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`[fetch-model] have   ${dest.replace(extensionRoot + "/", "")}`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(dest);
    Readable.fromWeb(res.body).pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
  console.log(`[fetch-model] saved  ${dest.replace(extensionRoot + "/", "")} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
}

try {
  for (const f of FILES) {
    // special_tokens_map.json is optional for some repos — don't fail the run.
    try { await fetchTo(`${BASE}/${f}`, join(outRoot, f)); }
    catch (e) {
      if (f === "special_tokens_map.json") console.warn(`[fetch-model] skip ${f}: ${e.message}`);
      else throw e;
    }
  }
  console.log("[fetch-model] done → public/models/");
} catch (err) {
  console.error("[fetch-model] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
