"use client";

import { DocumentUploader, type UploadedDocument } from "@/components/document-uploader";
import { StatusBadge } from "@/components/status-badge";
import { docTypeLabels } from "@/lib/format";

export type PickerDocument = {
  id: string;
  title: string;
  description: string;
  docType: string;
  status: string;
};

// Selezione multipla dei documenti di libreria, usata sia nel flusso
// "Nuova partita" che nella gestione documenti di una campagna esistente.
export function DocumentPicker({
  documents,
  selectedIds,
  onToggle,
  onUploaded,
}: {
  documents: PickerDocument[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  // Un PDF appena caricato viene aggiunto alla lista e selezionato dal parent.
  onUploaded: (doc: UploadedDocument) => void;
}) {
  return (
    <div className="space-y-4">
      {documents.length === 0 ? (
        <p className="rounded border border-zinc-800 p-4 text-sm text-zinc-400">
          La libreria è vuota: nessun documento da associare.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded border border-zinc-800">
          {documents.map((doc) => (
            <li key={doc.id}>
              <label className="flex cursor-pointer items-start gap-3 p-3 hover:bg-zinc-900">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(doc.id)}
                  onChange={() => onToggle(doc.id)}
                  className="mt-1 accent-indigo-500"
                />
                <span className="flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{doc.title}</span>
                    <span className="text-xs text-zinc-500">
                      {docTypeLabels[doc.docType] ?? doc.docType}
                    </span>
                    <StatusBadge status={doc.status} />
                  </span>
                  {doc.description && (
                    <span className="mt-0.5 block text-sm text-zinc-400">
                      {doc.description}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <DocumentUploader onUploaded={onUploaded} />
    </div>
  );
}
