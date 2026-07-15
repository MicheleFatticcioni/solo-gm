"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export type KeyStatus = {
  // "db" = salvata dall'interfaccia, "env" = variabile d'ambiente (fallback)
  source: "db" | "env" | null;
  hint: string | null;
};

type Overridable = { value: string | null; fallback: string | null };

const inputClass =
  "rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-500";

const ANTHROPIC_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
];

const DEEPSEEK_MODELS = ["deepseek-chat", "deepseek-reasoner"];

const OLLAMA_EMBED_MODELS = ["bge-m3", "mxbai-embed-large"];

const OLLAMA_CHAT_MODELS = [
  "llama3.3",
  "qwen3",
  "gpt-oss:20b",
  "gpt-oss:120b-cloud",
  "deepseek-v3.1:671b-cloud",
];

function keyStatusLabel(status: KeyStatus): string {
  if (!status.source) return "Non configurata";
  const origin =
    status.source === "db" ? "dall'interfaccia" : "da variabile d'ambiente";
  return `Configurata ${origin} (${status.hint})`;
}

// Campo per una chiave segreta: non mostra mai il valore salvato, solo
// provenienza e ultimi caratteri. Vuoto = lascia invariata; la spunta
// "rimuovi" azzera quella salvata (tornando all'eventuale env).
function ApiKeyField({
  label,
  name,
  status,
  placeholder,
}: {
  label: string;
  name: string;
  status: KeyStatus;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm text-zinc-300">
      <span>
        {label}{" "}
        <span
          className={status.source ? "text-emerald-400" : "text-amber-400"}
        >
          — {keyStatusLabel(status)}
        </span>
      </span>
      <input
        name={name}
        type="password"
        placeholder={status.source ? `${placeholder} (lascia vuoto per non cambiare)` : placeholder}
        autoComplete="off"
        className={inputClass}
      />
      {status.source === "db" && (
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          <input type="checkbox" name={`${name}Remove`} className="accent-zinc-400" />
          Rimuovi la chiave salvata
        </label>
      )}
    </div>
  );
}

// Switch stile toggle (accessibile via role="switch") al posto della
// checkbox nativa: più leggibile per un'opzione binaria on/off.
function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-emerald-600" : "bg-zinc-700"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

// Le sezioni per-provider restano montate (mai smontate via JSX
// condizionale): se sparissero dal DOM, i loro campi non arriverebbero
// nella FormData al submit e verrebbero salvati come null, cancellando
// le impostazioni del provider non selezionato. Si nascondono solo
// visivamente con "hidden", che le esclude anche da tab-order e
// screen reader ma le lascia nella form.
function sectionClass(visible: boolean): string {
  return `flex flex-col gap-4 border-t border-zinc-800 pt-4 ${visible ? "" : "hidden"}`;
}

function ModelField({
  label,
  description,
  name,
  model,
  listId,
}: {
  label: string;
  description: string;
  name: string;
  model: Overridable;
  listId: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-zinc-300">
      {label}
      <input
        name={name}
        type="text"
        defaultValue={model.value ?? ""}
        placeholder={model.fallback ? `Predefinito: ${model.fallback}` : undefined}
        list={listId}
        className={inputClass}
      />
      <span className="text-xs text-zinc-500">{description}</span>
    </label>
  );
}

