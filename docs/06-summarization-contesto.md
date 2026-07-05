# Prompt modulo (f) — Summarization e gestione del contesto

> Incolla questo documento in una conversazione nuova. È autosufficiente. Presuppone completati i moduli (a)–(e). In particolare: la chat (modulo e) già enqueua un job pg-boss `update-summary { campaignId }` quando i token non riassunti superano `SUMMARY_TRIGGER_TOKENS`, e l'assemblaggio del contesto (modulo d, `src/lib/context.ts`) già inserisce il riassunto attivo come blocco `system[2]` con `cache_control` e manda in chiaro solo i messaggi successivi a `covers_until_message_id`.

## Contesto architetturale (progetto "Solo GM")

"Solo GM" è una web app personale self-hosted (locale, mono-utente): Game Master AI per GdR in solitaria. La cronologia chat cresce senza limiti, quindi la memoria a lungo termine è un **riassunto progressivo** rigenerato in background: a ogni chiamata al GM si invia riassunto + ultimi messaggi in chiaro + estratti RAG, mai l'intera storia.

Stack: Next.js App Router + TypeScript + Tailwind; PostgreSQL + Drizzle; worker Node (`src/worker/index.ts`) con pg-boss. LLM: Claude via `@anthropic-ai/sdk`, modello da env `ANTHROPIC_MODEL_SUMMARY` (default `claude-opus-4-8`); sempre streaming (`client.messages.stream(...).finalMessage()`), `thinking: {type:"adaptive"}`, niente `temperature`/`budget_tokens` (400 sui modelli correnti).

Tabelle rilevanti:

```
messages            id, campaign_id, role(user|assistant), content,
                    input_tokens, output_tokens, metadata, created_at
campaign_summaries  id, campaign_id (CASCADE), content,
                    covers_until_message_id FK→messages,
                    is_user_edited boolean, created_at
                    -- append-only: il più recente per campagna è quello ATTIVO
```

Semantica di `covers_until_message_id`: il riassunto attivo copre tutta la storia **fino a quel messaggio incluso**; il contesto della chat manda in chiaro solo i messaggi successivi.

## Compito di questo modulo

### 1. Job worker — `update-summary`

`src/worker/jobs/update-summary.ts`, registrato in `src/worker/index.ts` (singleton per campagna: usa la `singletonKey` di pg-boss = campaignId per evitare due run concorrenti sulla stessa campagna):

1. Carica il riassunto attivo (se esiste) e i messaggi successivi a `covers_until_message_id` (tutti, in ordine).
2. **Guardia di ritardo**: escludi dalla finestra da riassumere gli ultimi ~6 messaggi (resteranno in chiaro nel contesto chat — così il riassunto non "insegue" la conversazione in corso). Se dopo l'esclusione restano meno di ~10 messaggi nuovi, esci senza fare nulla.
3. Chiama Claude con un prompt di **aggiornamento incrementale**: dai in input il riassunto precedente (o "nessuno") + la trascrizione dei nuovi messaggi (`Giocatore:` / `GM:`), e chiedi un riassunto aggiornato che integri i nuovi eventi. Output **strutturato in sezioni fisse**, in italiano, max ~1500 token:

   ```
   ## Sinossi          (2-4 frasi: dove siamo nella storia)
   ## Eventi chiave    (cronologico, sintetico)
   ## PNG              (nome — chi è, atteggiamento verso il PG, stato)
   ## Luoghi           (visitati/noti, dettagli rilevanti)
   ## Stato del party  (PG: ferite, risorse, equipaggiamento notevole, obiettivi)
   ## Fili aperti      (missioni in corso, misteri, promesse, minacce)
   ## Decisioni importanti del giocatore
   ```

   Istruzioni chiave nel prompt: non inventare nulla che non sia nella trascrizione o nel riassunto precedente; preservare le informazioni del vecchio riassunto ancora rilevanti; comprimere gli eventi remoti più di quelli recenti; se il riassunto precedente era stato modificato dall'utente (`is_user_edited`), trattarlo come fonte di verità anche dove contraddice la trascrizione più vecchia.
4. INSERT nuova riga `campaign_summaries` con `covers_until_message_id` = ultimo messaggio incluso nella finestra riassunta, `is_user_edited = false`.
5. Non cancellare i vecchi riassunti (storico utile) e **mai i messaggi**: la cronologia integrale resta in DB.
6. Errori: logga e lascia fallire il job (retry pg-boss, 2 tentativi); un fallimento non deve mai bloccare la chat.

### 2. API riassunto

- `GET /api/campaigns/[id]/summary` → riassunto attivo `{ id, content, coversUntilMessageId, isUserEdited, createdAt }` oppure 204.
- `PUT /api/campaigns/[id]/summary` body `{ content }` → INSERT di una nuova riga con lo stesso `covers_until_message_id` dell'attivo e `is_user_edited = true` (append-only: niente update in place).
- `POST /api/campaigns/[id]/summary/regenerate` → enqueue immediato di `update-summary` (bypass soglia; il job applica comunque la guardia del punto 2.2).

### 3. UI — "Memoria della campagna"

Nella pagina dettaglio campagna (`/campaigns/[id]`) e raggiungibile anche dalla chat (link/pannello laterale in `/play`):
- Visualizza il riassunto attivo renderizzato in markdown, con data e badge "modificato manualmente" se `is_user_edited`.
- Pulsante "Modifica": textarea con il markdown grezzo, salva → PUT. Avviso sotto l'editor: "Il riassunto è la memoria a lungo termine del GM: correggi qui gli errori di trama e verranno rispettati nei turni successivi."
- Pulsante "Aggiorna ora" → POST regenerate, con feedback di stato (polling del GET finché compare un riassunto con `createdAt` più recente).
- Stato vuoto: "Il riassunto verrà generato automaticamente quando la storia cresce."

### 4. Esportazione cronologia

`GET /api/campaigns/[id]/export` → file markdown scaricabile con: intestazione campagna, riassunto attivo, poi l'intera cronologia (`**Giocatore:**` / `**GM:**` con timestamp). Link "Esporta partita" nel dettaglio campagna.

## Criteri di accettazione

1. Dopo una sessione di gioco che supera la soglia, il worker produce un riassunto con tutte le sezioni previste e `covers_until_message_id` corretto; il turno di chat successivo invia in chiaro solo i messaggi non coperti (verificabile dai token di input, che calano).
2. Modifico a mano il riassunto (es. correggo il nome di un PNG): il GM rispetta la correzione nei turni successivi e il riassunto rigenerato dopo altra storia la preserva.
3. "Aggiorna ora" produce un nuovo riassunto senza duplicare eventi né perdere i fili aperti del precedente.
4. Due job concorrenti sulla stessa campagna non producono riassunti duplicati (singleton pg-boss).
5. L'export markdown contiene riassunto + cronologia completa.
6. `npx tsc --noEmit` pulito.

Nota di evoluzione (non implementare ora, lascia un commento nel codice): lo "Stato del party" potrebbe diventare una scheda strutturata jsonb aggiornata via tool use, come fonte di verità separata dal riassunto testuale.
