"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type Summary = {
  id: string;
  content: string;
  isUserEdited: boolean;
  createdAt: string;
};

// Quanto a lungo il polling attende un riassunto nuovo dopo "Aggiorna
// ora": il job può legittimamente non produrre nulla (guardia sui
// messaggi minimi), quindi serve un limite.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 20;

const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "medium",
  timeStyle: "short",
});

// Sezione "Memoria della campagna": riassunto attivo con modifica
// manuale e rigenerazione on demand.
export function CampaignSummary({
  campaignId,
  initialSummary,
}: {
  campaignId: string;
  initialSummary: Summary | null;
}) {
  const [summary, setSummary] = useState<Summary | null>(initialSummary);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  async function fetchSummary(): Promise<Summary | null> {
    const res = await fetch(`/api/campaigns/${campaignId}/summary`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error();
    return res.json();
  }

  async function save() {
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/summary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Errore durante il salvataggio");
      }
      setSummary(await res.json());
      setEditing(false);
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

  // POST regenerate, poi polling del GET finché compare un riassunto
  // con createdAt più recente (o si esaurisce il budget di tentativi).
  async function regenerate() {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    const baseline = summary?.createdAt ?? null;
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/summary/regenerate`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error();

      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;
        const latest = await fetchSummary();
        // ISO 8601: il confronto lessicografico è anche cronologico.
        if (latest && (!baseline || latest.createdAt > baseline)) {
          setSummary(latest);
          setNotice("Riassunto aggiornato.");
          return;
        }
      }
      setNotice(
        "Nessun nuovo riassunto per ora: serve abbastanza storia nuova non ancora coperta.",
      );
    } catch {
      if (!cancelledRef.current)
        setError("Errore durante l'aggiornamento del riassunto.");
    } finally {
      if (!cancelledRef.current) setRefreshing(false);
    }
  }

  return (
    <section id="memoria">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-medium">Memoria della campagna</h2>
        <div className="ml-auto flex items-center gap-2">
          {summary && !editing && (
            <button
              type="button"
              onClick={() => {
                setDraft(summary.content);
                setEditing(true);
                setNotice(null);
                setError(null);
              }}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
            >
              Modifica
            </button>
          )}
          <button
            type="button"
            onClick={regenerate}
            disabled={refreshing || editing}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-50"
          >
            {refreshing ? "Aggiornamento…" : "Aggiorna ora"}
          </button>
          <a
            href={`/api/campaigns/${campaignId}/export`}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
          >
            Esporta partita
          </a>
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={16}
            className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 p-3 font-mono text-sm outline-none focus:border-indigo-500"
          />
          <p className="text-sm text-zinc-500">
            Il riassunto è la memoria a lungo termine del GM: correggi qui gli
            errori di trama e verranno rispettati nei turni successivi.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || draft.trim().length === 0}
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
      ) : summary ? (
        <div className="rounded border border-zinc-800 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>Aggiornato il {dateFormatter.format(new Date(summary.createdAt))}</span>
            {summary.isUserEdited && (
              <span className="rounded-full border border-amber-800/60 bg-amber-950/40 px-2 py-0.5 text-amber-200">
                modificato manualmente
              </span>
            )}
          </div>
          <div className="space-y-2 text-sm leading-relaxed text-zinc-300 [&_h2]:mt-4 [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h2:first-child]:mt-0 [&_li]:ml-1 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
            <ReactMarkdown>{summary.content}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <p className="rounded border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
          Il riassunto verrà generato automaticamente quando la storia cresce.
        </p>
      )}

      {notice && <p className="mt-2 text-sm text-zinc-400">{notice}</p>}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
