# Prompt modulo (d) — Motore RAG (retrieval ibrido + assemblaggio contesto)

> Incolla questo documento in una conversazione nuova. È autosufficiente. Presuppone completati i moduli (a) setup, (b) campagne/documenti, (c) pipeline PDF.

## Contesto architetturale (progetto "Solo GM")

"Solo GM" è una web app personale self-hosted (locale, mono-utente): Game Master AI per GdR in solitaria. I PDF dei manuali sono già indicizzati (modulo c): testo estratto, chunk da ~1000 token con overlap, embeddings **Voyage AI `voyage-3.5` (1024 dim)** in pgvector, colonna `tsv` full-text generata.

Stack: Next.js App Router + TypeScript, PostgreSQL 16 + pgvector, ORM Drizzle. LLM: Claude via `@anthropic-ai/sdk` (usato nel modulo e; qui si prepara il contesto). Esiste `src/lib/embeddings.ts` con `embed(texts, inputType: 'document'|'query')`.

Tabelle rilevanti:

```
documents           id, title, description, doc_type(regolamento|avventura|bestiario|
                    tabelle|ambientazione|altro), status, ...
chunks              id, document_id, chunk_index, page_start, page_end, content,
                    embedding vector(1024)  [indice HNSW vector_cosine_ops],
                    tsv tsvector GENERATED to_tsvector('simple', content) [indice GIN]
campaigns           id, name, game_system, ...
campaign_documents  (campaign_id, document_id)  -- il retrieval filtra SEMPRE su questi
campaign_summaries  id, campaign_id, content, covers_until_message_id, is_user_edited,
                    created_at  -- il più recente è il riassunto attivo (modulo f)
messages            id, campaign_id, role(user|assistant), content, metadata jsonb, ...
```

## Compito di questo modulo

Due librerie pure (senza UI): `src/lib/rag.ts` (ricerca) e `src/lib/context.ts` (assemblaggio prompt per il GM). Più una route di debug.

### 1. `src/lib/rag.ts` — ricerca ibrida

```ts
type RetrievedChunk = {
  chunkId: string; documentId: string; documentTitle: string;
  docType: string; documentDescription: string;
  pageStart: number; pageEnd: number; content: string; score: number;
};
retrieve(campaignId: string, query: string, topK = 8): Promise<RetrievedChunk[]>
```

Implementazione:
1. `embed([query], 'query')` → vettore query.
2. **Due ricerche in parallelo**, entrambe filtrate sui documenti della campagna (`JOIN campaign_documents` + `documents.status = 'ready'`), limite ~30 candidati ciascuna:
   - semantica: `ORDER BY embedding <=> $vec` (distanza coseno);
   - lessicale: `WHERE tsv @@ websearch_to_tsquery('simple', $query) ORDER BY ts_rank(tsv, ...) DESC`. Se la query non produce match lessicali, va bene: si usa solo il ramo semantico.
3. **Fusione RRF** (Reciprocal Rank Fusion, k=60): `score = Σ 1/(60 + rank)` per lista in cui il chunk appare; ordina, prendi `topK`.
4. **De-duplica chunk adiacenti**: se due chunk dello stesso documento hanno `chunk_index` consecutivi, tieni il migliore (l'overlap del chunking rende l'altro ridondante).
5. Query SQL raw via Drizzle `sql` template (le espressioni pgvector/tsquery non hanno API tipizzata) con parametri bindati, mai interpolazione di stringhe.

Nota: niente reranker esterno in v1 — RRF su topK=8 è sufficiente; lascia un commento dove un reranker andrebbe inserito.

### 2. Query di retrieval "arricchita"

Il messaggio del giocatore da solo è spesso una pessima query ("attacco!"). Esporta:

```ts
buildRetrievalQuery(userMessage: string, recentMessages: {role,content}[]): string
```

