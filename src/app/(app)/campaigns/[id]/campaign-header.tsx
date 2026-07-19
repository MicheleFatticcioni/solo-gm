"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Intestazione con rinomina inline, duplicazione, eliminazione e switch
// "campagna conclusa" (blocca la chat e sblocca il modulo PDF).
export function CampaignHeader({
  campaign,
}: {
  campaign: {
    id: string;
    name: string;
    gameSystem: string;
    concludedAt: string | null;
  };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const concluded = campaign.concludedAt !== null;

  async function toggleConcluded() {
    setToggling(true);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concluded: !concluded }),
    });
    setToggling(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore durante l'aggiornamento dello stato");
      return;
    }
    router.refresh();
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === campaign.name) {
      setEditing(false);
      setName(campaign.name);
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore durante la rinomina");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function duplicateCampaign() {
    setDuplicating(true);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaign.id}/duplicate`, {
      method: "POST",
    });
    setDuplicating(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore durante la duplicazione");
      return;
    }
    const copy = await res.json();
    router.push(`/campaigns/${copy.id}`);
    router.refresh();
  }

  async function deleteCampaign() {
    if (
      !confirm(
        "Eliminare la campagna? Messaggi e riassunti andranno persi; i documenti resteranno in libreria.",
      )
    ) {
      return;
    }
    const res = await fetch(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore durante l'eliminazione");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <header>
      <div className="flex items-center gap-3">
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xl font-semibold outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "…" : "Salva"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(campaign.name);
              }}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
            >
              Annulla
            </button>
          </form>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">{campaign.name}</h1>
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Rinomina campagna"
              className="text-sm text-zinc-500 hover:text-zinc-200"
            >
              ✏️
            </button>
            {concluded && (
              <span className="rounded-full border border-amber-800/60 bg-amber-950/40 px-2.5 py-0.5 text-xs text-amber-200">
                Conclusa
              </span>
            )}
          </>
        )}
        <label
          title={
            concluded
              ? "Riapri la campagna per continuare a giocare"
              : "Segna la campagna come conclusa: la chat diventa in sola lettura e potrai creare il modulo PDF"
          }
          className="ml-auto flex cursor-pointer select-none items-center gap-2 text-sm text-zinc-400"
        >
          <span>Campagna conclusa</span>
          <button
            type="button"
            role="switch"
            aria-checked={concluded}
            onClick={toggleConcluded}
            disabled={toggling}
            className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${
              concluded ? "bg-amber-600" : "bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                concluded ? "left-4.5" : "left-0.5"
              }`}
            />
          </button>
        </label>
        <button
          type="button"
          onClick={duplicateCampaign}
          disabled={duplicating}
          title="Crea una copia completa: messaggi, documenti, wiki e riassunti"
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-50"
        >
          {duplicating ? "Duplicazione…" : "Duplica campagna"}
        </button>
        <button
          type="button"
          onClick={deleteCampaign}
          className="rounded border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:border-red-700 hover:text-red-300"
        >
          Elimina campagna
        </button>
      </div>
      <p className="mt-1 text-zinc-400">{campaign.gameSystem}</p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </header>
  );
}
