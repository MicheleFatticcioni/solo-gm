"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import ReactMarkdown from "react-markdown";

type DiceEvent = {
  notation: string;
  reason: string;
  rolls: number[];
  total: number;
};

// Un messaggio è una sequenza di parti: durante lo streaming testo e
// tiri di dado si alternano nell'ordine in cui arrivano dal server.
type Part = { type: "text"; text: string } | ({ type: "dice" } & DiceEvent);

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
};

type ApiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata: { dice?: DiceEvent[] } | null;
};

type SseEvent =
  | { type: "text"; text: string }
  | ({ type: "dice" } & DiceEvent)
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

// Id locale del messaggio assistant in corso di streaming, sostituito
// dall'id reale all'evento done.
const DRAFT_ID = "draft";

const PAGE_SIZE = 50;

// Nei messaggi persistiti la posizione dei tiri nel testo è persa:
// si rende il testo e poi i chip dado in coda.
function toChatMessage(message: ApiMessage): ChatMessage {
  const parts: Part[] = [];
  if (message.content) parts.push({ type: "text", text: message.content });
  for (const dice of message.metadata?.dice ?? []) {
    parts.push({ type: "dice", ...dice });
  }
  return { id: message.id, role: message.role, parts };
}

export function Chat({
  campaignId,
  campaignName,
}: {
  campaignId: string;
  campaignName: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // true finché l'utente non scrolla verso l'alto: si segue lo streaming.
  const stickToBottomRef = useRef(true);
  // distanza dal fondo da ripristinare dopo un prepend di storia.
  const restoreFromBottomRef = useRef<number | null>(null);

  // Caricamento iniziale della cronologia.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/campaigns/${campaignId}/messages?limit=${PAGE_SIZE}`,
        );
        if (!res.ok) throw new Error();
        const body: { messages: ApiMessage[]; hasMore: boolean } =
          await res.json();
        if (cancelled) return;
        setMessages(body.messages.map(toChatMessage));
        setHasMore(body.hasMore);
      } catch {
        if (!cancelled) setError("Errore nel caricamento della cronologia.");
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  // Autoscroll durante lo streaming; dopo un "carica precedenti" si
  // ripristina invece la posizione relativa al fondo.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreFromBottomRef.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFromBottomRef.current;
      restoreFromBottomRef.current = null;
    } else if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  async function loadOlder() {
    const oldest = messages[0];
    const el = scrollRef.current;
    if (!oldest || !el) return;
    setLoadingHistory(true);
    try {
      const res = await fetch(
        `/api/campaigns/${campaignId}/messages?limit=${PAGE_SIZE}&before=${oldest.id}`,
      );
      if (!res.ok) throw new Error();
      const body: { messages: ApiMessage[]; hasMore: boolean } =
        await res.json();
      restoreFromBottomRef.current = el.scrollHeight - el.scrollTop;
      setMessages((current) => [...body.messages.map(toChatMessage), ...current]);
      setHasMore(body.hasMore);
    } catch {
      setError("Errore nel caricamento dei messaggi precedenti.");
    } finally {
      setLoadingHistory(false);
    }
  }

  // Aggiunge una parte al messaggio assistant in streaming (creandolo
  // alla prima parte); i text_delta consecutivi si fondono.
  function appendToDraft(part: Part) {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (!last || last.id !== DRAFT_ID) {
        return [...current, { id: DRAFT_ID, role: "assistant", parts: [part] }];
      }
      const parts = [...last.parts];
      const tail = parts[parts.length - 1];
      if (part.type === "text" && tail?.type === "text") {
        parts[parts.length - 1] = { type: "text", text: tail.text + part.text };
      } else {
        parts.push(part);
      }
      return [...current.slice(0, -1), { ...last, parts }];
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming || loadingHistory) return;

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setError(null);
    setStreaming(true);
    stickToBottomRef.current = true;
    setMessages((current) => [
      ...current,
      {
        id: `local-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text }],
      },
    ]);

    try {
      const res = await fetch(`/api/campaigns/${campaignId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Errore nell'invio del messaggio");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            handleEvent(JSON.parse(line.slice(6)) as SseEvent);
          }
        }
      }
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Errore di rete durante il turno del GM.",
      );
    } finally {
      setStreaming(false);
      // un draft rimasto senza id reale (errore a metà) resta visibile
      // ma non deve collidere col prossimo turno
      setMessages((current) =>
        current.map((m) =>
          m.id === DRAFT_ID ? { ...m, id: `local-${Date.now()}-gm` } : m,
        ),
      );
      textareaRef.current?.focus();
    }
  }

  function handleEvent(event: SseEvent) {
    switch (event.type) {
      case "text":
        appendToDraft({ type: "text", text: event.text });
        break;
      case "dice":
        appendToDraft({
          type: "dice",
          notation: event.notation,
          reason: event.reason,
          rolls: event.rolls,
          total: event.total,
        });
        break;
      case "done":
        setMessages((current) =>
          current.map((m) => (m.id === DRAFT_ID ? { ...m, id: event.messageId } : m)),
        );
        break;
      case "error":
        setError(event.message);
        break;
    }
  }

  const draftPending =
    streaming && messages[messages.length - 1]?.id !== DRAFT_ID;

  return (
    <div className="flex h-[calc(100vh-8.5rem)] flex-col">
      <header className="flex items-baseline gap-3 border-b border-zinc-800 pb-3">
        <h1 className="text-xl font-semibold">{campaignName}</h1>
        <Link
          href={`/campaigns/${campaignId}`}
          className="text-sm text-zinc-400 hover:text-white"
        >
          Dettaglio campagna
        </Link>
        <Link
          href={`/campaigns/${campaignId}#memoria`}
          className="text-sm text-zinc-400 hover:text-white"
        >
          Memoria della campagna
        </Link>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 space-y-4 overflow-y-auto py-4"
      >
        {hasMore && (
          <div className="text-center">
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingHistory}
              className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              {loadingHistory ? "Caricamento…" : "Carica precedenti"}
            </button>
          </div>
        )}

        {!loadingHistory && messages.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="max-w-md text-zinc-500">
              Scrivi il primo prompt, es.{" "}
              <em>
                «Iniziamo una campagna sandbox: generami l&apos;introduzione»
              </em>
            </p>
          </div>
        )}

        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {draftPending && (
          <p className="text-sm text-zinc-500">
            <span className="animate-pulse">Il GM sta scrivendo…</span>
          </p>
        )}
      </div>

      {error && <p className="pb-2 text-sm text-red-400">{error}</p>}

      <Composer
        input={input}
        setInput={setInput}
        onSend={send}
        disabled={streaming || loadingHistory}
        textareaRef={textareaRef}
      />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-white">
          {message.parts.map((part) =>
            part.type === "text" ? part.text : null,
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-3 rounded-2xl rounded-bl-sm bg-zinc-900 px-4 py-3">
        {message.parts.map((part, i) =>
          part.type === "text" ? (
            <div
              key={i}
              className="space-y-2 text-[15px] leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-400 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_em]:italic [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5"
            >
              <ReactMarkdown>{part.text}</ReactMarkdown>
            </div>
          ) : (
            <DiceChip key={i} dice={part} />
          ),
        )}
      </div>
    </div>
  );
}

