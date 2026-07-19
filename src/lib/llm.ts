import { randomUUID } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import {
  Ollama,
  type Message as OllamaMessage,
  type Tool as OllamaTool,
  type ToolCall as OllamaToolCall,
} from "ollama";
import OpenAI from "openai";

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
  switch (settings.chatProvider) {
    case "ollama":
      return createOllamaLlm(settings);
    case "deepseek":
      return createDeepseekLlm(settings);
    default:
      return createAnthropicLlm(settings);
  }
}

// Haiku non supporta il thinking adattivo (solo {type:"enabled", budget_tokens}
// o nessun thinking): mandare {type:"adaptive"} su Haiku restituisce un 400.
function supportsAdaptiveThinking(model: string): boolean {
  return !model.includes("haiku");
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
        ...(request.thinking && supportsAdaptiveThinking(request.model)
          ? { thinking: { type: "adaptive" as const } }
          : {}),
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
      let doneReason: string | null = null;

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
            doneReason = chunk.done_reason ?? null;
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

      // done_reason "length" = output troncato a num_predict: si mappa
      // su "max_tokens" come per gli altri provider.
      return {
        content,
        stopReason:
          toolCalls.length > 0
            ? "tool_use"
            : doneReason === "length"
              ? "max_tokens"
              : "end_turn",
        usage: { inputTokens, outputTokens },
      };
    },
  };
}

// DeepSeek espone un'API compatibile OpenAI: si usa l'SDK OpenAI con
// baseURL dedicata. Come per Ollama, si traduce da/verso il formato
// Anthropic nativo dell'app; il flag thinking viene ignorato (il
// ragionamento dipende dal modello scelto, es. deepseek-reasoner).
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function createDeepseekLlm(settings: AiSettings): LlmClient {
  if (!settings.deepseekApiKey) {
    throw new AiConfigError(
      "Chiave API DeepSeek non configurata: aggiungila nella pagina Impostazioni.",
    );
  }
  const client = new OpenAI({
    apiKey: settings.deepseekApiKey,
    baseURL: DEEPSEEK_BASE_URL,
  });

  return {
    async chat(request, onTextDelta) {
      const textParts: string[] = [];
      // I tool call arrivano a frammenti indicizzati: id/nome nel primo
      // chunk, gli argomenti (JSON) spezzati nei successivi.
      const toolCalls = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      let stopReason: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        const stream = await client.chat.completions.create({
          model: request.model,
          max_tokens: request.maxTokens,
          messages: toOpenAiMessages(request.system, request.messages),
          ...(request.tools
            ? { tools: request.tools.map(toOpenAiTool) }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            textParts.push(delta.content);
            onTextDelta?.(delta.content);
          }
          for (const call of delta?.tool_calls ?? []) {
            const entry = toolCalls.get(call.index) ?? {
              id: "",
              name: "",
              args: "",
            };
            if (call.id) entry.id = call.id;
            if (call.function?.name) entry.name += call.function.name;
            if (call.function?.arguments) entry.args += call.function.arguments;
            toolCalls.set(call.index, entry);
          }
          const finish = chunk.choices[0]?.finish_reason;
          if (finish) stopReason = finish;
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens;
            outputTokens = chunk.usage.completion_tokens;
          }
        }
      } catch (error) {
        throw translateDeepseekError(error, request.model);
      }

      const content: Anthropic.ContentBlockParam[] = [];
      const text = textParts.join("");
      if (text) content.push({ type: "text", text });
      for (const call of toolCalls.values()) {
        content.push({
          type: "tool_use",
          id: call.id || `deepseek-${randomUUID()}`,
          name: call.name,
          input: parseToolArguments(call.args),
        });
      }

      // finish_reason OpenAI → stop_reason Anthropic: "length" (output
      // troncato al limite) diventa "max_tokens", così i chiamanti che
      // spezzano l'output in più chiamate (modulo campagna) funzionano
      // con qualunque provider.
      const mappedStop =
        stopReason === "tool_calls"
          ? "tool_use"
          : stopReason === "length"
            ? "max_tokens"
            : "end_turn";

      return {
        content,
        stopReason: mappedStop,
        usage: { inputTokens, outputTokens },
      };
    },
  };
}

function parseToolArguments(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toOpenAiMessages(
  system: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const systemText =
    typeof system === "string"
      ? system
      : system.map((block) => block.text).join("\n\n");
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemText },
  ];

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    const calls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
    const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] =
      [];

    for (const block of message.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        calls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultText(block),
        });
      }
      // Altri blocchi (thinking, ecc.): nessun equivalente OpenAI, si scartano.
    }

    if (message.role === "assistant") {
      if (textParts.length > 0 || calls.length > 0) {
        result.push({
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("\n\n") : null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
      }
    } else if (textParts.length > 0) {
      result.push({ role: "user", content: textParts.join("\n\n") });
    }
    result.push(...toolResults);
  }

  return result;
}

function toOpenAiTool(
  tool: Anthropic.Tool,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Record<string, unknown>,
    },
  };
}

// Come per Ollama: gli errori risolvibili dall'utente (chiave sbagliata,
// credito esaurito, modello inesistente) diventano AiConfigError.
function translateDeepseekError(error: unknown, model: string): unknown {
  if (error instanceof OpenAI.APIConnectionError) {
    return new AiConfigError(
      `Impossibile raggiungere DeepSeek (${DEEPSEEK_BASE_URL}): verifica la connessione a internet.`,
    );
  }
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) {
      return new AiConfigError(
        "DeepSeek ha rifiutato la chiave API: controllala nella pagina Impostazioni.",
      );
    }
    if (error.status === 402) {
      return new AiConfigError(
        "Credito DeepSeek esaurito: ricarica il saldo su platform.deepseek.com.",
      );
    }
    if (error.status === 400 && /model/i.test(error.message)) {
      return new AiConfigError(
        `Modello DeepSeek "${model}" non valido: correggilo nella pagina Impostazioni (es. deepseek-chat o deepseek-reasoner).`,
      );
    }
  }
  return error;
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
