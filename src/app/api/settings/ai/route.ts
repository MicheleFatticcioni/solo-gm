import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { badRequest, unauthorized } from "@/lib/api";
import { getUserId } from "@/lib/session";

// Semantica dei campi: stringa = imposta, null = azzera (torna al
// fallback env/default), assente = lascia invariato. Le chiavi API
// arrivano solo quando l'utente le cambia: il form non le rimanda mai
// indietro così come sono.
const aiSchema = z
  .object({
    chatProvider: z
      .enum(["anthropic", "ollama", "deepseek"])
      .nullable()
      .optional(),
    anthropicApiKey: z.string().trim().min(1).nullable().optional(),
    modelGm: z.string().trim().min(1).nullable().optional(),
    modelSummary: z.string().trim().min(1).nullable().optional(),
    modelImprove: z.string().trim().min(1).nullable().optional(),
    deepseekApiKey: z.string().trim().min(1).nullable().optional(),
    deepseekModelGm: z.string().trim().min(1).nullable().optional(),
    deepseekModelSummary: z.string().trim().min(1).nullable().optional(),
    deepseekModelImprove: z.string().trim().min(1).nullable().optional(),
    embeddingsProvider: z.enum(["voyage", "ollama"]).nullable().optional(),
    voyageApiKey: z.string().trim().min(1).nullable().optional(),
    ollamaHost: z.url("Host Ollama non valido").nullable().optional(),
    ollamaApiKey: z.string().trim().min(1).nullable().optional(),
    ollamaChatModel: z.string().trim().min(1).nullable().optional(),
    ollamaEmbedModel: z.string().trim().min(1).nullable().optional(),
    expertMode: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "Nessun campo da aggiornare",
  });

// PATCH /api/settings/ai — chiavi API e modelli dei servizi AI.
export async function PATCH(request: Request) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const parsed = aiSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Dati non validi");
  }

  // Solo i campi effettivamente inviati: gli undefined non devono
  // sovrascrivere i valori già salvati.
  const changes = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  );

  await db
    .insert(userSettings)
    .values({ userId, ...changes })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...changes, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
