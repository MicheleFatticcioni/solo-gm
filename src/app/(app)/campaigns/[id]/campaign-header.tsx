"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Intestazione con rinomina inline, duplicazione ed eliminazione della campagna.
export function CampaignHeader({
  campaign,
}: {
  campaign: { id: string; name: string; gameSystem: string };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          </>
        )}
        <button
          type="button"
          onClick={duplicateCampaign}
          disabled={duplicating}
          title="Crea una copia completa: messaggi, documenti, wiki e riassunti"
          className="ml-auto rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-50"
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
