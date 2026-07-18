import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users, userSettings } from "@/db/schema";
import { getUserId } from "@/lib/session";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_ELEVENLABS_TTS_MODEL,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENAI_TTS_VOICE,
} from "@/lib/settings";

import { AiSettingsForm, type KeyStatus } from "./ai-settings-form";
import { PasswordForm } from "./password-form";
import { ProfileForm } from "./profile-form";

// Le chiavi API non escono mai intere dal server: al client arrivano
// solo la provenienza (interfaccia o env) e gli ultimi 4 caratteri.
function keyStatus(
  dbValue: string | null | undefined,
  envValue: string | undefined,
): KeyStatus {
  const effective = dbValue ?? envValue ?? null;
  if (!effective) return { source: null, hint: null };
  return { source: dbValue ? "db" : "env", hint: `…${effective.slice(-4)}` };
}

export default async function ImpostazioniPage() {
  const userId = await getUserId();
  if (!userId) return null; // il proxy protegge già la route

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;

  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  const modelFallback = (env: string | undefined) => env ?? DEFAULT_ANTHROPIC_MODEL;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Impostazioni</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Profilo</h2>
        <ProfileForm
          firstName={user.firstName}
          lastName={user.lastName}
          email={user.email}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Password</h2>
        <PasswordForm />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Servizi AI</h2>
        <p className="text-sm text-zinc-400">
          Le chiavi e i modelli salvati qui hanno la precedenza sulle variabili
          d&apos;ambiente, che restano solo come fallback.
        </p>
        <AiSettingsForm
          chatProvider={{
            value: row?.chatProvider ?? null,
            fallback: process.env.CHAT_PROVIDER ?? "anthropic",
          }}
          anthropicKey={keyStatus(row?.anthropicApiKey, process.env.ANTHROPIC_API_KEY)}
          voyageKey={keyStatus(row?.voyageApiKey, process.env.VOYAGE_API_KEY)}
          models={{
            gm: {
              value: row?.modelGm ?? null,
              fallback: modelFallback(process.env.ANTHROPIC_MODEL_GM),
            },
            summary: {
              value: row?.modelSummary ?? null,
              fallback: modelFallback(process.env.ANTHROPIC_MODEL_SUMMARY),
            },
            improve: {
              value: row?.modelImprove ?? null,
              fallback: modelFallback(process.env.ANTHROPIC_MODEL_IMPROVE),
            },
          }}
          deepseekKey={keyStatus(row?.deepseekApiKey, process.env.DEEPSEEK_API_KEY)}
          deepseekModels={{
            gm: {
              value: row?.deepseekModelGm ?? null,
              fallback: process.env.DEEPSEEK_MODEL_GM ?? DEFAULT_DEEPSEEK_MODEL,
            },
            summary: {
              value: row?.deepseekModelSummary ?? null,
              fallback:
                process.env.DEEPSEEK_MODEL_SUMMARY ?? DEFAULT_DEEPSEEK_MODEL,
            },
            improve: {
              value: row?.deepseekModelImprove ?? null,
              fallback:
                process.env.DEEPSEEK_MODEL_IMPROVE ?? DEFAULT_DEEPSEEK_MODEL,
            },
          }}
          embeddingsProvider={{
            value: row?.embeddingsProvider ?? null,
            fallback: process.env.EMBEDDINGS_PROVIDER ?? "voyage",
          }}
          ollamaHost={{
            value: row?.ollamaHost ?? null,
            fallback: process.env.OLLAMA_HOST ?? null,
          }}
          ollamaApiKey={keyStatus(row?.ollamaApiKey, process.env.OLLAMA_API_KEY)}
          ollamaChatModel={{
            value: row?.ollamaChatModel ?? null,
            fallback: process.env.OLLAMA_CHAT_MODEL ?? null,
          }}
          ollamaEmbedModel={{
            value: row?.ollamaEmbedModel ?? null,
            fallback: process.env.OLLAMA_EMBED_MODEL ?? null,
          }}
          ttsMode={{
            value: row?.ttsMode ?? null,
            fallback: process.env.TTS_MODE ?? "off",
          }}
          ttsProvider={{
            value: row?.ttsProvider ?? null,
            fallback: process.env.TTS_PROVIDER ?? "elevenlabs",
          }}
          elevenlabsKey={keyStatus(
            row?.elevenlabsApiKey,
            process.env.ELEVENLABS_API_KEY,
          )}
          elevenlabsVoiceId={{
            value: row?.elevenlabsVoiceId ?? null,
            fallback:
              process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE_ID,
          }}
          elevenlabsTtsModel={{
            value: row?.elevenlabsTtsModel ?? null,
            fallback:
              process.env.ELEVENLABS_TTS_MODEL ?? DEFAULT_ELEVENLABS_TTS_MODEL,
          }}
          openaiKey={keyStatus(row?.openaiApiKey, process.env.OPENAI_API_KEY)}
          openaiTtsModel={{
            value: row?.openaiTtsModel ?? null,
            fallback: process.env.OPENAI_TTS_MODEL ?? DEFAULT_OPENAI_TTS_MODEL,
          }}
          openaiTtsVoice={{
            value: row?.openaiTtsVoice ?? null,
            fallback: process.env.OPENAI_TTS_VOICE ?? DEFAULT_OPENAI_TTS_VOICE,
          }}
          openaiTtsInstructions={{
            value: row?.openaiTtsInstructions ?? null,
            fallback: process.env.OPENAI_TTS_INSTRUCTIONS ?? null,
          }}
          expertMode={row?.expertMode ?? false}
        />
      </section>
    </div>
  );
}
