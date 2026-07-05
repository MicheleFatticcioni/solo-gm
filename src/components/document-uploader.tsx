"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { docTypeLabels } from "@/lib/format";

export type UploadedDocument = {
  id: string;
  title: string;
  description: string;
  docType: string;
  status: string;
};

type PendingFile = {
  key: string;
  file: File;
  title: string;
  description: string;
  docType: string;
  uploading: boolean;
  error: string | null;
};

// Drag&drop / file picker multiplo con mini-form per file.
// L'upload è sequenziale: una richiesta per file, più robusto
// di un multipart multiplo.
export function DocumentUploader({
  onUploaded,
}: {
  onUploaded?: (doc: UploadedDocument) => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  function addFiles(files: FileList | File[]) {
    const pdfs = [...files].filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    setPending((prev) => [
      ...prev,
      ...pdfs.map((file) => ({
        key: crypto.randomUUID(),
        file,
        title: file.name.replace(/\.pdf$/i, ""),
        description: "",
        docType: "regolamento",
        uploading: false,
        error: null,
      })),
    ]);
  }

  function update(key: string, patch: Partial<PendingFile>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  const allValid =
    pending.length > 0 &&
    pending.every((p) => p.title.trim().length > 0 && p.description.trim().length > 0);

  async function uploadAll() {
    setUploading(true);
    // Sequenziale per scelta: vedi commento del componente.
    for (const entry of pending) {
      update(entry.key, { uploading: true, error: null });
      try {
        const form = new FormData();
        form.append("file", entry.file);
        form.append("title", entry.title.trim());
        form.append("description", entry.description.trim());
        form.append("docType", entry.docType);

        const res = await fetch("/api/documents", { method: "POST", body: form });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Upload fallito (${res.status})`);
        }
        const doc = (await res.json()) as UploadedDocument;
        setPending((prev) => prev.filter((p) => p.key !== entry.key));
        onUploaded?.(doc);
      } catch (err) {
        update(entry.key, {
          uploading: false,
          error: err instanceof Error ? err.message : "Errore imprevisto",
        });
      }
    }
    setUploading(false);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded border border-dashed p-6 text-center text-sm transition-colors ${
          dragging
            ? "border-indigo-500 bg-indigo-950/30 text-indigo-300"
            : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
        }`}
      >
        Trascina qui i PDF oppure clicca per sceglierli
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {pending.length > 0 && (
        <div className="space-y-3">
          {pending.map((entry) => (
            <div
              key={entry.key}
              className="space-y-2 rounded border border-zinc-800 bg-zinc-900/50 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-zinc-500">
                  {entry.file.name} · {(entry.file.size / (1024 * 1024)).toFixed(1)} MB
                </span>
                <button
                  type="button"
                  disabled={entry.uploading}
                  onClick={() =>
                    setPending((prev) => prev.filter((p) => p.key !== entry.key))
                  }
                  className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                >
                  Rimuovi
                </button>
              </div>
              <input
                value={entry.title}
                disabled={entry.uploading}
                onChange={(e) => update(entry.key, { title: e.target.value })}
                placeholder="Titolo"
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
              />
              <textarea
                value={entry.description}
                disabled={entry.uploading}
                onChange={(e) => update(entry.key, { description: e.target.value })}
                placeholder="Descrizione: contenuto e uso (es. tabelle incontri casuali per le terre selvagge)"
                rows={2}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
              />
              <select
                value={entry.docType}
                disabled={entry.uploading}
                onChange={(e) => update(entry.key, { docType: e.target.value })}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
              >
                {Object.entries(docTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {entry.uploading && (
                <p className="text-xs text-zinc-400">Caricamento…</p>
              )}
              {entry.error && <p className="text-xs text-red-400">{entry.error}</p>}
            </div>
          ))}

          <button
            type="button"
            onClick={uploadAll}
            disabled={!allValid || uploading}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading
              ? "Caricamento…"
              : `Carica ${pending.length === 1 ? "il PDF" : `${pending.length} PDF`}`}
          </button>
          {!allValid && (
            <p className="text-xs text-zinc-500">
              Titolo e descrizione sono obbligatori per ogni file.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
