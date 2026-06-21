import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is fully client-side / local-first: chats live in IndexedDB and
  // embeddings run in a Web Worker via transformers.js. Nothing leaves the
  // browser, so the build stays simple and statically deployable.
  reactStrictMode: true,
};

export default nextConfig;