v1 deterministica e gratuita: concatena il messaggio corrente con gli ultimi 2 messaggi (troncati a ~300 caratteri l'uno). Lascia predisposto (commento/flag) l'upgrade opzionale: riscrittura della query con una chiamata LLM economica.

### 3. `src/lib/context.ts` — assemblaggio prompt GM

Il prompt caching Anthropic è un **prefix-match**: ordine dal più stabile al più volatile, `cache_control: {type: "ephemeral"}` sui confini. Struttura da produrre:

```ts
buildGmContext(campaignId: string, userMessage: string): Promise<{
  system: Anthropic.TextBlockParam[];     // con cache_control
  messages: Anthropic.MessageParam[];     // storia recente + turno corrente
  retrieved: RetrievedChunk[];            // per i metadata del messaggio
}>
```

- `system[0]` — **istruzioni GM fisse** (scrivile tu, in italiano, ~400 parole): sei il Game Master; conduci la partita nello stile del sistema `{game_system}` (unica interpolazione ammessa: è stabile per campagna); descrivi scene in seconda persona, interpreta i PNG, proponi scelte senza forzare; applica le regole citando gli estratti dei manuali quando rilevanti (con riferimento a documento e pagina); se una regola non è negli estratti, dillo e improvvisa in modo coerente segnalandolo; per i tiri di dado usa lo strumento `roll_dice`, mai inventare risultati; mantieni la coerenza con il riassunto della campagna; chiudi ogni turno con la situazione aperta ("Cosa fai?"). → `cache_control`
- `system[1]` — **catalogo documenti** della campagna: per ciascuno titolo, `doc_type`, descrizione utente (serve al modello per capire che materiale esiste). → `cache_control`
- `system[2]` — **riassunto campagna**: contenuto dell'ultimo `campaign_summaries`, oppure testo "Nuova campagna, nessun evento precedente." Cambia solo quando il riassunto viene rigenerato (modulo f). → `cache_control`
- `messages` — **tutti** i messaggi dal DB **successivi a `covers_until_message_id`** (watermark della wiki, fallback riassunto legacy): di quella coda sono l'unica copia, quindi la finestra non può avere buchi. In condizioni normali resta corta (~4–10 messaggi, cadenza in `lib/wiki`); i cap (~30 messaggi o ~12000 token stimati, `chars/3.5`) sono solo un paracadute per i casi patologici e quando tagliano lo segnalano nel log. Poi il turno corrente:

```
<estratti_manuali>
  <estratto documento="Titolo" tipo="bestiario" pagine="45-46">…contenuto…</estratto>
  …
</estratti_manuali>

{messaggio del giocatore}
```

Gli estratti RAG stanno **solo nell'ultimo turno user** (sono volatili: nel system distruggerebbero la cache). Nel DB si salva solo il testo del giocatore; gli id dei chunk vanno in `metadata` (fatto dal modulo e).

### 4. Route di debug — `GET /api/campaigns/[id]/retrieve?q=...`

Autenticata; restituisce i `RetrievedChunk` in JSON (score, documento, pagine, contenuto). Serve per verificare a occhio la qualità del retrieval; una micro-pagina di test è benvenuta ma non obbligatoria.

## Criteri di accettazione

1. Con 2+ documenti indicizzati, la route di debug per una query su un termine esatto del manuale (es. il nome di un mostro) restituisce chunk pertinenti con documento/pagine corretti.
2. Una query in linguaggio naturale ("come funziona il riposo lungo?") restituisce chunk pertinenti anche senza match lessicale esatto.
3. I chunk provengono SOLO dai documenti associati alla campagna (verificato con due campagne con documenti diversi).
4. `buildGmContext` produce blocchi system con `cache_control` posizionati come sopra e il turno user col blocco `<estratti_manuali>`.
5. `npx tsc --noEmit` pulito.

Non implementare qui: la chiamata a Claude / streaming / UI chat (modulo e), la generazione del riassunto (modulo f).
