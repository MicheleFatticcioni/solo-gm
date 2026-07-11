import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { z } from "zod";

import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";

const bodySchema = z.object({ text: z.string().trim().min(1) });

const IMPROVE_MODEL = process.env.ANTHROPIC_MODEL_IMPROVE ?? "claude-opus-4-8";

const client = new Anthropic();

// Riscrittura conservativa: ottimizza le istruzioni che il giocatore dà al
// GM, senza cambiarne l'intento. Non è una chat né un turno di gioco.
const IMPROVE_SYSTEM = `Sei un esperto di prompt engineering. Il tuo compito è riscrivere le istruzioni che un giocatore fornisce a un'AI Game Master per una campagna di gioco di ruolo in solitaria, rendendole il più efficaci possibile per l'AI.

## Cosa fare
- Riscrivi il testo in modo chiaro, diretto e non ambiguo, come istruzioni rivolte a un'AI.
- Formatta in markdown: usa titoli (##, ###), elenchi puntati e **grassetto** per dare struttura e gerarchia.
- Raggruppa le indicazioni per tema, elimina ripetizioni e frasi ridondanti.
- Rendi ogni indicazione azionabile: preferisci direttive concrete a intenzioni vaghe.

## Vincoli (fondamentali)
- CONSERVATIVO: non aggiungere regole, vincoli, toni o contenuti che il giocatore non ha espresso o chiaramente implicato. Non inventare nulla.
- Non rimuovere alcuna indicazione dell'utente: puoi riformularla e accorparla, mai perderla.
- Mantieni la lingua originale del testo (di norma l'italiano).
- Rispondi ESCLUSIVAMENTE con il testo migliorato in markdown, senza preamboli, commenti o spiegazioni.`;

// POST /api/campaigns/[id]/instructions/improve — riscrive il testo delle
// istruzioni e lo restituisce migliorato. Non persiste nulla: il salvataggio
// resta un'azione esplicita del giocatore.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Testo mancante o vuoto");

  try {
    const message = await client.messages.create({
      model: IMPROVE_MODEL,
      max_tokens: 4000,
      system: IMPROVE_SYSTEM,
      messages: [{ role: "user", content: parsed.data.text }],
    });

    const improved = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();

    if (!improved) {
      return NextResponse.json(
        { error: "L'AI ha restituito un testo vuoto, riprova." },
        { status: 502 },
      );
    }

    return NextResponse.json({ instructions: improved });
  } catch (error) {
    console.error("instructions/improve: errore AI:", error);
    return NextResponse.json(
      { error: "L'AI non è riuscita a migliorare il testo, riprova tra poco." },
      { status: 502 },
    );
  }
}
