import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../../db";
import { campaignSummaries, messages } from "../../db/schema";

// Gli ultimi turni restano fuori dalla finestra da riassumere: sono
// ancora in chiaro nel contesto della chat, e riassumerli farebbe
// "inseguire" la conversazione in corso.
const TAIL_GUARD = 6;
// Sotto questa soglia di messaggi nuovi non vale la pena rigenerare.
const MIN_NEW_MESSAGES = 10;

const SUMMARY_MODEL = process.env.ANTHROPIC_MODEL_SUMMARY ?? "claude-opus-4-8";

const client = new Anthropic();

// Nota di evoluzione: lo "Stato del party" potrebbe diventare una scheda
// strutturata jsonb aggiornata via tool use, come fonte di verità
// separata dal riassunto testuale.
const SUMMARY_SYSTEM = `Sei l'archivista di una campagna di gioco di ruolo in solitaria: mantieni il riassunto progressivo della campagna, la memoria a lungo termine del Game Master.

Ricevi il riassunto precedente (se esiste) e la trascrizione dei nuovi eventi di gioco. Produci un riassunto AGGIORNATO che integri i nuovi eventi in quello precedente.

## Regole
- Non inventare nulla che non sia nella trascrizione o nel riassunto precedente.
- Preserva le informazioni del riassunto precedente ancora rilevanti (PNG, luoghi, fili aperti, promesse): ciò che ometti il GM lo dimentica per sempre.
- Comprimi gli eventi remoti più di quelli recenti: le sessioni lontane diventano poche righe, gli eventi recenti restano nitidi.
- Scrivi in italiano, al massimo ~1500 token.
- Rispondi SOLO con il riassunto in markdown, esattamente con queste sezioni:

## Sinossi
(2-4 frasi: dove siamo nella storia)

## Eventi chiave
(cronologico, sintetico)

## PNG
(nome — chi è, atteggiamento verso il PG, stato)

## Luoghi
(visitati/noti, dettagli rilevanti)

## Stato del party
(PG: ferite, risorse, equipaggiamento notevole, obiettivi)

## Fili aperti
(missioni in corso, misteri, promesse, minacce)

## Decisioni importanti del giocatore
(elenco)`;

export async function updateSummary(campaignId: string): Promise<void> {
  try {
    const [active] = await db
      .select()
      .from(campaignSummaries)
      .where(eq(campaignSummaries.campaignId, campaignId))
      .orderBy(desc(campaignSummaries.createdAt))
      .limit(1);

    // Confronto di tupla (created_at, id) per un ordine totale stabile
    // anche con timestamp identici (stesso criterio della paginazione).
    const afterSummary = active?.coversUntilMessageId
      ? sql`(${messages.createdAt}, ${messages.id}) > (
          select created_at, id from messages
          where id = ${active.coversUntilMessageId}
        )`
      : undefined;

    const newMessages = await db
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.campaignId, campaignId), afterSummary))
      .orderBy(messages.createdAt, messages.id);

    const window = newMessages.slice(0, Math.max(0, newMessages.length - TAIL_GUARD));
    if (window.length < MIN_NEW_MESSAGES) {
      console.log(
        `update-summary: campagna ${campaignId}, solo ${window.length} messaggi riassumibili, salto`,
      );
      return;
    }

    const transcript = window
      .map((m) => `${m.role === "user" ? "Giocatore" : "GM"}: ${m.content}`)
      .join("\n\n");

    const previousBlock = active
      ? `${active.content}${
          active.isUserEdited
            ? "\n\n(Nota: questo riassunto è stato corretto a mano dal giocatore: trattalo come fonte di verità anche dove contraddice la trascrizione più vecchia.)"
            : ""
        }`
      : "(nessuno: questa è la prima parte della storia)";

    const stream = client.messages.stream({
      model: SUMMARY_MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: SUMMARY_SYSTEM,
      messages: [
        {
          role: "user",
          content: `## Riassunto precedente\n\n${previousBlock}\n\n## Nuovi eventi da integrare (trascrizione)\n\n${transcript}`,
        },
      ],
    });
    const final = await stream.finalMessage();

    const content = final.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    if (!content) throw new Error("il modello ha restituito un riassunto vuoto");

    // Append-only: i vecchi riassunti restano come storico, i messaggi
    // non si toccano mai (la cronologia integrale resta in DB).
    await db.insert(campaignSummaries).values({
      campaignId,
      content,
      coversUntilMessageId: window[window.length - 1].id,
      isUserEdited: false,
    });

    console.log(
      `update-summary: campagna ${campaignId}, riassunti ${window.length} messaggi (${final.usage.output_tokens} token di output)`,
    );
  } catch (error) {
    // Il fallimento resta nel worker (retry pg-boss), la chat non ne risente.
    console.error(`update-summary: fallito per campagna ${campaignId}:`, error);
    throw error;
  }
}
