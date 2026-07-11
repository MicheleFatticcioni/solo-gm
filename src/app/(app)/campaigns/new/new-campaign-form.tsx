"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { DocumentPicker, type PickerDocument } from "@/components/document-picker";
import type { UploadedDocument } from "@/components/document-uploader";
import { useDocumentPolling } from "@/lib/use-document-polling";

export function NewCampaignForm({
  documents: initialDocuments,
}: {
  documents: PickerDocument[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [gameSystem, setGameSystem] = useState("");
  const [aiInstructions, setAiInstructions] = useState("");
  const [documents, setDocuments] = useState<PickerDocument[]>(initialDocuments);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Aggiorna i badge di stato dei PDF appena caricati.
  useDocumentPolling(documents, (fresh) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        const updated = fresh.find((f) => f.id === doc.id);
        return updated ? { ...doc, status: updated.status } : doc;
      }),
    );
  });

  const step1Valid = name.trim().length > 0 && gameSystem.trim().length > 0;

  function toggleDocument(id: string) {
    setSelectedIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }

  // Un documento caricato da qui è pensato per questa campagna:
  // lo si aggiunge alla lista già selezionato.
  function handleUploaded(doc: UploadedDocument) {
    setDocuments((docs) => [...docs, doc]);
    setSelectedIds((ids) => [...ids, doc.id]);
  }

  async function create() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          gameSystem: gameSystem.trim(),
          aiInstructions: aiInstructions.trim(),
          documentIds: selectedIds,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Errore nella creazione della campagna");
      }
      const campaign = await res.json();
      router.push(`/campaigns/${campaign.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <ol className="flex gap-2 text-xs text-zinc-500">
        <li className={step === 1 ? "font-medium text-zinc-200" : ""}>
          1. Sistema e nome
        </li>
        <li>→</li>
        <li className={step === 2 ? "font-medium text-zinc-200" : ""}>
          2. Documenti
        </li>
      </ol>

      {step === 1 ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (step1Valid) setStep(2);
          }}
        >
          <div>
            <label htmlFor="gameSystem" className="mb-1 block text-sm text-zinc-300">
              Sistema di gioco
            </label>
            <input
              id="gameSystem"
              value={gameSystem}
              onChange={(e) => setGameSystem(e.target.value)}
              placeholder="es. Ironsworn"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="name" className="mb-1 block text-sm text-zinc-300">
              Nome della campagna
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="es. Le terre selvagge"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label
              htmlFor="aiInstructions"
              className="mb-1 block text-sm text-zinc-300"
            >
              Istruzioni per l&rsquo;AI{" "}
              <span className="text-zinc-500">(opzionale)</span>
            </label>
            <textarea
              id="aiInstructions"
              value={aiInstructions}
              onChange={(e) => setAiInstructions(e.target.value)}
              rows={5}
              placeholder="es. Tono cupo e survival, combattimenti letali, dai molto spazio all'esplorazione…"
              className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Il GM terrà sempre conto di queste indicazioni. Potrai
              modificarle in qualsiasi momento dalla pagina della campagna.
            </p>
          </div>
          <button
            type="submit"
            disabled={!step1Valid}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Avanti
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            Seleziona i documenti della libreria da usare in{" "}
            <span className="text-zinc-200">{name}</span> ({gameSystem}). Potrai
            modificarli in qualsiasi momento.
          </p>
          <DocumentPicker
            documents={documents}
            selectedIds={selectedIds}
            onToggle={toggleDocument}
            onUploaded={handleUploaded}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
            >
              Indietro
            </button>
            <button
              type="button"
              onClick={create}
              disabled={submitting}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {submitting ? "Creazione…" : "Crea campagna"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
