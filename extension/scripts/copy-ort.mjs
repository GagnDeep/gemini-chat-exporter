// Copies the onnxruntime-web WASM runtime (the ONNX backend used by
// @huggingface/transformers) into public/ort/ so it ships as an extension-local
// asset. This is what lets the embeddings worker load the WASM glue under the
// manifest CSP `script-src 'self'` instead of the blocked `blob:` URL that ORT
// would otherwise dynamically import.
//
// The wasm files are large (~13–26 MB each) and version-locked to whatever
// onnxruntime-web @huggingface/transformers resolves, so they are generated at
// build time (and git-ignored) rather than committed. Run from package.json's
// dev/build/postinstall scripts.

import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(extensionRoot, "public", "ort");

// Match the simd-threaded runtime families (plain + jsep/jspi/asyncify variants)
// so ORT finds whichever build it requests at runtime. Glue (.mjs) + binary
// (.wasm) only — skip the huge ort.all.* bundles we don't load.
const WANTED = /^ort-wasm-simd-threaded(?:\.[a-z]+)?\.(wasm|mjs)$/;

function resolveOrtDist() {
  // Explicit dep on onnxruntime-web gives a stable top-level resolution path.
  // The package's `exports` map hides package.json, so resolve the dir directly
  // (node_modules symlink), falling back to the resolved entry's dist folder.
  const direct = join(extensionRoot, "node_modules", "onnxruntime-web", "dist");
  if (existsSync(direct)) return direct;
  const entry = require.resolve("onnxruntime-web");
  // entry is typically <pkg>/dist/ort.mjs — climb to the dist dir.
  let dir = dirname(entry);
  while (dir !== dirname(dir) && !existsSync(join(dir, "ort-wasm-simd-threaded.wasm"))) {
    dir = dirname(dir);
  }
  return dir;
}

try {
  const dist = resolveOrtDist();
  const files = readdirSync(dist).filter((f) => WANTED.test(f));
  if (!files.length) {
    console.warn("[copy-ort] no matching ORT wasm files found in", dist);
    process.exit(0);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const f of files) cpSync(join(dist, f), join(outDir, f));
  console.log(`[copy-ort] copied ${files.length} ORT asset(s) → public/ort/`);
} catch (err) {
  // Non-fatal: semantic search just stays unavailable until deps are installed.
  console.warn("[copy-ort] skipped:", err instanceof Error ? err.message : err);
}
