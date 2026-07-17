// Content script for Gemini (gemini.google.com).
//
// Installs the shared capture runtime with Gemini's fast full-history path: its
// own authenticated batchexecute RPC (see lib/gemini-rpc.ts + the MAIN-world
// bridge in gemini-world.content.ts). The runtime falls back to the generic
// auto-scroll scraper automatically if the RPC is unavailable or disabled.

import { installContentRuntime } from "@/lib/content-runtime";
import { scrapeFullChatViaRpc } from "@/lib/gemini-rpc";
import { getSettings } from "@/lib/settings";
import { GEMINI } from "@/lib/providers";

export default defineContentScript({
  matches: ["https://gemini.google.com/*"],
  main() {
    installContentRuntime(GEMINI, {
      rpcFullCapture: async ({ onProgress, onSnapshot }) => {
        const s = await getSettings();
        if (!s.useRpcLoader) throw new Error("rpc-disabled"); // fall back to scrolling
        return scrapeFullChatViaRpc({
          pageSize: s.historyPageSize,
          onProgress: (i) => onProgress({ turns: i.turns, iteration: i.page, atTop: i.done, loading: !i.done }),
          onSnapshot,
        });
      },
    });
  },
});
