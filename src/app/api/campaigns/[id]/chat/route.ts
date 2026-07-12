import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { campaigns, campaignSummaries, messages } from "@/db/schema";
import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { buildGmContext } from "@/lib/context";
import { rollDice, rollDiceTool, type RollDiceInput } from "@/lib/dice";
import { getCampaign } from "@/lib/queries";
import { enqueueUpdateWiki } from "@/lib/queue";
import { createLlmClient } from "@/lib/llm";
import { getUserId } from "@/lib/session";
import { AiConfigError, chatModel, getAiSettings } from "@/lib/settings";
import {
  getWikiPage,
  isWikiFolder,
  readWikiPageTool,
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

// Eventi SSE verso il browser.
type ChatEvent =
  | { type: "text"; text: string }
  | ({ type: "dice" } & DiceEvent)
  | ({ type: "wiki" } & WikiReadEvent)
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
        tools: [rollDiceTool, readWikiPageTool],
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
        chunkIds: context.retrieved.map((c) => c.chunkId),
        dice,
        wikiReads,
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

// Token stimati quando input/output non sono salvati (messaggi user).
const CHARS_PER_TOKEN = 3.5;

// Se la storia non coperta dalla wiki supera la soglia, accoda
// l'aggiornamento della wiki (job del modulo g). Finché la wiki non è
// popolata il watermark è quello del riassunto legacy: alla prima
// esecuzione il job usa il riassunto come seed.
async function maybeTriggerWikiUpdate(campaignId: string): Promise<void> {
  const threshold = Number(process.env.SUMMARY_TRIGGER_TOKENS ?? 25000);

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

  const afterWatermark = watermark
    ? gt(
        messages.createdAt,
        sql`(select created_at from messages where id = ${watermark})`,
      )
    : undefined;

  const rows = await db
    .select({
      inputTokens: messages.inputTokens,
      outputTokens: messages.outputTokens,
      contentLength: sql<number>`length(${messages.content})`,
    })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), afterWatermark));

  const accumulated = rows.reduce((sum, row) => {
    const saved = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    return sum + (saved > 0 ? saved : Math.ceil(row.contentLength / CHARS_PER_TOKEN));
  }, 0);

  if (accumulated > threshold) {
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
