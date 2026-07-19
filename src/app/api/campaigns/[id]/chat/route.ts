import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { campaigns, campaignSummaries, messages } from "@/db/schema";
import { badRequest, forbidden, notFound, parseId, unauthorized } from "@/lib/api";
import { buildGmContext } from "@/lib/context";
import { rollDice, rollDiceTool, type RollDiceInput } from "@/lib/dice";
import { getCampaign } from "@/lib/queries";
import { enqueueUpdateWiki } from "@/lib/queue";
import { createLlmClient } from "@/lib/llm";
import {
  formatExcerpts,
  retrieve,
  SEARCH_MANUALS_TOP_K,
  searchManualsTool,
  type SearchManualsInput,
} from "@/lib/rag";
import { getUserId } from "@/lib/session";
import { AiConfigError, chatModel, getAiSettings } from "@/lib/settings";
import {
  getWikiPage,
  isWikiFolder,
  readWikiPageTool,
  WIKI_MIN_NEW_MESSAGES,
  WIKI_TAIL_GUARD,
  type ReadWikiPageInput,
} from "@/lib/wiki";

const bodySchema = z.object({ message: z.string().trim().min(1) });

// Iterazioni massime del loop agentico (stream → tool_use → riapri):
// oltre questa soglia si tronca il turno per sicurezza. 8 perché in un
// turno possono convivere letture wiki e tiri di dado.
const MAX_ITERATIONS = 8;

type DiceEvent = {
  notation: string;
  reason: string;
  rolls: number[];
  total: number;
};

type WikiReadEvent = {
  folder: string;
  slug: string;
  title: string | null;
};

type SearchEvent = {
  query: string;
  count: number;
};

// Eventi SSE verso il browser.
type ChatEvent =
  | { type: "text"; text: string }
  | ({ type: "dice" } & DiceEvent)
  | ({ type: "wiki" } & WikiReadEvent)
  | ({ type: "search" } & SearchEvent)
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

// POST /api/campaigns/[id]/chat — un turno di gioco in streaming SSE.
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

  // Campagna conclusa: la storia è chiusa, niente nuovi turni.
  if (campaign.concludedAt) {
    return forbidden(
      "La campagna è conclusa: riaprila dal dettaglio campagna per continuare a giocare.",
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Messaggio mancante o vuoto");
  const userMessage = parsed.data.message;

  // Il testo del giocatore si salva subito (senza estratti RAG): se la
  // chiamata al modello fallisce, il messaggio non va perso.
  await db
    .insert(messages)
    .values({ campaignId: id, role: "user", content: userMessage });

  const context = await buildGmContext(id, userMessage);
  const settings = await getAiSettings(userId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const messageId = await runGmTurn(id, context, settings, send);
        send({ type: "done", messageId });
      } catch (error) {
        console.error("chat: errore nel turno GM:", error);
        send({ type: "error", message: friendlyErrorMessage(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

// Loop agentico manuale con streaming: i text_delta vanno inoltrati al
// client man mano che arrivano, qualunque sia il provider.
async function runGmTurn(
  campaignId: string,
  context: Awaited<ReturnType<typeof buildGmContext>>,
  settings: Awaited<ReturnType<typeof getAiSettings>>,
  send: (event: ChatEvent) => void,
): Promise<string> {
  const client = createLlmClient(settings);
  const model = chatModel(settings, "gm");
  const conversation = [...context.messages];
  const textParts: string[] = [];
  const dice: DiceEvent[] = [];
  const wikiReads: WikiReadEvent[] = [];
  const searches: SearchEvent[] = [];
  // Chunk citati nel turno: quelli del retrieval automatico più quelli
  // trovati dalle ricerche esplicite del GM (per i metadata del messaggio).
  const chunkIds = new Set(context.retrieved.map((c) => c.chunkId));
  let inputTokens = 0;
  let outputTokens = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const final = await client.chat(
      {
        model,
        maxTokens: 8000,
        thinking: true,
        system: context.system,
        messages: conversation,
        tools: [rollDiceTool, readWikiPageTool, searchManualsTool],
      },
      (text) => send({ type: "text", text }),
    );

    inputTokens += final.usage.inputTokens;
    outputTokens += final.usage.outputTokens;
    for (const block of final.content) {
      if (block.type === "text") textParts.push(block.text);
    }

    if (final.stopReason !== "tool_use") break;

    // Turno assistant completo (thinking/testo/tool_use inclusi) + un
    // SOLO messaggio user con tutti i tool_result, poi si riapre lo stream.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of final.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "roll_dice") {
        toolResults.push(executeRollDice(block, send, dice));
      } else if (block.name === "read_wiki_page") {
        toolResults.push(
          await executeReadWikiPage(campaignId, block, send, wikiReads),
        );
      } else if (block.name === "search_manuals") {
        toolResults.push(
          await executeSearchManuals(campaignId, block, send, searches, chunkIds),
        );
      }
    }
    conversation.push(
      { role: "assistant", content: final.content },
      { role: "user", content: toolResults },
    );
  }

  const [saved] = await db
    .insert(messages)
    .values({
      campaignId,
      role: "assistant",
      content: textParts.join("\n\n"),
      inputTokens,
      outputTokens,
      metadata: {
        chunkIds: [...chunkIds],
        dice,
        wikiReads,
        searches,
      },
    })
    .returning({ id: messages.id });

  await db
    .update(campaigns)
    .set({ lastPlayedAt: new Date() })
    .where(eq(campaigns.id, campaignId));

  await maybeTriggerWikiUpdate(campaignId);

  return saved.id;
}

// Lettura di una pagina wiki richiesta dal GM: la pagina inesistente
// non è un errore fatale, si rimanda il modello all'indice.
async function executeReadWikiPage(
  campaignId: string,
  block: Anthropic.ToolUseBlockParam,
  send: (event: ChatEvent) => void,
  wikiReads: WikiReadEvent[],
): Promise<Anthropic.ToolResultBlockParam> {
  const input = block.input as ReadWikiPageInput;
  const folder = input.folder ?? "";
  const slug = input.slug ?? "";

  const page = isWikiFolder(folder)
    ? await getWikiPage(campaignId, folder, slug)
    : null;

  if (!page) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `Pagina "${folder}/${slug}" non trovata: usa una voce dell'indice nella memoria della campagna.`,
      is_error: true,
    };
  }

  const event: WikiReadEvent = { folder, slug, title: page.title };
  wikiReads.push(event);
  send({ type: "wiki", ...event });
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: `# ${page.title}\n(${page.description})\n\n${page.content}`,
  };
}

