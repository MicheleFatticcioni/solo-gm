"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ModuleStatus = "pending" | "ready" | "error" | null;

type ModuleState = {
  status: ModuleStatus;
  generatedAt: string | null;
  error: string | null;
};

// La generazione gira nel worker (job generate-module) e può durare
// diversi minuti: qui si fa polling sullo stato ogni POLL_INTERVAL_MS.
// Oltre il budget si smette di interrogare (il job continua comunque:
// basta ricaricare la pagina più tardi).
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 225; // ~15 minuti

const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "medium",
  timeStyle: "short",
});

// "Modulo della campagna": disponibile solo a campagna conclusa. Il
// markdown generato resta salvato, quindi PDF e .md si riscaricano
// senza rigenerare; "Rigenera" accoda una nuova generazione.
export function CampaignModule({
  campaignId,
  campaignName,
  initialModule,
}: {
  campaignId: string;
  campaignName: string;
  initialModule: ModuleState;
}) {
  const [module, setModule] = useState<ModuleState>(initialModule);
  const [requesting, setRequesting] = useState(false);
  const [slowNotice, setSlowNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTokenRef = useRef(0);

  // Invalida il polling in corso allo smontaggio.
  useEffect(() => {
    return () => {
      pollTokenRef.current++;
    };
  }, []);

  const poll = useCallback(async () => {
    const token = ++pollTokenRef.current;
    setSlowNotice(false);
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (pollTokenRef.current !== token) return;
      try {
        const res = await fetch(
          `/api/campaigns/${campaignId}/module?format=status`,
        );
        if (!res.ok) continue;
        const state: ModuleState = await res.json();
        if (pollTokenRef.current !== token) return;
        if (state.status !== "pending") {
          setModule(state);
          return;
        }
      } catch {
        // errore di rete transitorio: si ritenta al prossimo giro
      }
    }
    if (pollTokenRef.current === token) setSlowNotice(true);
  }, [campaignId]);

  // Pagina aperta (o riaperta) con una generazione già in corso: si
  // riaggancia il polling senza bisogno di un nuovo click.
  useEffect(() => {
    if (initialModule.status === "pending") void poll();
  }, [initialModule.status, poll]);

  async function generate() {
    if (
      module.status === "ready" &&
      !window.confirm(
        "Rigenerare il modulo? Quello attuale verrà sovrascritto.",
      )
    ) {
      return;
    }
    setRequesting(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/module`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Errore nell'avvio della generazione");
      }
      setModule((current) => ({ ...current, status: "pending", error: null }));
      void poll();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Errore nell'avvio della generazione",
      );
    } finally {
      setRequesting(false);
    }
  }

  const pending = module.status === "pending";

  return (
    <section className="rounded border border-amber-800/50 bg-amber-950/20 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">Modulo della campagna</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            La storia di «{campaignName}» trasformata in un modulo
            d&apos;avventura — PNG, oggetti, incontri e indizi — pronto per
            essere rigiocato da un gruppo umano.
            {module.generatedAt && (
              <span className="text-zinc-500">
                {" "}
                Generato il {dateFormatter.format(new Date(module.generatedAt))}.
              </span>
            )}
          </p>
        </div>
        {/* Il modulo salvato resta scaricabile anche se l'ultima
            rigenerazione è fallita: il job sovrascrive solo a successo. */}
        {module.generatedAt && !pending && (
          <>
            <a
              href={`/api/campaigns/${campaignId}/module?format=pdf`}
              className="rounded bg-amber-700 px-4 py-2 font-medium text-white hover:bg-amber-600"
            >
              Scarica PDF
            </a>
            <a
              href={`/api/campaigns/${campaignId}/module?format=md`}
              className="rounded border border-amber-800/60 px-4 py-2 font-medium text-amber-200 hover:border-amber-600"
            >
              Scarica .md
            </a>
          </>
        )}
        {module.status === "ready" && (
          <button
            type="button"
            onClick={generate}
            disabled={requesting}
            title="Accoda una nuova generazione e sovrascrive il modulo salvato"
            className="rounded border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500 disabled:opacity-50"
          >
            Rigenera
          </button>
        )}
        {(module.status === null || module.status === "error") && (
          <button
            type="button"
            onClick={generate}
            disabled={requesting}
            className="rounded bg-amber-700 px-4 py-2 font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {module.status === "error" ? "Riprova" : "Crea il modulo"}
          </button>
        )}
        {pending && (
          <span className="rounded border border-zinc-700 px-4 py-2 text-sm text-zinc-400">
            <span className="animate-pulse">Generazione in corso…</span>
          </span>
        )}
      </div>
      {pending && !slowNotice && (
        <p className="mt-2 text-sm text-zinc-500">
          L&apos;AI sta scrivendo il modulo nel worker: può richiedere qualche
          minuto. Puoi anche chiudere questa pagina e tornare più tardi.
        </p>
      )}
      {slowNotice && (
        <p className="mt-2 text-sm text-zinc-500">
          La generazione sta impiegando più del previsto: ricarica la pagina
          tra qualche minuto per vedere l&apos;esito.
        </p>
      )}
      {module.status === "error" && module.error && (
        <p className="mt-2 text-sm text-red-400">{module.error}</p>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
