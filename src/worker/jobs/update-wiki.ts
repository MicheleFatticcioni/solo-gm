import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../../db";
import { campaigns, campaignSummaries, messages } from "../../db/schema";
import { createLlmClient } from "../../lib/llm";
import { enqueueUpdateWiki } from "../../lib/queue";
import { chatModel, getAiSettings } from "../../lib/settings";
import {
  buildWikiIndex,
  CORE_SLUG,
  deleteWikiPage,
  getWikiPage,
  getWikiPages,
  isValidSlug,
  isWikiFolder,
  upsertWikiPage,
  WIKI_FOLDERS,
  WIKI_MIN_NEW_MESSAGES,
  WIKI_TAIL_GUARD,
  type WikiFolder,
} from "../../lib/wiki";

// Cadenza dell'archiviazione (coda in chiaro e soglia minima):
// WIKI_TAIL_GUARD e WIKI_MIN_NEW_MESSAGES in lib/wiki, condivise con il
// trigger della chat. La storia in chiaro (context.ts) è ancorata al
// watermark, quindi il backlog non archiviato resta sempre visibile al
// GM anche se questo job ritarda o fallisce.
// Iterazioni massime del loop agentico dell'archivista.
const MAX_ITERATIONS = 20;

const ARCHIVIST_SYSTEM = `Sei l'archivista di una campagna di gioco di ruolo in solitaria: mantieni la wiki della campagna, la memoria a lungo termine del Game Master.

Ricevi lo stato attuale della wiki (indice completo + pagina panoramica + note temporanee) e la trascrizione dei nuovi eventi di gioco. Aggiorna la wiki con gli strumenti a disposizione perché rifletta TUTTO ciò che è successo.

## Le cartelle
- core: SOLO la pagina core/panoramica — sinossi (2-4 frasi), stato del party (ferite, risorse, equipaggiamento notevole, obiettivi), situazione della scena in corso e ultimi sviluppi, fili aperti, decisioni importanti. Sempre aggiornata, densa di fatti concreti, max ~800 token: è l'unica pagina che il GM ha SEMPRE davanti, e la storia in chiaro che vede è corta — ciò che non è qui o nelle pagine per lui non esiste.
- pg: un personaggio giocante per pagina — descrizione, background, e la scheda meccanica in una sezione "## Scheda".
- npc: un personaggio non giocante per pagina — chi è, atteggiamento verso il party, obiettivi, stato, e l'eventuale scheda di combattimento in "## Scheda".
- luoghi: un luogo per pagina — descrizione, dettagli rilevanti, PNG presenti come [[link]].
- eventi: eventi chiave o decisioni importanti che impatteranno il futuro.
- storia: l'andamento generale della trama (archi, capitoli).
- note: note temporanee a breve scadenza (es. "il PG ha messo una sedia contro la porta"). ELIMINA quelle superate dagli eventi.

## Regole
- Non inventare nulla che non sia nella trascrizione, nella wiki o nel materiale di partenza.
- Una entità = una pagina: aggiorna la pagina esistente, non crearne una seconda con slug diverso. Controlla sempre l'indice prima di creare.
- Prima di riscrivere una pagina che non hai in input, leggila con read_wiki_page: non cancellare informazioni ancora valide.
- Le pagine possono essere state corrette a mano dal giocatore: le correzioni sono fonte di verità, non ripristinare versioni precedenti dei fatti.
- description: UNA riga secca che permetta di capire dall'indice se la pagina serve (es. "capitano della guardia di Velen, ostile al party, sa del medaglione").
- content: markdown; collega le pagine correlate con [[cartella/slug]] (es. [[npc/lord-anor]]).
- slug: kebab-case, solo a-z, 0-9 e trattini (es. lord-anor).
- Comprimi gli eventi remoti più di quelli recenti; i dettagli che scarti dalla panoramica devono però sopravvivere nelle pagine delle cartelle.
- Mantieni SEMPRE core/panoramica coerente con i nuovi eventi: aggiornala per ultima, dopo le altre pagine.
- Quando la wiki è aggiornata, rispondi con un breve elenco di cosa hai cambiato e fermati.`;

const upsertPageTool: Anthropic.Tool = {
  name: "upsert_wiki_page",
  description:
    "Crea o sovrascrive una pagina della wiki. Sovrascrive l'INTERO contenuto: includi anche le informazioni preesistenti ancora valide.",
  input_schema: {
    type: "object",
    properties: {
      folder: { type: "string", enum: [...WIKI_FOLDERS] },
      slug: { type: "string", description: "kebab-case, es. lord-anor" },
      title: { type: "string", description: "es. Lord Anor" },
      description: {
        type: "string",
        description: "una riga per l'indice: chi/cosa è e perché rileva",
      },
      content: { type: "string", description: "contenuto markdown completo" },
    },
    required: ["folder", "slug", "title", "description", "content"],
    additionalProperties: false,
  },
  strict: true,
};