// Ricerca esplicita nei manuali richiesta dal GM: stesso retrieve()
// ibrido del turno, ma con la query formulata dal modello. La ricerca
// vuota non è un errore: si suggerisce al modello di riformulare.
async function executeSearchManuals(
  campaignId: string,
  block: Anthropic.ToolUseBlockParam,
  send: (event: ChatEvent) => void,
  searches: SearchEvent[],
  chunkIds: Set<string>,
): Promise<Anthropic.ToolResultBlockParam> {
  const query = (block.input as SearchManualsInput).query?.trim();
  if (!query) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: "Query mancante: indica i termini da cercare nei manuali.",
      is_error: true,
    };
  }

  const results = await retrieve(campaignId, query, SEARCH_MANUALS_TOP_K);
  for (const result of results) chunkIds.add(result.chunkId);

  const event: SearchEvent = { query, count: results.length };
  searches.push(event);
  send({ type: "search", ...event });

  return {
    type: "tool_result",
    tool_use_id: block.id,
    content:
      results.length === 0
        ? "Nessun estratto trovato. Riprova al massimo una volta con termini diversi (sinonimi, nome esatto della regola o della tabella); se anche quella va a vuoto, dichiara che la regola non è negli estratti disponibili."
        : formatExcerpts(results),
  };
}

function executeRollDice(
  block: Anthropic.ToolUseBlockParam,
  send: (event: ChatEvent) => void,
  dice: DiceEvent[],
): Anthropic.ToolResultBlockParam {
  const input = block.input as RollDiceInput;
  try {
    const result = rollDice(input.notation);
    const event: DiceEvent = {
      notation: input.notation,
      reason: input.reason,
      rolls: result.rolls,
      total: result.total,
    };
    dice.push(event);
    send({ type: "dice", ...event });
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: JSON.stringify(result),
    };
  } catch (error) {
    // Notazione invalida: lo si dice al modello, che riformula il tiro.
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: error instanceof Error ? error.message : "Notazione non valida",
      is_error: true,
    };
  }
}

// Se i messaggi archiviabili (oltre la coda che resta in chiaro) hanno
// raggiunto la soglia minima del job, accoda l'aggiornamento della wiki
// (job del modulo g). Stesso criterio a conteggio del job stesso: una
// soglia a token più larga della storia in chiaro aprirebbe un buco di
// messaggi che il GM non vede né in wiki né in contesto. Finché la wiki
// non è popolata il watermark è quello del riassunto legacy: alla prima
// esecuzione il job usa il riassunto come seed.
async function maybeTriggerWikiUpdate(campaignId: string): Promise<void> {
  const [campaign] = await db
    .select({ wikiCoversUntilMessageId: campaigns.wikiCoversUntilMessageId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));

  let watermark = campaign?.wikiCoversUntilMessageId ?? null;
  if (!watermark) {
    const [summary] = await db
      .select({ coversUntilMessageId: campaignSummaries.coversUntilMessageId })
      .from(campaignSummaries)
      .where(eq(campaignSummaries.campaignId, campaignId))
      .orderBy(sql`${campaignSummaries.createdAt} desc`)
      .limit(1);
    watermark = summary?.coversUntilMessageId ?? null;
  }

  // Confronto di tupla (created_at, id), lo stesso del job update-wiki.
  const afterWatermark = watermark
    ? sql`(${messages.createdAt}, ${messages.id}) > (
        select created_at, id from messages
        where id = ${watermark}
      )`
    : undefined;

  const [{ backlog }] = await db
    .select({ backlog: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), afterWatermark));

  if (backlog - WIKI_TAIL_GUARD >= WIKI_MIN_NEW_MESSAGES) {
    await enqueueUpdateWiki(campaignId);
  }
}

function friendlyErrorMessage(error: unknown): string {
  if (error instanceof AiConfigError) {
    return error.message;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Il GM sta riprendendo fiato, riprova tra poco.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Impossibile raggiungere il GM: controlla la connessione e riprova.";
  }
  if (error instanceof Anthropic.APIError) {
    return "Il GM ha avuto un problema tecnico, riprova tra poco.";
  }
  return "Errore imprevisto durante il turno del GM.";
}