// 🎲 1d20+5 → [14]+5 = 19 (attacco del goblin)
function DiceChip({ dice }: { dice: DiceEvent }) {
  const rollsSum = dice.rolls.reduce((sum, roll) => sum + roll, 0);
  const modifier = dice.total - rollsSum;
  const modifierLabel =
    modifier === 0 ? "" : modifier > 0 ? `+${modifier}` : `${modifier}`;

  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 rounded-full border border-amber-800/60 bg-amber-950/40 px-3 py-1 text-sm text-amber-200">
      <span aria-hidden>🎲</span>
      <code>
        {dice.notation} → [{dice.rolls.join(", ")}]{modifierLabel} ={" "}
        {dice.total}
      </code>
      <span className="text-amber-200/70">({dice.reason})</span>
    </span>
  );
}

// Sottoinsieme della Web Speech API usato qui: i tipi non sono in
// lib.dom, e su Firefox l'API manca del tutto (il pulsante si nasconde).
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function Composer({
  input,
  setInput,
  onSend,
  disabled,
  textareaRef,
}: {
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  // SSR-safe: il server rende senza pulsante, il client lo mostra solo
  // se la Web Speech API esiste (assente ad es. su Firefox).
  const speechSupported = useSyncExternalStore(
    () => () => {},
    () => getSpeechRecognition() !== null,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.lang = "it-IT";
    recognition.interimResults = true;
    recognition.continuous = true;
    // il dettato si accoda al testo già digitato
    const base = input.trim();
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(base ? `${base} ${transcript}` : transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  return (
    <form
      className="flex items-end gap-2 border-t border-zinc-800 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
        rows={1}
        disabled={disabled}
        placeholder="Cosa fai?"
        className="max-h-[200px] flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 outline-none focus:border-indigo-500 disabled:opacity-50"
      />
      {speechSupported && (
        <button
          type="button"
          onClick={toggleMic}
          disabled={disabled}
          title={listening ? "Ferma la dettatura" : "Detta il messaggio"}
          className={`rounded-lg border px-3 py-2.5 disabled:opacity-50 ${
            listening
              ? "animate-pulse border-red-700 bg-red-950/50 text-red-300"
              : "border-zinc-700 hover:border-zinc-500"
          }`}
        >
          🎤
        </button>
      )}
      <button
        type="submit"
        disabled={disabled || input.trim().length === 0}
        className="rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        Invia
      </button>
    </form>
  );
}