const deletePageTool: Anthropic.Tool = {
  name: "delete_wiki_page",
  description:
    "Elimina una pagina della wiki. Da usare quasi solo per le note temporanee superate.",
  input_schema: {
    type: "object",
    properties: {
      folder: { type: "string", enum: [...WIKI_FOLDERS] },
      slug: { type: "string" },
    },
    required: ["folder", "slug"],
    additionalProperties: false,
  },
  strict: true,
};

const readPageTool: Anthropic.Tool = {
  name: "read_wiki_page",
  description:
    "Legge una pagina della wiki prima di aggiornarla, per non perdere informazioni ancora valide.",
  input_schema: {
    type: "object",
    properties: {
      folder: { type: "string", enum: [...WIKI_FOLDERS] },
      slug: { type: "string" },
    },
    required: ["folder", "slug"],
    additionalProperties: false,
  },
  strict: true,
};

export async function updateWiki(campaignId: string): Promise<void> {
  try {
    const [campaign] = await db
      .select({ wikiCoversUntilMessageId: campaigns.wikiCoversUntilMessageId })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    if (!campaign) throw new Error(`Campagna non trovata: ${campaignId}`);

    // Finché la wiki non ha un watermark suo vale quello del riassunto
    // legacy (modulo f), che alla prima esecuzione fa anche da seed.
    const [legacySummary] = await db
      .select()
      .from(campaignSummaries)
      .where(eq(campaignSummaries.campaignId, campaignId))
      .orderBy(desc(campaignSummaries.createdAt))
      .limit(1);

    const isFirstRun = !campaign.wikiCoversUntilMessageId;
    const watermark =
      campaign.wikiCoversUntilMessageId ??
      legacySummary?.coversUntilMessageId ??
      null;

    // Confronto di tupla (created_at, id) per un ordine totale stabile
    // anche con timestamp identici (stesso criterio della paginazione).
    const afterWatermark = watermark
      ? sql`(${messages.createdAt}, ${messages.id}) > (
          select created_at, id from messages
          where id = ${watermark}
        )`
      : undefined;

    const newMessages = await db
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.campaignId, campaignId), afterWatermark))
      .orderBy(messages.createdAt, messages.id);

    // Gli ultimi turni restano fuori dalla finestra da archiviare: sono
    // ancora in chiaro nel contesto della chat, e archiviarli farebbe
    // "inseguire" la conversazione in corso. La finestra si chiude
    // inoltre su un turno del GM, così la storia in chiaro riparte da
    // un messaggio user (vincolo dell'API Anthropic) e context.ts non
    // deve scartare un turno assistant mai archiviato.
    let end = Math.max(0, newMessages.length - WIKI_TAIL_GUARD);
    while (end > 0 && newMessages[end - 1].role === "user") end--;
    const window = newMessages.slice(0, end);
    if (window.length < WIKI_MIN_NEW_MESSAGES) {
      console.log(
        `update-wiki: campagna ${campaignId}, solo ${window.length} messaggi archiviabili, salto`,
      );
      return;
    }

    const transcript = window
      .map((m) => `${m.role === "user" ? "Giocatore" : "GM"}: ${m.content}`)
      .join("\n\n");

    const pages = await getWikiPages(campaignId);
    const core = pages.find((p) => p.folder === "core" && p.slug === CORE_SLUG);
    const notes = pages.filter((p) => p.folder === "note");

    const stateParts = [
      `## Indice attuale della wiki\n\n${buildWikiIndex(pages)}`,
      `## core/${CORE_SLUG} (contenuto attuale)\n\n${core?.content ?? "(non ancora creata: creala)"}`,
      notes.length > 0
        ? `## Note temporanee attuali\n\n${notes.map((n) => `### note/${n.slug} — ${n.title}\n${n.content}`).join("\n\n")}`
        : "## Note temporanee attuali\n\n(nessuna)",
    ];
    // Solo alla prima esecuzione: il riassunto del modulo f come
    // materiale di partenza per popolare la wiki.
    if (isFirstRun && legacySummary) {
      stateParts.push(
        `## Riassunto legacy della campagna (materiale di partenza, da distribuire nelle pagine)\n\n${legacySummary.content}`,
      );
    }

    // L'app è single-tenant: le impostazioni sono quelle dell'unico utente.
    const settings = await getAiSettings();
    const client = createLlmClient(settings);
    const model = chatModel(settings, "summary");

    const conversation: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `${stateParts.join("\n\n")}\n\n## Nuovi eventi da archiviare (trascrizione)\n\n${transcript}`,
      },
    ];

    let changes = 0;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const final = await client.chat({
        model,
        maxTokens: 16000,
        thinking: true,
        system: ARCHIVIST_SYSTEM,
        messages: conversation,
        tools: [upsertPageTool, deletePageTool, readPageTool],
      });

      if (final.stopReason !== "tool_use") break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of final.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeArchivistTool(campaignId, block);
        if (result.ok && block.name !== "read_wiki_page") changes++;
        toolResults.push(result.block);
      }
      conversation.push(
        { role: "assistant", content: final.content },
        { role: "user", content: toolResults },
      );
    }

    // Il watermark avanza solo a lavoro concluso: se il job fallisce a
    // metà, il retry riparte dalla stessa finestra (gli upsert sono
    // idempotenti rispetto a una seconda passata).
    const newWatermark = window[window.length - 1].id;
    await db
      .update(campaigns)
      .set({ wikiCoversUntilMessageId: newWatermark })
      .where(eq(campaigns.id, campaignId));

    console.log(
      `update-wiki: campagna ${campaignId}, archiviati ${window.length} messaggi (${changes} modifiche alla wiki)`,
    );

    // Un run può essere lento (soprattutto con modelli locali) e la
    // partita nel frattempo prosegue: se si è già riaccumulata una
    // finestra archiviabile la si riaccoda subito, senza aspettare il
    // prossimo turno (la policy stately ammette un job in coda mentre
    // questo è ancora attivo).
    const [{ backlog }] = await db
      .select({ backlog: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.campaignId, campaignId),
          sql`(${messages.createdAt}, ${messages.id}) > (
            select created_at, id from messages
            where id = ${newWatermark}
          )`,
        ),
      );
    if (backlog - WIKI_TAIL_GUARD >= WIKI_MIN_NEW_MESSAGES) {
      await enqueueUpdateWiki(campaignId);
    }
  } catch (error) {
    // Il fallimento resta nel worker (retry pg-boss), la chat non ne risente.
    console.error(`update-wiki: fallito per campagna ${campaignId}:`, error);
    throw error;
  }
}

