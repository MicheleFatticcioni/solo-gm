"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { DocumentPicker, type PickerDocument } from "@/components/document-picker";
import type { UploadedDocument } from "@/components/document-uploader";
import { useDocumentPolling } from "@/lib/use-document-polling";

// Modale per sostituire l'insieme dei documenti associati alla campagna.
export function ManageDocuments({
  campaignId,
  library: initialLibrary,
  selectedIds: initialIds,
}: {
  campaignId: string;
  library: PickerDocument[];
  selectedIds: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<PickerDocument[]>(initialLibrary);
  const [selectedIds, setSelectedIds] = useState<string[]>(initialIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Aggiorna i badge di stato dei PDF appena caricati.
  useDocumentPolling(library, (fresh) => {
    setLibrary((prev) =>
      prev.map((doc) => {
        const updated = fresh.find((f) => f.id === doc.id);
        return updated ? { ...doc, status: updated.status } : doc;
      }),
    );
  });

  function openModal() {
    setSelectedIds(initialIds);
    setError(null);
    setOpen(true);
  }

  function toggle(id: string) {
    setSelectedIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }

  function handleUploaded(doc: UploadedDocument) {
    setLibrary((docs) => [...docs, doc]);
    setSelectedIds((ids) => [...ids, doc.id]);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaignId}/documents`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds: selectedIds }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore nel salvataggio");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
      >
        Gestisci documenti
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-6">
            <h2 className="mb-4 text-lg font-semibold">Gestisci documenti</h2>
            <DocumentPicker
              documents={library}
              selectedIds={selectedIds}
              onToggle={toggle}
              onUploaded={handleUploaded}
            />
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? "Salvataggio…" : "Salva"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
