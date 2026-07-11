"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

const inputClass =
  "rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500";

export function ProfileForm({
  firstName,
  lastName,
  email,
}: {
  firstName: string;
  lastName: string;
  email: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const res = await fetch("/api/settings/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: formData.get("firstName"),
        lastName: formData.get("lastName"),
        email: formData.get("email"),
      }),
    });

    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Errore nel salvataggio del profilo");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6"
    >
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm text-zinc-300">
          Nome
          <input
            name="firstName"
            type="text"
            required
            defaultValue={firstName}
            autoComplete="given-name"
            className={inputClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-zinc-300">
          Cognome
          <input
            name="lastName"
            type="text"
            required
            defaultValue={lastName}
            autoComplete="family-name"
            className={inputClass}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm text-zinc-300">
        Email
        <input
          name="email"
          type="email"
          required
          defaultValue={email}
          autoComplete="email"
          className={inputClass}
        />
        <span className="text-xs text-zinc-500">
          L&apos;email serve per l&apos;accesso: se la cambi, al prossimo login
          dovrai usare quella nuova.
        </span>
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {saved && <p className="text-sm text-emerald-400">Profilo aggiornato.</p>}
      <button
        type="submit"
        disabled={loading}
        className="self-start rounded bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
      >
        {loading ? "Salvataggio…" : "Salva profilo"}
      </button>
    </form>
  );
}
