"use client";

import { useEffect } from "react";
import { installExtensionBridge } from "@/lib/extension-bridge";

/**
 * Mounts the extension → web app sync bridge once for the whole app. Renders
 * nothing; lives in the root layout so chats pushed by the extension land in
 * IndexedDB no matter which page is open.
 */
export function ExtensionBridgeMount() {
  useEffect(() => installExtensionBridge(), []);
  return null;
}
