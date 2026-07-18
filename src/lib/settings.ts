import { eq } from "drizzle-orm";

// Import relativi (niente alias @/): questo modulo è usato anche dal
// worker, che gira con tsx senza la risoluzione dei path di Next.
import { db } from "../db";
import { userSettings } from "../db/schema";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
export const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
// George: voce multilingue predefinita di ElevenLabs, adatta alla narrazione.
export const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_OPENAI_TTS_VOICE = "onyx";

export type ChatProvider = "anthropic" | "ollama" | "deepseek";
export type EmbeddingsProvider = "voyage" | "ollama";
export type TtsProvider = "elevenlabs" | "openai";
export type TtsMode = "auto" | "on_demand" | "off";

export type AiSettings = {
  chatProvider: ChatProvider;
  anthropicApiKey: string | null;
  modelGm: string;
  modelSummary: string;
  modelImprove: string;
  deepseekApiKey: string | null;
  deepseekModelGm: string;
  deepseekModelSummary: string;
  deepseekModelImprove: string;
  embeddingsProvider: EmbeddingsProvider;
  voyageApiKey: string | null;
  ollamaHost: string | null;
  ollamaApiKey: string | null;
  ollamaChatModel: string | null;
  ollamaEmbedModel: string | null;
  ttsMode: TtsMode;
  ttsProvider: TtsProvider;
  elevenlabsApiKey: string | null;
  elevenlabsVoiceId: string;
  elevenlabsTtsModel: string;
  openaiApiKey: string | null;
  openaiTtsModel: string;
  openaiTtsVoice: string;
  openaiTtsInstructions: string | null;
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
    chatProvider:
      row?.chatProvider ??
      (process.env.CHAT_PROVIDER as ChatProvider | undefined) ??
      "anthropic",
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
    deepseekApiKey:
      row?.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? null,
    deepseekModelGm:
      row?.deepseekModelGm ??
      process.env.DEEPSEEK_MODEL_GM ??
      DEFAULT_DEEPSEEK_MODEL,
    deepseekModelSummary:
      row?.deepseekModelSummary ??
      process.env.DEEPSEEK_MODEL_SUMMARY ??
      DEFAULT_DEEPSEEK_MODEL,
    deepseekModelImprove:
      row?.deepseekModelImprove ??
      process.env.DEEPSEEK_MODEL_IMPROVE ??
      DEFAULT_DEEPSEEK_MODEL,
    embeddingsProvider:
      row?.embeddingsProvider ??
      (process.env.EMBEDDINGS_PROVIDER as EmbeddingsProvider | undefined) ??
      "voyage",
    voyageApiKey: row?.voyageApiKey ?? process.env.VOYAGE_API_KEY ?? null,
    ollamaHost: row?.ollamaHost ?? process.env.OLLAMA_HOST ?? null,
    ollamaApiKey: row?.ollamaApiKey ?? process.env.OLLAMA_API_KEY ?? null,
    ollamaChatModel:
      row?.ollamaChatModel ?? process.env.OLLAMA_CHAT_MODEL ?? null,
    ollamaEmbedModel:
      row?.ollamaEmbedModel ?? process.env.OLLAMA_EMBED_MODEL ?? null,
    ttsMode:
      row?.ttsMode ?? (process.env.TTS_MODE as TtsMode | undefined) ?? "off",
    ttsProvider:
      row?.ttsProvider ??
      (process.env.TTS_PROVIDER as TtsProvider | undefined) ??
      "elevenlabs",
    elevenlabsApiKey:
      row?.elevenlabsApiKey ?? process.env.ELEVENLABS_API_KEY ?? null,
    elevenlabsVoiceId:
      row?.elevenlabsVoiceId ??
      process.env.ELEVENLABS_VOICE_ID ??
      DEFAULT_ELEVENLABS_VOICE_ID,
    elevenlabsTtsModel:
      row?.elevenlabsTtsModel ??
      process.env.ELEVENLABS_TTS_MODEL ??
      DEFAULT_ELEVENLABS_TTS_MODEL,
    openaiApiKey: row?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? null,
    openaiTtsModel:
      row?.openaiTtsModel ??
      process.env.OPENAI_TTS_MODEL ??
      DEFAULT_OPENAI_TTS_MODEL,
    openaiTtsVoice:
      row?.openaiTtsVoice ??
      process.env.OPENAI_TTS_VOICE ??
      DEFAULT_OPENAI_TTS_VOICE,
    openaiTtsInstructions:
      row?.openaiTtsInstructions ?? process.env.OPENAI_TTS_INSTRUCTIONS ?? null,
  };
}

export type ChatTask = "gm" | "summary" | "improve";

// Modello effettivo per una funzione dell'app, secondo il provider chat:
// con Claude e DeepSeek ogni funzione ha il suo modello, con Ollama se
// ne usa uno solo.
export function chatModel(settings: AiSettings, task: ChatTask): string {
  if (settings.chatProvider === "ollama") {
    if (!settings.ollamaChatModel) {
      throw new AiConfigError(
        "Modello Ollama non configurato: indicalo nella pagina Impostazioni.",
      );
    }
    return settings.ollamaChatModel;
  }
  if (settings.chatProvider === "deepseek") {
    switch (task) {
      case "gm":
        return settings.deepseekModelGm;
      case "summary":
        return settings.deepseekModelSummary;
      case "improve":
        return settings.deepseekModelImprove;
    }
  }
  switch (task) {
    case "gm":
      return settings.modelGm;
    case "summary":
      return settings.modelSummary;
    case "improve":
      return settings.modelImprove;
  }
}
