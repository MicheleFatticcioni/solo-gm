import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users, userSettings } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { DEFAULT_ANTHROPIC_MODEL } from "@/lib/settings";

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
          embeddingsProvider={{
            value: row?.embeddingsProvider ?? null,
            fallback: process.env.EMBEDDINGS_PROVIDER ?? "voyage",
          }}
          ollamaHost={{
            value: row?.ollamaHost ?? null,
            fallback: process.env.OLLAMA_HOST ?? null,
          }}
          ollamaEmbedModel={{
            value: row?.ollamaEmbedModel ?? null,
            fallback: process.env.OLLAMA_EMBED_MODEL ?? null,
          }}
        />
      </section>
    </div>
  );
}