export function AiSettingsForm({
  chatProvider,
  anthropicKey,
  voyageKey,
  models,
  deepseekKey,
  deepseekModels,
  embeddingsProvider,
  ollamaHost,
  ollamaApiKey,
  ollamaChatModel,
  ollamaEmbedModel,
  expertMode,
}: {
  chatProvider: Overridable;
  anthropicKey: KeyStatus;
  voyageKey: KeyStatus;
  models: { gm: Overridable; summary: Overridable; improve: Overridable };
  deepseekKey: KeyStatus;
  deepseekModels: {
    gm: Overridable;
    summary: Overridable;
    improve: Overridable;
  };
  embeddingsProvider: Overridable;
  ollamaHost: Overridable;
  ollamaApiKey: KeyStatus;
  ollamaChatModel: Overridable;
  ollamaEmbedModel: Overridable;
  expertMode: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expert, setExpert] = useState(expertMode);
  const [chatProviderValue, setChatProviderValue] = useState(
    chatProvider.value ?? "",
  );
  const [embedProviderValue, setEmbedProviderValue] = useState(
    embeddingsProvider.value ?? "",
  );

  const effectiveChatProvider =
    chatProviderValue || chatProvider.fallback || "anthropic";
  const effectiveEmbedProvider =
    embedProviderValue || embeddingsProvider.fallback || "voyage";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setLoading(true);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const text = (name: string) => (formData.get(name) as string | null)?.trim() ?? "";

    // Chiavi: si inviano solo se cambiate (o da rimuovere), mai il
    // valore salvato che il client non conosce.
    const secret = (name: string) => {
      const value = text(name);
      if (value) return value;
      return formData.get(`${name}Remove`) === "on" ? null : undefined;
    };

    const body = {
      chatProvider: text("chatProvider") || null,
      anthropicApiKey: secret("anthropicApiKey"),
      voyageApiKey: secret("voyageApiKey"),
      modelGm: text("modelGm") || null,
      modelSummary: text("modelSummary") || null,
      modelImprove: text("modelImprove") || null,
      deepseekApiKey: secret("deepseekApiKey"),
      deepseekModelGm: text("deepseekModelGm") || null,
      deepseekModelSummary: text("deepseekModelSummary") || null,
      deepseekModelImprove: text("deepseekModelImprove") || null,
      embeddingsProvider: text("embeddingsProvider") || null,
      ollamaHost: text("ollamaHost") || null,
      ollamaApiKey: secret("ollamaApiKey"),
      ollamaChatModel: text("ollamaChatModel") || null,
      ollamaEmbedModel: text("ollamaEmbedModel") || null,
      expertMode: expert,
    };

    const res = await fetch("/api/settings/ai", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setLoading(false);
    if (!res.ok) {
      const responseBody = await res.json().catch(() => null);
      setError(responseBody?.error ?? "Errore nel salvataggio delle impostazioni");
      return;
    }

    // Pulisce solo i campi segreti: la provenienza aggiornata arriva
    // dal refresh, gli altri campi mostrano già ciò che è stato salvato.
    for (const input of form.querySelectorAll<HTMLInputElement>(
      'input[type="password"], input[type="checkbox"]',
    )) {
      if (input.type === "password") input.value = "";
      else input.checked = false;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-6 rounded-lg border border-zinc-800 bg-zinc-900 p-6"
    >
      <datalist id="anthropic-models">
        {ANTHROPIC_MODELS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <datalist id="deepseek-models">
        {DEEPSEEK_MODELS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <datalist id="ollama-embed-models">
        {OLLAMA_EMBED_MODELS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <datalist id="ollama-chat-models">
        {OLLAMA_CHAT_MODELS.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <div className="flex items-start justify-between gap-4 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-sm text-zinc-300">
        <span className="flex flex-col">
          Solo utenti esperti
          <span className="text-xs text-zinc-500">
            Mostra le opzioni avanzate per usare Ollama (modelli locali o cloud)
            al posto di Claude o DeepSeek. Lascia disattivato se usi solo
            Claude o DeepSeek.
          </span>
        </span>
        <Switch checked={expert} onChange={setExpert} />
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 font-medium text-zinc-100">Provider AI</legend>
        <label className="flex flex-col gap-1 text-sm text-zinc-300">
          Provider per partita, riassunti e migliora istruzioni
          <select
            name="chatProvider"
            value={chatProviderValue}
            onChange={(event) => setChatProviderValue(event.target.value)}
            className={inputClass}
          >
            <option value="">
              Predefinito (
              {chatProvider.fallback === "ollama"
                ? "Ollama"
                : chatProvider.fallback === "deepseek"
                  ? "DeepSeek"
                  : "Claude"}
              )
            </option>
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="deepseek">DeepSeek</option>
            {expert && (
              <option value="ollama">Ollama (locale o cloud)</option>
            )}
          </select>
          <span className="text-xs text-zinc-500">
            Si usa un solo provider alla volta: chiave e modelli della sezione
            corrispondente qui sotto. Le impostazioni degli altri provider
            restano salvate.
          </span>
        </label>
      </fieldset>

      <fieldset className={sectionClass(effectiveChatProvider === "anthropic")}>
        <legend className="sr-only">Claude (Anthropic)</legend>
        <span className="font-medium text-zinc-100">Claude (Anthropic)</span>
        <ApiKeyField
          label="Chiave API Anthropic"
          name="anthropicApiKey"
          status={anthropicKey}
          placeholder="sk-ant-…"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ModelField
            label="Modello partita (GM)"
            description="Conduce la campagna durante il gioco."
            name="modelGm"
            model={models.gm}
            listId="anthropic-models"
          />
          <ModelField
            label="Modello riassunto"
            description="Aggiorna il riassunto progressivo della campagna."
            name="modelSummary"
            model={models.summary}
            listId="anthropic-models"
          />
          <ModelField
            label="Modello migliora istruzioni"
            description="Riscrive le istruzioni per l'AI della campagna."
            name="modelImprove"
            model={models.improve}
            listId="anthropic-models"
          />
        </div>
        <p className="text-xs text-zinc-500">
          Lascia vuoto un modello per usare il predefinito. Puoi anche digitare
          un identificatore non in elenco.
        </p>
      </fieldset>

      <fieldset className={sectionClass(effectiveChatProvider === "deepseek")}>
        <legend className="sr-only">DeepSeek</legend>
        <span className="font-medium text-zinc-100">DeepSeek</span>
        <ApiKeyField
          label="Chiave API DeepSeek"
          name="deepseekApiKey"
          status={deepseekKey}
          placeholder="sk-…"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ModelField
            label="Modello partita (GM)"
            description="Conduce la campagna durante il gioco."
            name="deepseekModelGm"
            model={deepseekModels.gm}
            listId="deepseek-models"
          />
          <ModelField
            label="Modello riassunto"
            description="Aggiorna il riassunto progressivo della campagna."
            name="deepseekModelSummary"
            model={deepseekModels.summary}
            listId="deepseek-models"
          />
          <ModelField
            label="Modello migliora istruzioni"
            description="Riscrive le istruzioni per l'AI della campagna."
            name="deepseekModelImprove"
            model={deepseekModels.improve}
            listId="deepseek-models"
          />
        </div>
        <p className="text-xs text-zinc-500">
          Lascia vuoto un modello per usare il predefinito. Puoi anche digitare
          un identificatore non in elenco.
        </p>
      </fieldset>

      <fieldset
        className={sectionClass(
          expert &&
            (effectiveChatProvider === "ollama" ||
              effectiveEmbedProvider === "ollama"),
        )}
      >
        <legend className="sr-only">Ollama</legend>
        <span className="font-medium text-zinc-100">Ollama</span>
        <p className="text-xs text-zinc-500">
          Usato per la chat quando è il provider selezionato e per gli
          embeddings locali. Per i modelli locali basta l&apos;host; per Ollama
          cloud usa un modello con suffisso <code>-cloud</code> (host locale
          con account collegato) oppure host{" "}
          <code>https://ollama.com</code> con chiave API.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-zinc-300">
            Host Ollama
            <input
              name="ollamaHost"
              type="text"
              defaultValue={ollamaHost.value ?? ""}
              placeholder={
                ollamaHost.fallback
                  ? `Predefinito: ${ollamaHost.fallback}`
                  : "http://localhost:11434"
              }
              className={inputClass}
            />
          </label>
          <ModelField
            label="Modello chat"
            description="Usato per partita, riassunti e migliora istruzioni quando il provider è Ollama."
            name="ollamaChatModel"
            model={ollamaChatModel}
            listId="ollama-chat-models"
          />
        </div>
        <ApiKeyField
          label="Chiave API Ollama (solo cloud)"
          name="ollamaApiKey"
          status={ollamaApiKey}
          placeholder="chiave da ollama.com"
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-zinc-800 pt-4">
        <legend className="sr-only">Embeddings</legend>
        <span className="font-medium text-zinc-100">
          Embeddings (indicizzazione documenti)
        </span>
        <p className="rounded border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
          ⚠️ Cambiare provider o modello di embeddings richiede di reindicizzare
          tutti i documenti già caricati: gli embeddings di provider diversi non
          sono confrontabili tra loro.
        </p>
        <label className="flex flex-col gap-1 text-sm text-zinc-300">
          Provider
          <select
            name="embeddingsProvider"
            value={embedProviderValue}
            onChange={(event) => setEmbedProviderValue(event.target.value)}
            className={inputClass}
          >
            <option value="">Predefinito ({embeddingsProvider.fallback})</option>
            <option value="voyage">Voyage AI</option>
            {expert && <option value="ollama">Ollama (locale)</option>}
          </select>
        </label>
        <div className={effectiveEmbedProvider === "voyage" ? "" : "hidden"}>
          <ApiKeyField
            label="Chiave API Voyage"
            name="voyageApiKey"
            status={voyageKey}
            placeholder="pa-…"
          />
        </div>
        <label
          className={`flex flex-col gap-1 text-sm text-zinc-300 ${
            expert && effectiveEmbedProvider === "ollama" ? "" : "hidden"
          }`}
        >
          Modello embeddings Ollama
          <input
            name="ollamaEmbedModel"
            type="text"
            defaultValue={ollamaEmbedModel.value ?? ""}
            placeholder={
              ollamaEmbedModel.fallback
                ? `Predefinito: ${ollamaEmbedModel.fallback}`
                : "es. bge-m3 (1024 dimensioni)"
            }
            list="ollama-embed-models"
            className={inputClass}
          />
        </label>
      </fieldset>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {saved && (
        <p className="text-sm text-emerald-400">Impostazioni AI aggiornate.</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="self-start rounded bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
      >
        {loading ? "Salvataggio…" : "Salva impostazioni AI"}
      </button>
    </form>
  );
}
