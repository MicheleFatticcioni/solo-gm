import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { campaignDocuments, campaigns, documents, messages } from "@/db/schema";
import { getActiveSummary } from "@/lib/queries";
import {
  buildRetrievalQuery,
  formatExcerpts,
  retrieve,
  type RetrievedChunk,
} from "@/lib/rag";
import { buildMemoryBlock } from "@/lib/wiki";

// La storia in chiaro copre TUTTO ciò che segue il watermark della
// wiki: di quegli eventi è l'unica copia (la wiki non li ha ancora
// archiviati), quindi non può avere buchi. In condizioni normali il
// backlog resta piccolo (WIKI_TAIL_GUARD + WIKI_MIN_NEW_MESSAGES
// messaggi al massimo, vedi lib/wiki); questi cap sono solo un
// paracadute contro i casi patologici (job update-wiki fermo o in forte
// ritardo). Quando tagliano davvero aprono un buco di memoria, e lo si
// segnala nel log.
const HISTORY_MAX_MESSAGES = 30;
// ~12000 token stimati a chars/3.5.
const HISTORY_MAX_CHARS = 12000 * 3.5;

export type GmContext = {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  retrieved: RetrievedChunk[];
};

// Istruzioni GM fisse. Interpolazioni ammesse solo se stabili per
// campagna ({game_system} e le istruzioni utente) — qualsiasi contenuto
// volatile qui distruggerebbe il prompt caching (prefix-match).
function gmInstructions(
  gameSystem: string,
  aiInstructions: string | null,
): string {
  const base = `Sei il Game Master di una partita di gioco di ruolo in solitaria. Conduci la partita nello stile e con le regole del sistema "${gameSystem}", rispettandone il tono, il ritmo e le convenzioni.

## Come conduci la scena
- Descrivi le scene in seconda persona ("Vedi...", "Senti..."), con dettagli sensoriali concreti ma senza prolissità: poche frasi dense valgono più di lunghi paragrafi.
- Interpreta i personaggi non giocanti dando a ciascuno voce, obiettivi e reazioni coerenti. Falli parlare in prima persona quando è naturale.
- I personaggi non giocanti non devono essere necessariamente accondiscendenti. Posso essere amichevoli, aggressivi, manipolatori ecc. Non creare personaggi piatti pronti a servire il giocatore, crea personaggi vivi con un proprio carattere e personalità
- Proponi scelte e opportunità, ma non forzare mai le azioni del giocatore: è lui a decidere cosa fa il suo personaggio. Non descrivere mai azioni, pensieri o parole del personaggio giocante che il giocatore non ha dichiarato.
- Fai avanzare la storia a ogni turno: complica, rivela, incalza. Evita risposte che lasciano la scena esattamente com'era.

## Regole e manuali
- Nel turno del giocatore ricevi estratti dei manuali nel blocco <estratti_manuali>. Quando una regola è rilevante, applicala citando la fonte (documento e pagine).
- Se una regola, tabella o dettaglio necessario NON compare negli estratti, cercalo con lo strumento search_manuals PRIMA di improvvisare: formula la query con i termini con cui la regola è scritta sul manuale (es. "prova di atletica scalare"), non con la descrizione della scena. Se la prima ricerca va a vuoto, riprova al massimo una volta con termini diversi.
- Solo se nemmeno la ricerca trova la regola, dillo esplicitamente e improvvisa una risoluzione coerente con il sistema, segnalando che è una tua interpretazione.
- Non inventare mai regole spacciandole per testo ufficiale.

## Tiri di dado
- Quando serve un tiro di dado, usa SEMPRE lo strumento roll_dice. Non inventare mai il risultato di un tiro, né chiedere al giocatore di tirare al posto tuo.
- Dichiara prima cosa tiri e perché, poi interpreta il risultato nella fiction.

## Memoria e wiki
- La tua memoria a lungo termine è nel blocco "Memoria della campagna": panoramica, note temporanee e indice della wiki. La panoramica e le note le hai già: NON servono letture per usarle.
- Quando la scena coinvolge un PNG, un luogo o un evento presente nell'indice, leggi la sua pagina con lo strumento read_wiki_page PRIMA di descriverlo o farlo agire: i fatti scritti nelle pagine prevalgono sulla tua memoria implicita.
- Leggi solo le pagine rilevanti per la scena corrente, al massimo 2-3 per turno; non rileggere pagine già lette in questo turno.

## Uso degli strumenti
- Se prevedi di aver bisogno di più strumenti nello stesso turno (es. leggere più pagine wiki, o leggere una pagina wiki e tirare un dado), richiamali tutti insieme nella stessa risposta invece che uno alla volta in risposte separate: ogni risposta separata rifà il giro completo del contesto ed è più lenta e costosa.

## Coerenza
- Mantieni la coerenza con la memoria della campagna (panoramica, note, pagine wiki lette) e con la storia recente: nomi, luoghi, ferite, oggetti, promesse fatte dai PNG.
- Se il giocatore contraddice fatti stabiliti, chiedigli conferma invece di riscrivere silenziosamente la storia.

## Chiusura del turno
- Chiudi ogni turno lasciando la situazione aperta e restituendo l'iniziativa al giocatore, tipicamente con "Cosa fai?" o una domanda equivalente adatta alla scena.

Rispondi sempre in italiano.`;

  const custom = aiInstructions?.trim();
  if (!custom) return base;

  return `${base}

## Istruzioni del giocatore per questa campagna
Il giocatore ha indicato come vuole che questa campagna venga condotta. Tienine SEMPRE conto in ogni risposta; in caso di conflitto con le linee guida generali sopra, prevalgono queste indicazioni:

${custom}`;
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

  const [docs, summary, wikiMemory] = await Promise.all([
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
    buildMemoryBlock(campaignId),
  ]);

  // La storia in chiaro parte dal watermark della wiki; finché la wiki
  // non è popolata vale quello del riassunto legacy (modulo f).
  const history = await getRecentHistory(
    campaignId,
    campaign.wikiCoversUntilMessageId ?? summary?.coversUntilMessageId,
  );

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
      text: gmInstructions(campaign.gameSystem, campaign.aiInstructions),
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `## Documenti della campagna\n\n${catalog}`,
      cache_control: { type: "ephemeral" },
    },
    // Nucleo della memoria ibrida (modulo g): panoramica + note + indice
    // wiki. Cambia solo quando worker o utente scrivono pagine, quindi
    // la cache regge tra turni consecutivi. Fallback: riassunto legacy.
    {
      type: "text",
      text: `## Memoria della campagna\n\n${
        wikiMemory ??
        summary?.content ??
        "Nuova campagna, nessun evento precedente."
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
    {
      role: "user" as const,
      content: `${formatExcerpts(retrieved)}\n\n${userMessage}`,
    },
  ];

  return { system, messages: messageParams, retrieved };
}

// Tutti i messaggi successivi a quello coperto dalla wiki (o dal
// riassunto legacy), con i cap paracadute su numero e caratteri.
async function getRecentHistory(
  campaignId: string,
  coversUntilMessageId: string | null | undefined,
) {
  // Confronto di tupla (created_at, id), lo stesso di update-wiki: sul
  // solo created_at un messaggio con timestamp identico al watermark
  // sparirebbe dalla storia senza essere mai stato archiviato.
  const afterSummary = coversUntilMessageId
    ? sql`(${messages.createdAt}, ${messages.id}) > (
        select created_at, id from messages
        where id = ${coversUntilMessageId}
      )`
    : undefined;

  const recent = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), afterSummary))
    .orderBy(desc(messages.createdAt), desc(messages.id))
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

  // Il paracadute ha tagliato (o la query ha saturato il limit): c'è
  // storia che il GM non vede né in wiki né in contesto. Non deve
  // succedere in condizioni normali.
  if (window.length < recent.length || recent.length === HISTORY_MAX_MESSAGES) {
    console.warn(
      `context: campagna ${campaignId}, backlog oltre il paracadute della storia ` +
        `(in contesto ${window.length} messaggi su ${recent.length}+ dopo il watermark): ` +
        "possibile buco di memoria, verificare che il job update-wiki giri",
    );
  }

  // L'API Anthropic richiede che il primo messaggio sia del ruolo user:
  // se il taglio della finestra lascia in testa un turno assistant, lo
  // si scarta (il contenuto perso è comunque coperto dal riassunto o
  // ricostruibile dal contesto).
  while (window.length > 0 && window[0].role !== "user") {
    window.shift();
  }

  return window;
}

