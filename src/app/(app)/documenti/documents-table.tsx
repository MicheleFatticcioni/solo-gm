"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { StatusBadge } from "@/components/status-badge";
import { docTypeLabels } from "@/lib/format";
import { useDocumentPolling } from "@/lib/use-document-polling";

type LibraryDocument = {
  id: string;
  title: string;
  description: string;
  docType: string;
  status: string;
  errorMessage: string | null;
  usedBy: { id: string; name: string }[];
};

export function DocumentsTable({ documents }: { documents: LibraryDocument[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<LibraryDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Finché ci sono elaborazioni in corso, ricarica la lista quando
  // uno stato cambia (la pagina è server-rendered: basta un refresh).
  useDocumentPolling(documents, (fresh) => {
    const changed = fresh.some(
      (f) => documents.find((d) => d.id === f.id)?.status !== f.status,
    );
    if (changed) router.refresh();
  });

  async function retryDocument(doc: LibraryDocument) {
    setError(null);
    const res = await fetch(`/api/documents/${doc.id}/retry`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore nel rilancio dell'elaborazione");
      return;
    }
    router.refresh();
  }

  async function deleteDocument(doc: LibraryDocument) {
    if (!confirm(`Eliminare "${doc.title}"? Il file e l'indice verranno rimossi.`)) {
      return;
    }
    setError(null);
    const res = await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore durante l'eliminazione");
      return;
    }
    router.refresh();
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-700 text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-3 py-2">Titolo</th>
            <th className="px-3 py-2">Tipo</th>
            <th className="px-3 py-2">Stato</th>
            <th className="px-3 py-2">Campagne</th>
            <th className="px-3 py-2 text-right">Azioni</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {documents.map((doc) => (
            <tr key={doc.id} className="align-top">
              <td className="px-3 py-3">
                <div className="font-medium text-zinc-100">{doc.title}</div>
                {doc.description && (
                  <div className="mt-0.5 text-zinc-400">{doc.description}</div>
                )}
                {doc.status === "error" && doc.errorMessage && (
                  <div className="mt-1 text-red-400">{doc.errorMessage}</div>
                )}
              </td>
              <td className="px-3 py-3 text-zinc-400">
                {docTypeLabels[doc.docType] ?? doc.docType}
              </td>
              <td className="px-3 py-3">
                <StatusBadge status={doc.status} />
              </td>
              <td className="px-3 py-3">
                {doc.usedBy.length === 0 ? (
                  <span className="text-zinc-600">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {doc.usedBy.map((c) => (
                      <Link
                        key={c.id}
                        href={`/campaigns/${c.id}`}
                        className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700"
                      >
                        {c.name}
                      </Link>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-3 text-right">
                <div className="inline-flex gap-2">
                  {doc.status === "error" && (
                    <button
                      type="button"
                      onClick={() => retryDocument(doc)}
                      className="rounded border border-yellow-900 px-2 py-1 text-xs text-yellow-400 hover:border-yellow-700"
                    >
                      Riprova
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditing(doc)}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs hover:border-zinc-500"
                  >
                    Modifica
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteDocument(doc)}
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-400 hover:border-red-700"
                  >
                    Elimina
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <EditDocumentModal
          document={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EditDocumentModal({
  document,
  onClose,
  onSaved,
}: {
  document: LibraryDocument;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(document.title);
  const [description, setDescription] = useState(document.description);
  const [docType, setDocType] = useState(document.docType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), description, docType }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore nel salvataggio");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={save}
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-950 p-6"
      >
        <h2 className="mb-4 text-lg font-semibold">Modifica documento</h2>
        <div className="space-y-4">
          <div>
            <label htmlFor="doc-title" className="mb-1 block text-sm text-zinc-300">
              Titolo
            </label>
            <input
              id="doc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="doc-desc" className="mb-1 block text-sm text-zinc-300">
              Descrizione
            </label>
            <textarea
              id="doc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="doc-type" className="mb-1 block text-sm text-zinc-300">
              Tipo
            </label>
            <select
              id="doc-type"
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            >
              {Object.entries(docTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
          >
            Annulla
          </button>
          <button
            type="submit"
            disabled={saving || title.trim().length === 0}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Salvataggio…" : "Salva"}
          </button>
        </div>
      </form>
    </div>
  );
}
