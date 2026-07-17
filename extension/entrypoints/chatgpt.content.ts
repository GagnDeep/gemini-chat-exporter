// Content script for ChatGPT (chatgpt.com, chat.openai.com).
//
// Uses the generic auto-scroll capture engine driven by the CHATGPT provider
// profile: messages carry data-message-author-role, paired into Q&A turns.

import { installContentRuntime } from "@/lib/content-runtime";
import { CHATGPT } from "@/lib/providers";

export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  main() {
    installContentRuntime(CHATGPT);
  },
});
