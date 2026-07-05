# Prompt modulo (e) — Interfaccia chat e turno di gioco

> Incolla questo documento in una conversazione nuova. È autosufficiente. Presuppone completati i moduli (a)–(d); in particolare il modulo (d) espone `buildGmContext(campaignId, userMessage)` e `retrieve(...)` in `src/lib/context.ts` / `src/lib/rag.ts`.

## Contesto architetturale (progetto "Solo GM")

"Solo GM" è una web app personale self-hosted (locale, mono-utente): Game Master AI per GdR in solitaria. Manuali PDF già indicizzati (pgvector, retrieval ibrido pronto). Ora si costruisce la chat di gioco.

Stack: Next.js App Router + TypeScript + Tailwind; PostgreSQL + Drizzle; coda pg-boss (`src/lib/queue.ts`) con worker separato. LLM: **Claude via `@anthropic-ai/sdk`**, modello da env `ANTHROPIC_MODEL_GM` (default `claude-opus-4-8`).

Regole d'uso dell'API Anthropic (vincolanti, API 2026):
- **Sempre streaming**: `client.messages.stream(...)`; `max_tokens: 8000` per le risposte del GM.
- `thinking: { type: "adaptive" }`. **Niente** `temperature`/`top_p`/`top_k` e niente `budget_tokens` (rifiutati con 400 sui modelli correnti).
- Errori: usare le classi tipizzate del SDK (`Anthropic.RateLimitError`, `Anthropic.APIError`, ...), mai string-matching.
- Il modulo (d) fornisce già `system` (blocchi con `cache_control` — istruzioni GM, catalogo documenti, riassunto campagna) e `messages` (storia recente + turno corrente con estratti RAG). Non alterare quell'ordine: il caching è un prefix-match.

Tabelle rilevanti:

```
messages            id, campaign_id (CASCADE), role(user|assistant), content,
                    input_tokens, output_tokens, metadata jsonb, created_at
campaigns           id, name, game_system, last_played_at, ...
campaign_summaries  id, campaign_id, content, covers_until_message_id, ...
```

## Compito di questo modulo

### 1. Tool `roll_dice` (server-side)

Un LLM non sa tirare dadi: il GM deve **dichiarare** i tiri e il server li esegue con RNG vero (`crypto.getRandomValues`). Definisci il tool per l'API Anthropic:

```ts
{
  name: "roll_dice",
  description: "Tira dadi per prove, attacchi, tabelle casuali. Usalo SEMPRE quando le regole richiedono un tiro: non inventare mai risultati.",
  input_schema: { type: "object",
    properties: {
      notation: { type: "string", description: "Notazione dadi, es. '1d20+5', '3d6', '1d100'" },
      reason:   { type: "string", description: "Cosa rappresenta il tiro" }
    },
    required: ["notation", "reason"], additionalProperties: false },
  strict: true
}
```

Implementa in `src/lib/dice.ts` il parser della notazione (`NdM+K`/`NdM-K`, anche più gruppi sommati) con risultato `{ rolls: number[], modifier, total }` + unit test.

### 2. Route di chat — `POST /api/campaigns/[id]/chat`

Body `{ message: string }`. Risposta: **stream SSE** verso il browser. Flusso:

1. Autentica e verifica proprietà campagna; salva il messaggio `user` (solo il testo del giocatore).
2. `buildGmContext(campaignId, message)` → `system`, `messages`, `retrieved`.
3. **Loop agentico manuale con streaming** (il tool runner non basta perché dobbiamo inoltrare i delta):
   - `client.messages.stream({ model, max_tokens: 8000, thinking: {type:"adaptive"}, system, messages, tools: [rollDice] })`;
   - inoltra i `text_delta` al client come eventi SSE `{type:"text", text}`;
   - a fine stream `await stream.finalMessage()`; se `stop_reason === "tool_use"`: esegui ogni `roll_dice`, manda al client un evento `{type:"dice", notation, reason, rolls, total}`, appendi il turno assistant (content completo) + un turno user con tutti i `tool_result` (in un SOLO messaggio user), e riapri lo stream. Ripeti finché `end_turn` (limite di sicurezza: 5 iterazioni).
4. A `end_turn`: salva il messaggio `assistant` con il testo completo, `input_tokens`/`output_tokens` sommati su tutte le iterazioni (da `usage`), `metadata = { chunkIds, dice: [...] }`; aggiorna `campaigns.last_played_at`.
5. **Trigger summarization**: calcola i token accumulati dai messaggi successivi a `covers_until_message_id` del riassunto attivo (somma di `input_tokens`+`output_tokens` salvati, fallback `chars/3.5`); se > `SUMMARY_TRIGGER_TOKENS` (env, default 25000) → `queue.send('update-summary', { campaignId })`. Il job è implementato nel modulo (f): qui solo l'enqueue.
6. Evento SSE finale `{type:"done", messageId}`; su errore `{type:"error", message}` user-friendly (es. rate limit → "Il GM sta riprendendo fiato, riprova tra poco").

### 3. Cronologia — `GET /api/campaigns/[id]/messages?before=...&limit=50`

Paginazione a cursore all'indietro, per lo scroll verso l'alto.

### 4. UI — `/campaigns/[id]/play` (sostituisce il placeholder)

Client component, layout a tutta altezza:
- Storico messaggi (caricamento iniziale + "carica precedenti" in alto); bolle giocatore a destra, GM a sinistra renderizzato con `react-markdown`.
- Streaming: testo del GM che si accumula in tempo reale leggendo lo stream SSE (fetch + ReadableStream); indicatore "Il GM sta scrivendo…" prima del primo delta.
- Eventi dado renderizzati come chip inline: 🎲 `1d20+5 → [14]+5 = 19 (attacco del goblin)`.
- Composer in basso: textarea auto-espandibile, invio con Enter (Shift+Enter a-capo), disabilitata durante lo streaming.
- **Input vocale**: pulsante microfono con Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition`, `lang: 'it-IT'`, `interimResults: true` che riempiono la textarea). Se l'API non è disponibile (Firefox), nascondi il pulsante.
- Stato vuoto (prima dell'intro): suggerimento tipo "Scrivi il primo prompt, es. «Iniziamo una campagna sandbox: generami l'introduzione»".
- Header con nome campagna e link al dettaglio.

## Criteri di accettazione

1. Primo messaggio in una campagna con manuali `ready`: l'intro del GM arriva in streaming visibile e coerente col materiale caricato; ricaricando la pagina la conversazione persiste.
2. Una scena di combattimento produce chip dado con valori generati dal server (verificabile: distribuzione plausibile su più tiri, mai fuori range).
3. `messages` in DB ha `input_tokens`/`output_tokens` valorizzati e `metadata.chunkIds` popolato.
4. Superata la soglia token, in coda pg-boss compare un job `update-summary` (basta verificarne l'enqueue).
5. Dettatura vocale funzionante su Chrome; pulsante assente su browser non supportati.
6. `npx tsc --noEmit` pulito; test di `dice.ts` verdi.

Non implementare qui: il job di summarization e la UI del riassunto (modulo f).
