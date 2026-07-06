"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
  const [error, setError] = useState<string | null>(null);

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
            gioco. Lascia vuoto per rimuoverle.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Salvataggio…" : "Salva"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
            >
              Annulla
            </button>
          </div>
        </div>
      ) : instructions ? (
        <p className="whitespace-pre-wrap rounded border border-zinc-800 p-4 text-sm leading-relaxed text-zinc-300">
          {instructions}
        </p>
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
