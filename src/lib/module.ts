import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";

// Import relativi (niente alias @/): riusabile fuori da Next (script tsx).
import { db } from "../db";
import { campaigns, messages } from "../db/schema";
import { createLlmClient } from "./llm";
import { renderModulePdf } from "./module-pdf";
import { getActiveSummary } from "./queries";
import { chatModel, type AiSettings } from "./settings";
import { getWikiPages, WIKI_FOLDER_LABELS } from "./wiki";

// La trascrizione completa può essere enorme: al modello si passa la
// wiki (memoria a lungo termine, già distillata) più la coda di
// trascrizione entro questo budget, dando priorità ai messaggi recenti.
const TRANSCRIPT_MAX_CHARS = 120_000;

const MODULE_SYSTEM = `Sei un game designer professionista. Il tuo compito è trasformare il materiale di una campagna di gioco di ruolo in solitaria già giocata e conclusa in un MODULO D'AVVENTURA UFFICIALE, completo e rigiocabile da un gruppo umano (GM + giocatori) senza alcun accesso alla partita originale.

## Contenuto obbligatorio
Il modulo deve contenere, come i moduli pubblicati:
- Un titolo evocativo per l'avventura.
- "Background per il Game Master": gli antefatti, cosa è realmente successo e perché, le forze in gioco e le loro motivazioni segrete.
- "Sinossi dell'avventura": il percorso previsto, atto per atto.
- "Agganci per i personaggi": come coinvolgere un nuovo gruppo (generalizza il personaggio della partita originale in agganci riutilizzabili).
- La struttura in atti o capitoli, ognuno con le sue scene. Per ogni scena: la situazione, un eventuale testo da leggere ad alta voce ai giocatori (in blockquote >), cosa possono scoprire i personaggi, gli INCONTRI (avversari, tattiche, possibili esiti), gli INDIZI presenti e come ottenerli, sviluppi alternativi se i giocatori deviano.
- Appendice "Personaggi non giocanti": OGNI PNG rilevante con nome, ruolo nella storia, aspetto, personalità, obiettivi, segreti e (se note dalla partita) caratteristiche di gioco.
- Appendice "Oggetti": ogni oggetto rilevante (magico, tecnologico, di trama) con descrizione, effetti e dove si trova.
- Appendice "Incontri": riepilogo degli scontri e delle creature con le indicazioni meccaniche disponibili.
- Appendice "Indizi": l'elenco completo degli indizi, dove si trovano e a quale rivelazione conducono.
- "Rigiocare l'avventura": consigli e variazioni per partite diverse dall'originale.

## Regole di scrittura
- Scrivi in italiano, nello stile asciutto e professionale dei moduli pubblicati: rivolgiti al GM ("tu"), parla dei "personaggi" o "i PG" per i giocatori.
- Il modulo è per il sistema di gioco indicato: usa la sua terminologia per prove, tiri e meccaniche.
- GENERALIZZA: la partita originale è UNA possibile esecuzione. Trasforma le scelte specifiche del giocatore in snodi con più esiti; le morti o svolte accidentali diventano possibilità, non binari obbligati.
- Non inventare fatti che contraddicono il materiale fornito; puoi però completare i dettagli mancanti (nomi minori, tattiche, numeri) in modo coerente.
- Se il materiale non copre una sezione (es. nessun oggetto rilevante), scrivi la sezione comunque segnalando brevemente che la campagna originale non ne ha prodotti.

## Formato (vincolante)
- Rispondi ESCLUSIVAMENTE con il modulo in markdown, senza preamboli né commenti.
- La prima riga è il titolo del modulo come "# Titolo".
- Struttura SOLO con titoli markdown: "#" per le parti/atti, "##" per capitoli e scene, "###" per le sottosezioni e le schede di appendice.
- Usa i blockquote (">") SOLO per i testi da leggere ad alta voce ai giocatori.
- NIENTE tabelle markdown: usa elenchi puntati o numerati.
- Evidenzia in **grassetto** nomi di PNG, luoghi e oggetti alla loro prima comparsa in una sezione.`;

export class EmptyCampaignError extends Error {}

type Campaign = typeof campaigns.$inferSelect;