type ArchivistToolOutcome = { ok: boolean; block: Anthropic.ToolResultBlockParam };

async function executeArchivistTool(
  campaignId: string,
  block: Anthropic.ToolUseBlockParam,
): Promise<ArchivistToolOutcome> {
  const fail = (message: string): ArchivistToolOutcome => ({
    ok: false,
    block: {
      type: "tool_result",
      tool_use_id: block.id,
      content: message,
      is_error: true,
    },
  });
  const succeed = (message: string): ArchivistToolOutcome => ({
    ok: true,
    block: { type: "tool_result", tool_use_id: block.id, content: message },
  });

  const input = block.input as {
    folder?: string;
    slug?: string;
    title?: string;
    description?: string;
    content?: string;
  };
  const folder = input.folder ?? "";
  const slug = input.slug ?? "";
  if (!isWikiFolder(folder)) return fail(`Cartella non valida: "${folder}"`);
  if (!isValidSlug(slug)) {
    return fail(`Slug non valido: "${slug}" (kebab-case, solo a-z, 0-9 e trattini)`);
  }
  if (folder === "core" && slug !== CORE_SLUG) {
    return fail(`La cartella core contiene solo core/${CORE_SLUG}`);
  }
  const typedFolder: WikiFolder = folder;

  switch (block.name) {
    case "upsert_wiki_page": {
      const { title, description, content } = input;
      if (!title?.trim() || !description?.trim() || !content?.trim()) {
        return fail("title, description e content non possono essere vuoti");
      }
      await upsertWikiPage(campaignId, {
        folder: typedFolder,
        slug,
        title: title.trim(),
        description: description.trim(),
        content: content.trim(),
      });
      return succeed(`Pagina ${folder}/${slug} salvata.`);
    }
    case "delete_wiki_page": {
      const deleted = await deleteWikiPage(campaignId, typedFolder, slug);
      return deleted
        ? succeed(`Pagina ${folder}/${slug} eliminata.`)
        : fail(`Pagina ${folder}/${slug} inesistente.`);
    }
    case "read_wiki_page": {
      const page = await getWikiPage(campaignId, typedFolder, slug);
      if (!page) return fail(`Pagina ${folder}/${slug} inesistente.`);
      return succeed(`# ${page.title}\n(${page.description})\n\n${page.content}`);
    }
    default:
      return fail(`Strumento sconosciuto: ${block.name}`);
  }
}
