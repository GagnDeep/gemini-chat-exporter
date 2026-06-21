"use client";

import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { importChats } from "@/lib/db";
import { parseExport, ImportError } from "@/lib/import-export";

export function ImportPanel({ onImported }: { onImported?: (n: number) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true);
    setMsg(null);
    try {
      let total = 0;
      for (const file of Array.from(files)) {
        const text = await file.text();
        const chats = parseExport(text);
        total += await importChats(chats);
      }
      setMsg({ text: `Imported ${total} chat${total === 1 ? "" : "s"}.` });
      onImported?.(total);
    } catch (e) {
      setMsg({
        text: e instanceof ImportError ? e.message : "Import failed. Check the file and try again.",
        err: true,
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          drag ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"
        }`}
      >
        {busy ? (
          <Loader2 className="size-6 animate-spin text-primary" />
        ) : (
          <Upload className="size-6 text-muted-foreground" />
        )}
        <p className="text-sm font-medium">Drop your Gemini JSON export</p>
        <p className="text-xs text-muted-foreground">or click to choose a file</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          multiple
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {msg && (
        <p className={`mt-2 text-xs ${msg.err ? "text-destructive" : "text-primary"}`}>{msg.text}</p>
      )}
      <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => inputRef.current?.click()}>
        Browse files
      </Button>
    </div>
  );
}
