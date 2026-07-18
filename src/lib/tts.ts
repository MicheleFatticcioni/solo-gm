import OpenAI from "openai";

// Import relativi (niente alias @/): questo modulo segue la convenzione
// di lib/settings.ts e lib/llm.ts.
import { AiConfigError, type AiSettings } from "./settings";

// Sintesi vocale dei messaggi del GM. Come per la chat, l'astrazione
// copre più provider: ElevenLabs (REST) e OpenAI (SDK). Il risultato è
// uno stream MP3 pronto da restituire al client.
export type SpeechResult = {
  contentType: string;
  stream: ReadableStream<Uint8Array>;
};

// I messaggi del GM sono markdown: per la lettura ad alta voce si
// tolgono i segni di formattazione lasciando solo il testo (con la
// punteggiatura, che guida la prosodia del TTS).
export function markdownToSpeechText(markdown: string): string {
  return (
    markdown
      // blocchi di codice: si legge solo il contenuto
      .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      // immagini e link: resta il testo alternativo/visibile
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // intestazioni, citazioni e marcatori di lista a inizio riga
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      // separatori orizzontali
      .replace(/^\s*([-*_]\s*){3,}$/gm, "")
      // enfasi: grassetto prima del corsivo per gli asterischi annidati
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export async function synthesizeSpeech(
  settings: AiSettings,
  text: string,
): Promise<SpeechResult> {
  if (settings.ttsProvider === "openai") {
    return synthesizeOpenai(settings, text);
  }
  return synthesizeElevenlabs(settings, text);
}

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

async function synthesizeElevenlabs(
  settings: AiSettings,
  text: string,
): Promise<SpeechResult> {
  if (!settings.elevenlabsApiKey) {
    throw new AiConfigError(
      "Chiave API ElevenLabs non configurata: aggiungila nella pagina Impostazioni.",
    );
  }

  const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(
    settings.elevenlabsVoiceId,
  )}/stream?output_format=mp3_44100_128`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": settings.elevenlabsApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: settings.elevenlabsTtsModel,
      }),
    });
  } catch {
    throw new AiConfigError(
      "Impossibile raggiungere ElevenLabs: verifica la connessione a internet.",
    );
  }

  if (!res.ok || !res.body) {
    throw await translateElevenlabsError(res, settings);
  }

  return { contentType: "audio/mpeg", stream: res.body };
}

// Gli errori risolvibili dall'utente (chiave sbagliata, quota esaurita,
// voce o modello inesistenti) diventano AiConfigError, mostrato in UI.
async function translateElevenlabsError(
  res: Response,
  settings: AiSettings,
): Promise<unknown> {
  const body = await res.text().catch(() => "");
  if (res.status === 401) {
    return new AiConfigError(
      "ElevenLabs ha rifiutato la chiave API: controllala nella pagina Impostazioni.",
    );
  }
  if (res.status === 402 || /quota/i.test(body)) {
    return new AiConfigError(
      "Crediti ElevenLabs esauriti: controlla il piano su elevenlabs.io.",
    );
  }
  if (res.status === 404 || /voice_not_found/i.test(body)) {
    return new AiConfigError(
      `Voce ElevenLabs "${settings.elevenlabsVoiceId}" non trovata: correggila nella pagina Impostazioni.`,
    );
  }
  if (res.status === 400 || res.status === 422) {
    return new AiConfigError(
      `Richiesta rifiutata da ElevenLabs: verifica modello ("${settings.elevenlabsTtsModel}") e voce nella pagina Impostazioni.`,
    );
  }
  return new Error(`ElevenLabs ha risposto ${res.status}: ${body.slice(0, 200)}`);
}

// gpt-4o-mini-tts accetta al massimo 2000 token di input (~4000
// caratteri italiani): i messaggi lunghi si spezzano sui paragrafi e i
// segmenti MP3 si concatenano nello stream (i player li leggono di fila).
const OPENAI_TTS_CHUNK_CHARS = 3000;

export function splitForSpeech(
  text: string,
  maxChars = OPENAI_TTS_CHUNK_CHARS,
): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    // paragrafo oltre il limite: si spezza a frasi (caso limite)
    const pieces =
      paragraph.length > maxChars
        ? (paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph])
        : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > maxChars) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function synthesizeOpenai(
  settings: AiSettings,
  text: string,
): Promise<SpeechResult> {
  if (!settings.openaiApiKey) {
    throw new AiConfigError(
      "Chiave API OpenAI non configurata: aggiungila nella pagina Impostazioni.",
    );
  }
  const client = new OpenAI({ apiKey: settings.openaiApiKey });

  const chunks = splitForSpeech(text);

  const speak = async (input: string): Promise<Response> => {
    try {
      return await client.audio.speech.create({
        model: settings.openaiTtsModel,
        voice: settings.openaiTtsVoice,
        input,
        ...(settings.openaiTtsInstructions
          ? { instructions: settings.openaiTtsInstructions }
          : {}),
        response_format: "mp3",
      });
    } catch (error) {
      throw translateOpenaiError(error, settings);
    }
  };

  // Il primo segmento si richiede subito: gli errori di configurazione
  // emergono prima di aprire lo stream verso il client (che a quel punto
  // ha già ricevuto lo status 200).
  const first = await speak(chunks[0]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Mentre un segmento viene inviato al client, il successivo è
        // già in generazione: si evita il silenzio tra un segmento e
        // l'altro nella riproduzione.
        let current = first;
        for (let i = 1; i <= chunks.length; i++) {
          const next = i < chunks.length ? speak(chunks[i]) : null;
          if (current.body) {
            for await (const part of current.body as unknown as AsyncIterable<Uint8Array>) {
              controller.enqueue(part);
            }
          }
          if (!next) break;
          current = await next;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return { contentType: "audio/mpeg", stream };
}

function translateOpenaiError(error: unknown, settings: AiSettings): unknown {
  if (error instanceof OpenAI.APIConnectionError) {
    return new AiConfigError(
      "Impossibile raggiungere OpenAI: verifica la connessione a internet.",
    );
  }
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) {
      return new AiConfigError(
        "OpenAI ha rifiutato la chiave API: controllala nella pagina Impostazioni.",
      );
    }
    if (error.status === 429) {
      return new AiConfigError(
        "Quota OpenAI esaurita o troppe richieste: controlla il saldo su platform.openai.com.",
      );
    }
    if (
      error.status === 400 &&
      /model|voice/i.test(error.message)
    ) {
      return new AiConfigError(
        `Modello ("${settings.openaiTtsModel}") o voce ("${settings.openaiTtsVoice}") OpenAI non validi: correggili nella pagina Impostazioni.`,
      );
    }
  }
  return error;
}
