"use client";

import { useEffect, useRef } from "react";

export type PolledDocument = {
  id: string;
  status: string;
  errorMessage: string | null;
  pageCount: number | null;
  chunkCount: number | null;
};

const POLL_INTERVAL_MS = 3000;

export function hasActiveDocuments(documents: { status: string }[]): boolean {
  return documents.some((d) => d.status === "uploaded" || d.status === "processing");
}

// Finché c'è almeno un documento in coda o in elaborazione, interroga
// GET /api/documents ogni ~3s e passa la lista fresca al chiamante.
export function useDocumentPolling(
  documents: { status: string }[],
  onRefresh: (fresh: PolledDocument[]) => void,
) {
  // Ref aggiornata in un effect: evita di riavviare l'intervallo
  // a ogni render per una callback tipicamente inline.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });

  const active = hasActiveDocuments(documents);

  useEffect(() => {
    if (!active) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/documents");
        if (!res.ok) return;
        onRefreshRef.current((await res.json()) as PolledDocument[]);
      } catch {
        // errore di rete transitorio: si riprova al prossimo giro
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [active]);
}
