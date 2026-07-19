import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { messages } from "@/db/schema";
import { badRequest, forbidden, notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";
import { AiConfigError, getAiSettings } from "@/lib/settings";
import { markdownToSpeechText, synthesizeSpeech } from "@/lib/tts";

// GET /api/campaigns/[id]/messages/[messageId]/tts — legge ad alta voce
// un messaggio del GM con il provider TTS configurato nelle Impostazioni.
// Risponde con lo stream MP3; niente cache, l'audio si rigenera a ogni
// richiesta (le impostazioni voce possono cambiare).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const { id: rawId, messageId: rawMessageId } = await params;
  const id = parseId(rawId);
  const messageId = parseId(rawMessageId);
  if (!id || !messageId) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  // Campagna conclusa: la lettura vocale è disattivata (come i tasti in UI).
  if (campaign.concludedAt) {
    return forbidden("La campagna è conclusa: la lettura vocale è disattivata.");
  }

  const [message] = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.campaignId, id)))
    .limit(1);
  if (!message) return notFound();
  if (message.role !== "assistant") {
    return badRequest("Si possono leggere solo i messaggi del GM");
  }

  const settings = await getAiSettings(userId);
  if (settings.ttsMode === "off") {
    return badRequest(
      "Lettura vocale disattivata: abilitala nella pagina Impostazioni.",
    );
  }

  const text = markdownToSpeechText(message.content);
  if (!text) return badRequest("Il messaggio non contiene testo da leggere");

  try {
    const { contentType, stream } = await synthesizeSpeech(settings, text);
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("messages/tts: errore di sintesi vocale:", error);
    if (error instanceof AiConfigError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: "La lettura vocale non è riuscita, riprova tra poco." },
      { status: 502 },
    );
  }
}
