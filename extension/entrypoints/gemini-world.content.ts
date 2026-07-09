// Main-world (page-context) RPC bridge for the history loader.
//
// WHY THIS EXISTS
// The extension's main content script (gemini.content.ts) runs in an ISOLATED
// world, so it cannot read `window.WIZ_global_data` — the object that holds the
// session tokens (SNlM0e / f.sid / bl) the batchexecute endpoint requires. Those
// tokens live only in the page's MAIN world.
//
// This script is injected into the MAIN world, so it CAN read the tokens and
// issue the exact same authenticated fetch the Gemini app itself makes. It has no
// access to extension APIs (that's fine), and communicates with the isolated
// content script purely over `window.postMessage`:
//
//   isolated →  { source: "GCE_RPC_REQ", id, rpcid, arg }        (or { ping:true })
//   main     →  { source: "GCE_RPC_RES", id, ok, status, text }  (raw response text)
//
// The isolated side (lib/gemini-rpc.ts) parses the returned text. Doing the fetch
// here — where cookies, tokens, and the page's own connect-src CSP all apply —
// makes the request behaviourally identical to the app's own history call.

const REQ = "GCE_RPC_REQ";
const RES = "GCE_RPC_RES";
const BATCHEXECUTE_PATH = "_/BardChatUi/data/batchexecute";

interface Tokens {
  at: string;
  sid: string;
  bl: string;
  hl: string;
  prefix: string;
}

export default defineContentScript({
  matches: ["https://gemini.google.com/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    let reqCounter = Math.floor(Math.random() * 90000) + 10000;

    const readTokens = (): Tokens | null => {
      const w = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data;
      const at = w && typeof w.SNlM0e === "string" ? (w.SNlM0e as string) : "";
      if (!at) return null; // page not fully booted, or not signed in
      const sid = w && typeof w.FdrFJe === "string" ? (w.FdrFJe as string) : "";
      const bl = w && typeof w.cfb2h === "string" ? (w.cfb2h as string) : "";
      const hl =
        (w && typeof w.qwAQke === "string" && (w.qwAQke as string)) ||
        document.documentElement.getAttribute("lang") ||
        "en";
      const m = location.pathname.match(/^\/u\/\d+\//);
      return { at, sid, bl, hl, prefix: m ? m[0] : "/" };
    };

    window.addEventListener("message", async (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as
        | { source?: string; id?: string; rpcid?: string; arg?: unknown; ping?: boolean }
        | undefined;
      if (!data || data.source !== REQ || !data.id) return;

      const reply = (payload: Record<string, unknown>) =>
        window.postMessage({ source: RES, id: data.id, ...payload }, location.origin);

      const tokens = readTokens();

      // Readiness ping: report whether the RPC path is usable right now.
      if (data.ping) {
        reply({ ok: !!tokens });
        return;
      }

      if (!tokens) {
        reply({ ok: false, error: "tokens-unavailable" });
        return;
      }

      try {
        const reqid = (reqCounter += 100000);
        const params = new URLSearchParams({
          rpcids: data.rpcid || "",
          "source-path": "/app",
          "f.sid": tokens.sid,
          bl: tokens.bl,
          hl: tokens.hl,
          _reqid: String(reqid),
          rt: "c",
        });
        const url = `${tokens.prefix}${BATCHEXECUTE_PATH}?${params.toString()}`;
        const freq = [[[data.rpcid, JSON.stringify(data.arg), null, "generic"]]];
        const body =
          "f.req=" +
          encodeURIComponent(JSON.stringify(freq)) +
          "&at=" +
          encodeURIComponent(tokens.at) +
          "&";

        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body,
        });
        const text = await res.text();
        reply({ ok: res.ok, status: res.status, text });
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  },
});