// Raccoglie il materiale (wiki + riassunto + coda di trascrizione) e
// chiama il modello della partita. Restituisce il modulo in markdown:
// è il chiamante a persisterlo (campaigns.module_markdown), così i
// download successivi non rigenerano nulla.
export async function generateModuleMarkdown(
  campaign: Campaign,
  settings: AiSettings,
): Promise<string> {
  const [pages, summary, transcript] = await Promise.all([
    getWikiPages(campaign.id),
    getActiveSummary(campaign.id),
    buildTranscriptTail(campaign.id),
  ]);

  if (pages.length === 0 && !summary && !transcript) {
    throw new EmptyCampaignError(
      "La campagna non ha ancora materiale (wiki, riassunti o messaggi) da cui creare il modulo.",
    );
  }

  const parts: string[] = [
    `# Campagna: ${campaign.name}`,
    `Sistema di gioco: ${campaign.gameSystem}`,
  ];

  if (pages.length > 0) {
    const wikiSections: string[] = [
      "# Wiki della campagna (memoria a lungo termine)",
    ];
    for (const page of pages) {
      wikiSections.push(
        `## [${WIKI_FOLDER_LABELS[page.folder]}] ${page.title}\n(${page.description})\n\n${page.content}`,
      );
    }
    parts.push(wikiSections.join("\n\n"));
  }

  if (summary) {
    parts.push(`# Riassunto della campagna\n\n${summary.content}`);
  }

  if (transcript) {
    parts.push(`# Trascrizione della parte finale della partita\n\n${transcript}`);
  }

  parts.push(
    "Crea ora il modulo d'avventura completo di questa campagna, seguendo le istruzioni.",
  );

  const client = createLlmClient(settings);
  const model = chatModel(settings, "gm");
  // deepseek-chat non accetta più di 8k token di output per chiamata.
  const maxTokens = settings.chatProvider === "deepseek" ? 8000 : 16_000;

  // Un modulo completo può superare il limite di output di una singola
  // chiamata (successo con DeepSeek: modulo troncato a metà frase,
  // appendici mai scritte). Quando lo stop reason è "max_tokens" si
  // riapre la conversazione chiedendo di riprendere dal punto esatto,
  // fino a MAX_SEGMENTS spezzoni.
  const MAX_SEGMENTS = 4;
  const conversation: Anthropic.MessageParam[] = [
    { role: "user", content: parts.join("\n\n---\n\n") },
  ];
  const segments: string[] = [];

  for (let i = 0; i < MAX_SEGMENTS; i++) {
    const result = await client.chat({
      model,
      maxTokens,
      thinking: true,
      system: MODULE_SYSTEM,
      messages: conversation,
    });

    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
    if (text.trim()) segments.push(text);

    if (result.stopReason !== "max_tokens" || !text.trim()) break;

    conversation.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content:
          "Il modulo si è interrotto per il limite di lunghezza della risposta. Riprendi ESATTAMENTE dal punto in cui il testo si è interrotto, anche se a metà frase o a metà elenco: non ripetere nulla di già scritto, non aggiungere preamboli o commenti, scrivi solo la continuazione del modulo in markdown fino a completarlo.",
      },
    );
  }

  const markdown = joinSegments(segments);
  if (!markdown) {
    throw new Error("Il modello ha restituito un modulo vuoto");
  }
  return markdown;
}

// Ricuce gli spezzoni della generazione: se la continuazione riparte a
// metà frase (minuscola o segno inline) si salda sulla stessa riga,
// altrimenti come nuovo blocco.
function joinSegments(segments: string[]): string {
  return segments
    .reduce((acc, next) => {
      if (!acc) return next.trim();
      const continuesInline = /^[a-zà-ÿ0-9,;:.)\]»]/.test(next.trimStart());
      return (
        acc.replace(/\s+$/, "") + (continuesInline ? " " : "\n\n") + next.trim()
      );
    }, "")
    .trim();
}

// Impagina il markdown (già generato e persistito) nel PDF. Il titolo
// in copertina è SEMPRE il nome della campagna sulla piattaforma; il
// titolo evocativo scelto dal modello (prima riga "# ...") diventa il
// sottotitolo e il corpo riparte dai blocchi successivi.
export async function renderCampaignModulePdf(
  campaign: Campaign,
  markdown: string,
): Promise<Buffer> {
  // Solo un "# ..." sulla PRIMA riga è il titolo del modulo: un h1 a
  // metà documento è un capitolo e non va toccato.
  const titleMatch = /^#\s+(.+)/.exec(markdown.trimStart());
  const subtitle = titleMatch?.[1].trim() ?? null;
  const body = titleMatch
    ? markdown.trimStart().slice(titleMatch[0].length).trimStart()
    : markdown;

  return renderModulePdf(body, {
    title: campaign.name,
    subtitle: subtitle !== campaign.name ? subtitle : null,
    gameSystem: campaign.gameSystem,
    concludedAt: campaign.concludedAt,
  });
}

// Coda della trascrizione, dal messaggio più recente a ritroso finché il
// budget regge: la parte più vecchia è comunque coperta dalla wiki.
async function buildTranscriptTail(campaignId: string): Promise<string | null> {
  const history = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.campaignId, campaignId))
    .orderBy(messages.createdAt, messages.id);

  if (history.length === 0) return null;

  const kept: string[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const line = `**${m.role === "user" ? "Giocatore" : "GM"}:** ${m.content}`;
    chars += line.length;
    if (kept.length > 0 && chars > TRANSCRIPT_MAX_CHARS) break;
    kept.push(line);
  }
  kept.reverse();
  return kept.join("\n\n");
}
