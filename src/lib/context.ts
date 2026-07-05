import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gt, sql } from "drizzle-orm";

import { db } from "@/db";
import { campaignDocuments, campaigns, documents, messages } from "@/db/schema";
import { getActiveSummary } from "@/lib/queries";
import { buildRetrievalQuery, retrieve, type RetrievedChunk } from "@/lib/rag";

// Cap sulla storia recente inclusa nel prompt (oltre il riassunto).
const HISTORY_MAX_MESSAGES = 20;
// ~8000 token stimati a chars/3.5.
const HISTORY_MAX_CHARS = 8000 * 3.5;

export type GmContext = {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  retrieved: RetrievedChunk[];
};

// Istruzioni GM fisse. Unica interpolazione ammessa: {game_system},
// stabile per campagna — qualsiasi altro contenuto volatile qui
// distruggerebbe il prompt caching (prefix-match).
function gmInstructions(gameSystem: string): string {
  return `Sei il Game Master di una partita di gioco di ruolo in solitaria. Conduci la partita nello stile e con le regole del sistema "${gameSystem}", rispettandone il tono, il ritmo e le convenzioni.

## Come conduci la scena
- Descrivi le scene in seconda persona ("Vedi...", "Senti..."), con dettagli sensoriali concreti ma senza prolissità: poche frasi dense valgono più di lunghi paragrafi.
- Interpreta i personaggi non giocanti dando a ciascuno voce, obiettivi e reazioni coerenti. Falli parlare in prima persona quando è naturale.
- Proponi scelte e opportunità, ma non forzare mai le azioni del giocatore: è lui a decidere cosa fa il suo personaggio. Non descrivere mai azioni, pensieri o parole del personaggio giocante che il giocatore non ha dichiarato.
- Fai avanzare la storia a ogni turno: complica, rivela, incalza. Evita risposte che lasciano la scena esattamente com'era.

## Regole e manuali
- Nel turno del giocatore ricevi estratti dei manuali nel blocco <estratti_manuali>. Quando una regola è rilevante, applicala citando la fonte (documento e pagine).
- Se una regola necessaria NON compare negli estratti, dillo esplicitamente e improvvisa una risoluzione coerente con il sistema, segnalando che è una tua interpretazione.
- Non inventare mai regole spacciandole per testo ufficiale.

## Tiri di dado
- Quando serve un tiro di dado, usa SEMPRE lo strumento roll_dice. Non inventare mai il risultato di un tiro, né chiedere al giocatore di tirare al posto tuo.
- Dichiara prima cosa tiri e perché, poi interpreta il risultato nella fiction.

## Coerenza
- Mantieni la coerenza con il riassunto della campagna e con la storia recente: nomi, luoghi, ferite, oggetti, promesse fatte dai PNG.
- Se il giocatore contraddice fatti stabiliti, chiedigli conferma invece di riscrivere silenziosamente la storia.

## Chiusura del turno
- Chiudi ogni turno lasciando la situazione aperta e restituendo l'iniziativa al giocatore, tipicamente con "Cosa fai?" o una domanda equivalente adatta alla scena.

Rispondi sempre in italiano.`;
}

// Assembla system e messages per la chiamata a Claude (modulo e).
// Ordine dei blocchi system dal più stabile al più volatile, con
// cache_control sui confini: il prompt caching Anthropic è un
// prefix-match, tutto ciò che precede un breakpoint viene riusato.
export async function buildGmContext(
  campaignId: string,
  userMessage: string,
): Promise<GmContext> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`Campagna non trovata: ${campaignId}`);

  const [docs, summary] = await Promise.all([
    db
      .select({
        title: documents.title,
        docType: documents.docType,
        description: documents.description,
      })
      .from(campaignDocuments)
      .innerJoin(documents, eq(documents.id, campaignDocuments.documentId))
      .where(
        and(
          eq(campaignDocuments.campaignId, campaignId),
          eq(documents.status, "ready"),
        ),
      )
      .orderBy(documents.title),
    getActiveSummary(campaignId),
  ]);

  const history = await getRecentHistory(campaignId, summary?.coversUntilMessageId);

  const retrievalQuery = buildRetrievalQuery(
    userMessage,
    history.map((m) => ({ role: m.role, content: m.content })),
  );
  // Senza documenti pronti non c'è nulla da cercare: si evita anche
  // la chiamata di embedding della query.
  const retrieved =
    docs.length === 0 ? [] : await retrieve(campaignId, retrievalQuery);

  const catalog =
    docs.length === 0
      ? "Nessun documento associato alla campagna."
      : docs
          .map((d) => `- "${d.title}" (${d.docType}): ${d.description}`)
          .join("\n");

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: gmInstructions(campaign.gameSystem),
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `## Documenti della campagna\n\n${catalog}`,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `## Riassunto della campagna\n\n${
        summary?.content ?? "Nuova campagna, nessun evento precedente."
      }`,
      cache_control: { type: "ephemeral" },
    },
  ];

  // Gli estratti RAG stanno solo nell'ultimo turno user: sono volatili,
  // nel system invaliderebbero la cache a ogni messaggio. Nel DB si
  // salva solo il testo del giocatore; gli id dei chunk finiscono nei
  // metadata del messaggio (modulo e), da qui il campo `retrieved`.
  const messageParams: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: `${formatExcerpts(retrieved)}\n\n${userMessage}` },
  ];

  return { system, messages: messageParams, retrieved };
}

// Ultimi messaggi successivi a quello coperto dal riassunto attivo,
// con doppio cap: numero di messaggi e token stimati (chars/3.5).
async function getRecentHistory(
  campaignId: string,
  coversUntilMessageId: string | null | undefined,
) {
  const afterSummary = coversUntilMessageId
    ? gt(
        messages.createdAt,
        sql`(select created_at from messages where id = ${coversUntilMessageId})`,
      )
    : undefined;

  const recent = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), afterSummary))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_MAX_MESSAGES);

  // recent è dal più nuovo al più vecchio: si accumula finché il budget
  // di caratteri regge, poi si rimette in ordine cronologico.
  const window: typeof recent = [];
  let chars = 0;
  for (const message of recent) {
    chars += message.content.length;
    if (window.length > 0 && chars > HISTORY_MAX_CHARS) break;
    window.push(message);
  }
  window.reverse();

  // L'API Anthropic richiede che il primo messaggio sia del ruolo user:
  // se il taglio della finestra lascia in testa un turno assistant, lo
  // si scarta (il contenuto perso è comunque coperto dal riassunto o
  // ricostruibile dal contesto).
  while (window.length > 0 && window[0].role !== "user") {
    window.shift();
  }

  return window;
}

function formatExcerpts(retrieved: RetrievedChunk[]): string {
  if (retrieved.length === 0) {
    return "<estratti_manuali>\n(nessun estratto rilevante trovato)\n</estratti_manuali>";
  }
  const excerpts = retrieved
    .map(
      (c) =>
        `  <estratto documento="${escapeAttribute(c.documentTitle)}" tipo="${c.docType}" pagine="${c.pageStart}-${c.pageEnd}">\n${c.content}\n  </estratto>`,
    )
    .join("\n");
  return `<estratti_manuali>\n${excerpts}\n</estratti_manuali>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
