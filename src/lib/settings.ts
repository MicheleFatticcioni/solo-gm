import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";

// Import relativi (niente alias @/): questo modulo è usato anche dal
// worker, che gira con tsx senza la risoluzione dei path di Next.
import { db } from "../db";
import { userSettings } from "../db/schema";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

export type EmbeddingsProvider = "voyage" | "ollama";

export type AiSettings = {
  anthropicApiKey: string | null;
  modelGm: string;
  modelSummary: string;
  modelImprove: string;
  embeddingsProvider: EmbeddingsProvider;
  voyageApiKey: string | null;
  ollamaHost: string | null;
  ollamaEmbedModel: string | null;
};

// Configurazione mancante che l'utente può risolvere da solo dalla
// pagina Impostazioni: il messaggio è pensato per essere mostrato in UI.
export class AiConfigError extends Error {}

// Impostazioni AI effettive: DB (pagina Impostazioni) → env (fallback
// per le installazioni esistenti) → default. userId opzionale: l'app è
// single-tenant, senza id si usa l'unica riga presente (worker).
export async function getAiSettings(userId?: string): Promise<AiSettings> {
  const row = userId
    ? await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, userId),
      })
    : (await db.select().from(userSettings).limit(1))[0];

  return {
    anthropicApiKey:
      row?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? null,
    modelGm:
      row?.modelGm ?? process.env.ANTHROPIC_MODEL_GM ?? DEFAULT_ANTHROPIC_MODEL,
    modelSummary:
      row?.modelSummary ??
      process.env.ANTHROPIC_MODEL_SUMMARY ??
      DEFAULT_ANTHROPIC_MODEL,
    modelImprove:
      row?.modelImprove ??
      process.env.ANTHROPIC_MODEL_IMPROVE ??
      DEFAULT_ANTHROPIC_MODEL,
    embeddingsProvider:
      row?.embeddingsProvider ??
      (process.env.EMBEDDINGS_PROVIDER as EmbeddingsProvider | undefined) ??
      "voyage",
    voyageApiKey: row?.voyageApiKey ?? process.env.VOYAGE_API_KEY ?? null,
    ollamaHost: row?.ollamaHost ?? process.env.OLLAMA_HOST ?? null,
    ollamaEmbedModel:
      row?.ollamaEmbedModel ?? process.env.OLLAMA_EMBED_MODEL ?? null,
  };
}

export function createAnthropicClient(settings: AiSettings): Anthropic {
  if (!settings.anthropicApiKey) {
    throw new AiConfigError(
      "Chiave API Anthropic non configurata: aggiungila nella pagina Impostazioni.",
    );
  }
  return new Anthropic({ apiKey: settings.anthropicApiKey });
}
