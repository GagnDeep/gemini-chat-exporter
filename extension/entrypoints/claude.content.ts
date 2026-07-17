// Content script for Claude (claude.ai).
//
// Uses the generic auto-scroll capture engine (Claude has no public history RPC),
// driven by the CLAUDE provider profile: a flat user/assistant message stream
// paired into Q&A turns.

import { installContentRuntime } from "@/lib/content-runtime";
import { CLAUDE } from "@/lib/providers";

export default defineContentScript({
  matches: ["https://claude.ai/*"],
  main() {
    installContentRuntime(CLAUDE);
  },
});
