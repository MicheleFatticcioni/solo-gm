"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";

// Sezione "Istruzioni per l'AI": indicazioni libere del giocatore su
// come il GM deve condurre questa campagna, modificabili in ogni momento.
export function CampaignInstructions({
  campaignId,
  initialInstructions,
}: {
  campaignId: string;
  initialInstructions: string | null;
}) {
  const router = useRouter();
  const [instructions, setInstructions] = useState(initialInstructions ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [improving, setImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Riscrive il testo corrente con l'AI (conservativo + markdown) e lo
  // rimette nella bozza: il salvataggio resta un passo esplicito.
  async function improve() {
    const text = draft.trim();
    if (!text) return;
    setImproving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/instructions/improve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? "Errore durante il miglioramento");
      }
      setDraft(body.instructions);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Errore durante il miglioramento",
      );
    } finally {
      setImproving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiInstructions: draft.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Errore durante il salvataggio");
      }
      setInstructions(draft.trim());
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Errore durante il salvataggio",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">Istruzioni per l&rsquo;AI</h2>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(instructions);
              setEditing(true);
              setError(null);
            }}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
          >
            Modifica
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            autoFocus
            placeholder="es. Tono cupo e survival, combattimenti letali, dai molto spazio all'esplorazione…"
            className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 p-3 text-sm outline-none focus:border-indigo-500"
          />
          <p className="text-sm text-zinc-500">
            Il GM terrà sempre conto di queste indicazioni in ogni turno di
            gioco. Lascia vuoto per rimuoverle. &ldquo;Migliora con AI&rdquo;
            riscrive e formatta il testo per renderlo più efficace, senza
            cambiarne il senso.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || improving}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Salvataggio…" : "Salva"}
            </button>
            <button
              type="button"
              onClick={improve}
              disabled={improving || saving || draft.trim().length === 0}
              className="rounded border border-indigo-500/60 px-3 py-1.5 text-sm text-indigo-300 hover:border-indigo-400 hover:text-indigo-200 disabled:opacity-50"
            >
              {improving ? "Miglioramento…" : "✨ Migliora con AI"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving || improving}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
            >
              Annulla
            </button>
          </div>
        </div>
      ) : instructions ? (
        <div className="space-y-2 rounded border border-zinc-800 p-4 text-sm leading-relaxed text-zinc-300 [&_h2]:mt-4 [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h2:first-child]:mt-0 [&_h3]:mt-3 [&_h3]:font-semibold [&_h3]:text-zinc-200 [&_li]:ml-1 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
          <ReactMarkdown>{instructions}</ReactMarkdown>
        </div>
      ) : (
        <p className="rounded border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
          Nessuna istruzione. Usa &ldquo;Modifica&rdquo; per dire al GM come
          condurre questa campagna (tono, stile, temi da evitare…).
        </p>
      )}

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
