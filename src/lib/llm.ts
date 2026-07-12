import { randomUUID } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import {
  Ollama,
  type Message as OllamaMessage,
  type Tool as OllamaTool,
  type ToolCall as OllamaToolCall,
} from "ollama";

// Import relativi (niente alias @/): questo modulo è usato anche dal
// worker, che gira con tsx senza la risoluzione dei path di Next.
import { AiConfigError, type AiSettings } from "./settings";

// Astrazione sul provider chat (pagina Impostazioni, con fallback env).
// Il formato Anthropic (system/messages/tools) è il formato nativo
// dell'app: l'adapter Ollama traduce da/verso il suo schema, così i
// chiamanti (chat GM, archivista wiki, migliora istruzioni) restano
// identici qualunque sia il provider.
export type ChatRequest = {
  model: string;
  maxTokens: number;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  // Extended thinking: solo Anthropic, l'adapter Ollama lo ignora.
  thinking?: boolean;
};

export type ChatResult = {
  content: Anthropic.ContentBlockParam[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
};

export type LlmClient = {
  // onTextDelta riceve il testo man mano che arriva (streaming).
  chat(
    request: ChatRequest,
    onTextDelta?: (text: string) => void,
  ): Promise<ChatResult>;
};

export function createLlmClient(settings: AiSettings): LlmClient {
  return settings.chatProvider === "ollama"
    ? createOllamaLlm(settings)
    : createAnthropicLlm(settings);
}

function createAnthropicLlm(settings: AiSettings): LlmClient {
  if (!settings.anthropicApiKey) {
    throw new AiConfigError(
      "Chiave API Anthropic non configurata: aggiungila nella pagina Impostazioni.",
    );
  }
  const client = new Anthropic({ apiKey: settings.anthropicApiKey });

  return {
    async chat(request, onTextDelta) {
      const stream = client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens,
        ...(request.thinking ? { thinking: { type: "adaptive" as const } } : {}),
        system: request.system,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          onTextDelta?.(event.delta.text);
        }
      }

      const final = await stream.finalMessage();
      return {
        content: final.content,
        stopReason: final.stop_reason,
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        },
      };
    },
  };
}

function createOllamaLlm(settings: AiSettings): LlmClient {
  const client = new Ollama({
    ...(settings.ollamaHost ? { host: settings.ollamaHost } : {}),
    // La chiave serve solo per Ollama cloud (host https://ollama.com);
    // il server locale ignora l'header.
    ...(settings.ollamaApiKey
      ? { headers: { Authorization: `Bearer ${settings.ollamaApiKey}` } }
      : {}),
  });

  return {
    async chat(request, onTextDelta) {
      const textParts: string[] = [];
      const toolCalls: OllamaToolCall[] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        const stream = await client.chat({
          model: request.model,
          messages: toOllamaMessages(request.system, request.messages),
          ...(request.tools ? { tools: request.tools.map(toOllamaTool) } : {}),
          stream: true,
          options: { num_predict: request.maxTokens },
        });

        for await (const chunk of stream) {
          if (chunk.message.content) {
            textParts.push(chunk.message.content);
            onTextDelta?.(chunk.message.content);
          }
          if (chunk.message.tool_calls) {
            toolCalls.push(...chunk.message.tool_calls);
          }
          if (chunk.done) {
            inputTokens = chunk.prompt_eval_count ?? 0;
            outputTokens = chunk.eval_count ?? 0;
          }
        }
      } catch (error) {
        throw translateOllamaError(error, request.model, settings);
      }

      const content: Anthropic.ContentBlockParam[] = [];
      const text = textParts.join("");
      if (text) content.push({ type: "text", text });
      // Ollama non assegna id ai tool call: se ne genera uno per restare
      // nel formato Anthropic (tool_use/tool_result appaiati per id).
      for (const call of toolCalls) {
        content.push({
          type: "tool_use",
          id: `ollama-${randomUUID()}`,
          name: call.function.name,
          input: call.function.arguments,
        });
      }

      return {
        content,
        stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        usage: { inputTokens, outputTokens },
      };
    },
  };
}

function toOllamaMessages(
  system: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
): OllamaMessage[] {
  const systemText =
    typeof system === "string"
      ? system
      : system.map((block) => block.text).join("\n\n");
  const result: OllamaMessage[] = [{ role: "system", content: systemText }];

  // I tool_result Anthropic citano solo il tool_use_id: per compilare
  // tool_name nei messaggi role:"tool" si tiene traccia degli id visti.
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    const calls: OllamaToolCall[] = [];
    const toolResults: OllamaMessage[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolNameById.set(block.id, block.name);
        calls.push({
          function: {
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_name: toolNameById.get(block.tool_use_id),
          content: toolResultText(block),
        });
      }
      // Altri blocchi (thinking, ecc.): nessun equivalente Ollama, si scartano.
    }

    if (textParts.length > 0 || calls.length > 0) {
      result.push({
        role: message.role,
        content: textParts.join("\n\n"),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    }
    result.push(...toolResults);
  }

  return result;
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  if (typeof block.content === "string") return block.content;
  return (block.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function toOllamaTool(tool: Anthropic.Tool): OllamaTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as OllamaTool["function"]["parameters"],
    },
  };
}

// Gli errori tipici di Ollama (server spento, modello non scaricato) sono
// risolvibili dall'utente: diventano AiConfigError, che le route mostrano
// in UI così com'è. Il resto risale invariato.
function translateOllamaError(
  error: unknown,
  model: string,
  settings: AiSettings,
): unknown {
  if (error instanceof TypeError) {
    const host = settings.ollamaHost ?? "http://localhost:11434";
    return new AiConfigError(
      `Impossibile raggiungere Ollama (${host}): verifica che sia in esecuzione e che l'host nelle Impostazioni sia corretto.`,
    );
  }
  const statusCode = (error as { status_code?: number } | null)?.status_code;
  if (statusCode === 404) {
    return new AiConfigError(
      `Modello Ollama "${model}" non trovato: scaricalo con "ollama pull ${model}" o correggilo nella pagina Impostazioni.`,
    );
  }
  if (statusCode === 401 || statusCode === 403) {
    // Il client Ollama espone in `message` il motivo restituito dal
    // server (chiave non valida, account senza accesso al cloud, ecc.):
    // va mostrato, il codice HTTP da solo non basta a capire cosa correggere.
    const reason = error instanceof Error ? error.message : null;
    return new AiConfigError(
      `Ollama ha rifiutato la richiesta (${statusCode})${reason ? `: ${reason}` : ""}. Controlla la chiave API nella pagina Impostazioni.`,
    );
  }
  return error;
}
