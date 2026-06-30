import React, { useEffect, useState } from "react";
import type { ToastMsg } from "./toast";
import * as I from "./icons";

/** Renders + auto-dismisses toasts fired via showToast(). Mounted once in App. */
export function Toaster() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<ToastMsg>).detail;
      setToasts((cur) => [...cur, t]);
      setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), 3800);
    };
    window.addEventListener("app-toast", onToast);
    return () => window.removeEventListener("app-toast", onToast);
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>
          <span className="toast-ic">{t.kind === "err" ? <I.Close size={14} /> : t.kind === "ok" ? <I.Sparkle size={13} /> : <I.Msg size={13} />}</span>
          <span>{t.message}</span>
          <button className="toast-x" aria-label="Dismiss" onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}>
            <I.Close size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
