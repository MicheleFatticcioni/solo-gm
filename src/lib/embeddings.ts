import { Ollama } from "ollama";

import { AiConfigError, getAiSettings, type AiSettings } from "./settings";

// Voyage accetta al massimo 128 testi per richiesta.
const VOYAGE_BATCH_SIZE = 128;
const VOYAGE_MODEL = "voyage-3.5";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_ATTEMPTS = 5;

export type EmbedInputType = "document" | "query";

// Astrazione sul provider di embeddings (pagina Impostazioni, con
// fallback sugli env). ⚠️ Cambiare provider (o modello) richiede di
// reindicizzare tutti i documenti: gli embeddings di provider diversi
// non sono confrontabili e la colonna vector(1024) vincola la dimensione.
export async function embed(
  texts: string[],
  inputType: EmbedInputType,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const settings = await getAiSettings();
  switch (settings.embeddingsProvider) {
    case "voyage":
      return embedVoyage(texts, inputType, settings);
    case "ollama":
      return embedOllama(texts, settings);
    default:
      throw new AiConfigError(
        `Provider embeddings non valido: ${settings.embeddingsProvider}`,
      );
  }
}

async function embedVoyage(
  texts: string[],
  inputType: EmbedInputType,
  settings: AiSettings,
): Promise<number[][]> {
  const apiKey = settings.voyageApiKey;
  if (!apiKey) {
    throw new AiConfigError(
      "Chiave API Voyage non configurata: aggiungila nella pagina Impostazioni.",
    );
  }

  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
    const batch = texts.slice(i, i + VOYAGE_BATCH_SIZE);
    const response = await fetchWithRetry(VOYAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: batch,
        input_type: inputType,
      }),
    });

    const body = (await response.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    embeddings.push(
      ...body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
    );
  }
  return embeddings;
}

async function embedOllama(
  texts: string[],
  settings: AiSettings,
): Promise<number[][]> {
  const model = settings.ollamaEmbedModel;
  if (!model) {
    throw new AiConfigError(
      "Modello embeddings Ollama non configurato: sceglilo nella pagina Impostazioni.",
    );
  }

  const ollama = new Ollama(
    settings.ollamaHost ? { host: settings.ollamaHost } : undefined,
  );
  const response = await ollama.embed({ model, input: texts });
  return response.embeddings;
}

// Retry con backoff esponenziale su 429/5xx ed errori di rete,
// rispettando l'eventuale header retry-after.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs(attempt, lastError));
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // errore di rete: ritenta
      lastError = error;
      continue;
    }

    if (response.ok) return response;
    if (response.status === 429 || response.status >= 500) {
      lastError = new RetryableHttpError(response);
      continue;
    }
    throw new Error(
      `Voyage API ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Voyage API: tentativi esauriti");
}

class RetryableHttpError extends Error {
  readonly retryAfterMs: number | null;

  constructor(response: Response) {
    super(`Voyage API ${response.status}`);
    this.retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function backoffMs(attempt: number, lastError: unknown): number {
  if (lastError instanceof RetryableHttpError && lastError.retryAfterMs !== null) {
    return lastError.retryAfterMs;
  }
  return 1000 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
