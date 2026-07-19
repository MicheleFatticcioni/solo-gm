"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type WikiPageMeta = {
  slug: string;
  title: string;
  description: string;
  updatedAt: string;
};

type WikiFolderGroup = {
  folder: string;
  label: string;
  pages: WikiPageMeta[];
};

type WikiPage = WikiPageMeta & { folder: string; content: string };

type LegacySummary = { content: string; createdAt: string };

// Quanto a lungo il polling attende dopo "Aggiorna ora": il job può
// legittimamente non produrre nulla (guardia sui messaggi minimi).
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 40;

const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "medium",
  timeStyle: "short",
});

// Impronta dell'albero per capire dal polling se il job ha scritto.
function fingerprint(folders: WikiFolderGroup[]): string {
  return folders
    .flatMap((f) => f.pages.map((p) => `${f.folder}/${p.slug}@${p.updatedAt}`))
    .join("|");
}

const emptyDraft = {
  folder: "npc",
  slug: "",
  title: "",
  description: "",
  content: "",
};

// Sezione "Memoria della campagna (wiki)": nucleo + pagine per cartella,
// consultabili e modificabili; "Aggiorna ora" accoda il job update-wiki.
export function CampaignWiki({
  campaignId,
  initialFolders,
  legacySummary,
}: {
  campaignId: string;
  initialFolders: WikiFolderGroup[];
  legacySummary: LegacySummary | null;
}) {
  const [folders, setFolders] = useState<WikiFolderGroup[]>(initialFolders);
  const [selected, setSelected] = useState<WikiPage | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
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

  const pageCount = folders.reduce((sum, f) => sum + f.pages.length, 0);

  async function fetchTree(): Promise<WikiFolderGroup[]> {
    const res = await fetch(`/api/campaigns/${campaignId}/wiki`);
    if (!res.ok) throw new Error();
    const body: { folders: WikiFolderGroup[] } = await res.json();
    return body.folders;
  }

  async function openPage(folder: string, slug: string) {
    setLoadingPage(true);
    setEditing(false);
    setCreating(false);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/wiki/${folder}/${slug}`,
      );
      if (!res.ok) throw new Error();
      setSelected(await res.json());
    } catch {
      setError("Errore nel caricamento della pagina.");
    } finally {
      setLoadingPage(false);
    }
  }

  async function savePage() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/wiki/${selected.folder}/${selected.slug}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: draft.title,
            description: draft.description,
            content: draft.content,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Errore durante il salvataggio");
      }
      setSelected(await res.json());
      setEditing(false);
      setFolders(await fetchTree());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Errore durante il salvataggio");
    } finally {
      setSaving(false);
    }
  }

  async function createPage() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/wiki`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Errore durante la creazione");
      }
      const saved: WikiPage = await res.json();
      setSelected(saved);
      setCreating(false);
      setFolders(await fetchTree());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Errore durante la creazione");
    } finally {
      setSaving(false);
    }
  }

  async function deletePage() {
    if (!selected) return;
    if (!window.confirm(`Eliminare la pagina "${selected.title}"?`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/wiki/${selected.folder}/${selected.slug}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error();
      setSelected(null);
      setFolders(await fetchTree());
    } catch {
      setError("Errore durante l'eliminazione della pagina.");
    } finally {
      setSaving(false);
    }
  }

  // POST regenerate, poi polling del GET finché l'albero cambia (o si
  // esaurisce il budget di tentativi).
  async function regenerate() {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    const baseline = fingerprint(folders);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/wiki/regenerate`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();

      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;
        const latest = await fetchTree();
        if (fingerprint(latest) !== baseline) {
          setFolders(latest);
          setNotice("Wiki aggiornata.");
          return;
        }
      }
      setNotice(
        "Nessun aggiornamento per ora: serve abbastanza storia nuova non ancora coperta.",
      );
    } catch {
      if (!cancelledRef.current)
        setError("Errore durante l'aggiornamento della wiki.");
    } finally {
      if (!cancelledRef.current) setRefreshing(false);
    }
  }

  const inputClass =
    "w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm outline-none focus:border-indigo-500";

  const form = (
    <div className="space-y-2">
      {creating && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm text-zinc-400">
            Cartella
            <select
              value={draft.folder}
              onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
              className={inputClass}
            >
              {folders
                .filter((f) => f.folder !== "core")
                .map((f) => (
                  <option key={f.folder} value={f.folder}>
                    {f.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm text-zinc-400">
            Slug (kebab-case)
            <input
              value={draft.slug}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              placeholder="lord-anor"
              className={inputClass}
            />
          </label>
        </div>
      )}
      <label className="block text-sm text-zinc-400">
        Titolo
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          className={inputClass}
        />
      </label>
      <label className="block text-sm text-zinc-400">
        Descrizione (una riga, usata nell&apos;indice del GM)
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className={inputClass}
        />
      </label>
      <textarea
        value={draft.content}
        onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        rows={14}
        className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 p-3 font-mono text-sm outline-none focus:border-indigo-500"
      />
      <p className="text-sm text-zinc-500">
        La wiki è la memoria a lungo termine del GM: correggi qui gli errori
        di trama e verranno rispettati nei turni successivi. Collega le pagine
        con [[cartella/slug]].
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={creating ? createPage : savePage}
          disabled={
            saving ||
            !draft.title.trim() ||
            !draft.description.trim() ||
            !draft.content.trim() ||
            (creating && !draft.slug.trim())
          }
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Salvataggio…" : "Salva"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setCreating(false);
          }}
          disabled={saving}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
        >
          Annulla
        </button>
      </div>
    </div>
  );

  return (
    <section id="memoria">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-medium">Memoria della campagna (wiki)</h2>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(emptyDraft);
              setCreating(true);
              setEditing(false);
              setSelected(null);
              setNotice(null);
              setError(null);
            }}
            disabled={refreshing}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-50"
          >
            Nuova pagina
          </button>
          <button
            type="button"
            onClick={regenerate}
            disabled={refreshing || editing || creating}
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
          {pageCount > 0 && (
            <a
              href={`/api/campaigns/${campaignId}/wiki/export`}
              title="Scarica la wiki come zip: un file markdown per pagina, nelle rispettive cartelle"
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
            >
              Esporta wiki
            </a>
          )}
        </div>
      </div>

      {pageCount === 0 && !creating ? (
        legacySummary ? (
          <div className="rounded border border-zinc-800 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="rounded-full border border-amber-800/60 bg-amber-950/40 px-2 py-0.5 text-amber-200">
                riassunto legacy, ancora usato come contesto
              </span>
              <span>
                Aggiornato il {dateFormatter.format(new Date(legacySummary.createdAt))}
              </span>
            </div>
            <p className="mb-3 text-sm text-zinc-500">
              La wiki non ha ancora pagine: finché resta vuota, il GM usa
              questo riassunto come memoria a lungo termine. Verrà sostituito
              automaticamente non appena la wiki si popola.
            </p>
            <div className="space-y-2 text-sm leading-relaxed text-zinc-300 [&_h2]:mt-4 [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h2:first-child]:mt-0 [&_li]:ml-1 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
              <ReactMarkdown>{legacySummary.content}</ReactMarkdown>
            </div>
          </div>
        ) : (
          <p className="rounded border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
            La wiki verrà popolata automaticamente man mano che giochi.
          </p>
        )
      ) : (
        <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
          <nav className="space-y-3 md:max-h-[32rem] md:overflow-y-auto">
            {folders
              .filter((f) => f.pages.length > 0)
              .map((f) => (
                <div key={f.folder}>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {f.label} ({f.pages.length})
                  </h3>
                  <ul className="space-y-0.5">
                    {f.pages.map((p) => {
                      const isActive =
                        selected?.folder === f.folder && selected.slug === p.slug;
                      return (
                        <li key={p.slug}>
                          <button
                            type="button"
                            onClick={() => openPage(f.folder, p.slug)}
                            title={p.description}
                            className={`w-full truncate rounded px-2 py-1 text-left text-sm ${
                              isActive
                                ? "bg-indigo-950/60 text-indigo-200"
                                : "text-zinc-300 hover:bg-zinc-900"
                            }`}
                          >
                            {p.title}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
          </nav>

          <div className="min-w-0 rounded border border-zinc-800 p-4">
            {creating ? (
              form
            ) : loadingPage ? (
              <p className="text-sm text-zinc-500">Caricamento…</p>
            ) : !selected ? (
              <p className="text-sm text-zinc-500">
                Seleziona una pagina per leggerla o modificarla.
              </p>
            ) : editing ? (
              form
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold">{selected.title}</h3>
                    <p className="text-xs text-zinc-500">
                      {selected.folder}/{selected.slug} — {selected.description}
                      {" — aggiornata il "}
                      {dateFormatter.format(new Date(selected.updatedAt))}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft({
                        folder: selected.folder,
                        slug: selected.slug,
                        title: selected.title,
                        description: selected.description,
                        content: selected.content,
                      });
                      setEditing(true);
                      setNotice(null);
                      setError(null);
                    }}
                    className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500"
                  >
                    Modifica
                  </button>
                  <button
                    type="button"
                    onClick={deletePage}
                    disabled={saving}
                    className="rounded border border-red-900/60 px-3 py-1.5 text-sm text-red-300 hover:border-red-700 disabled:opacity-50"
                  >
                    Elimina
                  </button>
                </div>
                <div className="space-y-2 text-sm leading-relaxed text-zinc-300 [&_h2]:mt-4 [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h2:first-child]:mt-0 [&_h3]:mt-3 [&_h3]:font-medium [&_h3]:text-zinc-100 [&_li]:ml-1 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                  <ReactMarkdown>{selected.content}</ReactMarkdown>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {notice && <p className="mt-2 text-sm text-zinc-400">{notice}</p>}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
