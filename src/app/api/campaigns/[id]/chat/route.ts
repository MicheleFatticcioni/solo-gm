import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { campaigns, campaignSummaries, messages } from "@/db/schema";
import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { buildGmContext } from "@/lib/context";
import { rollDice, rollDiceTool, type RollDiceInput } from "@/lib/dice";
import { getCampaign } from "@/lib/queries";
import { enqueueUpdateSummary } from "@/lib/queue";
import { getUserId } from "@/lib/session";
import { AiConfigError, createAnthropicClient, getAiSettings } from "@/lib/settings";

const bodySchema = z.object({ message: z.string().trim().min(1) });

// Iterazioni massime del loop agentico (stream → tool_use → riapri):
// oltre questa soglia si tronca il turno per sicurezza.
const MAX_ITERATIONS = 5;

type DiceEvent = {
  notation: string;
  reason: string;
  rolls: number[];
  total: number;
};

// Eventi SSE verso il browser.
type ChatEvent =
  | { type: "text"; text: string }
  | ({ type: "dice" } & DiceEvent)
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

// Loop agentico manuale con streaming: il tool runner del SDK non basta
// perché i text_delta vanno inoltrati al client man mano che arrivano.
async function runGmTurn(
  campaignId: string,
  context: Awaited<ReturnType<typeof buildGmContext>>,
  settings: Awaited<ReturnType<typeof getAiSettings>>,
  send: (event: ChatEvent) => void,
): Promise<string> {
  const client = createAnthropicClient(settings);
  const conversation = [...context.messages];
  const textParts: string[] = [];
  const dice: DiceEvent[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = client.messages.stream({
      model: settings.modelGm,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: context.system,
      messages: conversation,
      tools: [rollDiceTool],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        send({ type: "text", text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    inputTokens += final.usage.input_tokens;
    outputTokens += final.usage.output_tokens;
    for (const block of final.content) {
      if (block.type === "text") textParts.push(block.text);
    }

    if (final.stop_reason !== "tool_use") break;

    // Turno assistant completo (thinking/testo/tool_use inclusi) + un
    // SOLO messaggio user con tutti i tool_result, poi si riapre lo stream.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of final.content) {
      if (block.type !== "tool_use" || block.name !== "roll_dice") continue;
      toolResults.push(executeRollDice(block, send, dice));
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
      },
    })
    .returning({ id: messages.id });

  await db
    .update(campaigns)
    .set({ lastPlayedAt: new Date() })
    .where(eq(campaigns.id, campaignId));

  await maybeTriggerSummary(campaignId);

  return saved.id;
}

function executeRollDice(
  block: Anthropic.ToolUseBlock,
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

// Se la storia non coperta dal riassunto attivo supera la soglia,
// accoda l'aggiornamento del riassunto (job del modulo f).
async function maybeTriggerSummary(campaignId: string): Promise<void> {
  const threshold = Number(process.env.SUMMARY_TRIGGER_TOKENS ?? 25000);

  const [summary] = await db
    .select({ coversUntilMessageId: campaignSummaries.coversUntilMessageId })
    .from(campaignSummaries)
    .where(eq(campaignSummaries.campaignId, campaignId))
    .orderBy(sql`${campaignSummaries.createdAt} desc`)
    .limit(1);

  const afterSummary = summary?.coversUntilMessageId
    ? gt(
        messages.createdAt,
        sql`(select created_at from messages where id = ${summary.coversUntilMessageId})`,
      )
    : undefined;

  const rows = await db
    .select({
      inputTokens: messages.inputTokens,
      outputTokens: messages.outputTokens,
      contentLength: sql<number>`length(${messages.content})`,
    })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), afterSummary));

  const accumulated = rows.reduce((sum, row) => {
    const saved = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    return sum + (saved > 0 ? saved : Math.ceil(row.contentLength / CHARS_PER_TOKEN));
  }, 0);

  if (accumulated > threshold) {
    await enqueueUpdateSummary(campaignId);
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
