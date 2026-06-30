// Tiny event-based toast bus. Any module can fire a toast without prop-drilling;
// <Toaster> (mounted once in App) renders + auto-dismisses them.

export type ToastKind = "info" | "ok" | "err";
export interface ToastMsg { id: number; message: string; kind: ToastKind; }

let seq = 0;

export function showToast(message: string, kind: ToastKind = "info"): void {
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { id: ++seq, message, kind } }));
}
