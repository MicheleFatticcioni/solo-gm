# Prompt modulo (c) — Upload PDF e pipeline di elaborazione

> Incolla questo documento in una conversazione nuova. È autosufficiente. Presuppone completati i moduli (a) setup e (b) gestione campagne/documenti.

## Contesto architetturale (progetto "Solo GM")

"Solo GM" è una web app personale self-hosted (locale, mono-utente): Game Master AI per GdR in solitaria. L'utente carica PDF di manuali (anche 100+ pagine, più file per gioco), l'app li indicizza in Postgres+pgvector e Claude conduce la partita via RAG.

Già in piedi:
- Next.js App Router + TypeScript; **worker Node separato** (`src/worker/index.ts`, avviato con `npm run worker`) con **pg-boss** su Postgres per i job asincroni; helper `src/lib/queue.ts`.
- PostgreSQL 16 + pgvector, ORM Drizzle. Storage PDF: filesystem locale `./storage/uploads/{documentId}.pdf`.
- Libreria documenti e associazione N:N alle campagne già implementate (moduli a/b); il form "Nuova partita" e la pagina `/documents` hanno placeholder `TODO(modulo-c)` per l'upload.

Tabelle rilevanti:

```
documents  id, user_id, filename, title, storage_path, description,
           doc_type(regolamento|avventura|bestiario|tabelle|ambientazione|altro),
           status(uploaded|processing|ready|error), error_message,
           page_count, chunk_count, created_at
chunks     id, document_id (CASCADE), chunk_index, page_start, page_end,
           content, embedding vector(1024),
           tsv tsvector GENERATED (to_tsvector('simple', content)) STORED
           -- indici: HNSW cosine su embedding, GIN su tsv
```

Decisioni vincolanti:
- **Parsing PDF**: `unpdf` (estrazione testo per pagina, puro Node, niente binari).
- **Embeddings**: ⚠️ Anthropic NON offre embeddings. Provider primario **Voyage AI**, modello `voyage-3.5`, **1024 dimensioni**, endpoint REST `https://api.voyageai.com/v1/embeddings` con header `Authorization: Bearer $VOYAGE_API_KEY`, body `{ model, input: string[], input_type: "document" | "query" }`. Astrazione in `src/lib/embeddings.ts`: `embed(texts: string[], inputType: 'document'|'query'): Promise<number[][]>`, provider selezionato da env `EMBEDDINGS_PROVIDER` (`voyage` | `ollama`; per `ollama` usa il pacchetto `ollama` con un modello configurabile `OLLAMA_EMBED_MODEL`, e documenta che cambiare provider richiede reindicizzare).
- L'elaborazione avviene **solo nel worker**, mai nelle API routes: l'upload risponde subito e la UI mostra lo stato.

## Compito di questo modulo

### 1. API di upload — `POST /api/documents`

- `multipart/form-data`: `file` (PDF), `title`, `description` (obbligatoria: l'utente descrive contenuto e uso, es. "tabelle incontri casuali per le terre selvagge"), `docType`.
- Validazioni: MIME/estensione PDF, dimensione max configurabile (`MAX_PDF_MB`, default 100).
- Flusso: crea riga `documents` (status `uploaded`) → scrive il file in `./storage/uploads/{id}.pdf` (stream, non buffer intero in memoria se evitabile) → `queue.send('process-pdf', { documentId })` → 201 col documento.
- Upload multiplo gestito lato client con richieste sequenziali per file (più semplice e robusto di un multipart multiplo).

### 2. Job worker — `process-pdf`

In `src/worker/jobs/process-pdf.ts`, registrato in `src/worker/index.ts` (concurrency 1–2, retry pg-boss: 2 tentativi con backoff):

1. `status = processing`.
2. Estrai testo per pagina con `unpdf`. Se il testo totale è < ~200 caratteri per pagina media → il PDF è probabilmente scansionato: `status = error`, `error_message = "PDF senza testo estraibile (scansione?). OCR non supportato."`
3. **Chunking** (`src/lib/chunking.ts`): splitter ricorsivo che rispetta i confini (prima doppio a-capo, poi a-capo, poi frase), target ~1000 token per chunk con overlap ~15%. Stima token con euristica `Math.ceil(chars / 3.5)` (manuali IT/EN). Ogni chunk mantiene `page_start`/`page_end` reali. Scrivi unit test essenziali dello splitter (casi: testo corto, paragrafi lunghi, confini di pagina).
4. **Embeddings a batch**: max 128 testi per chiamata Voyage, retry con backoff esponenziale su 429/5xx, rispetto di eventuale header `retry-after`.
5. INSERT dei chunks a batch (transazione per batch); se il job riparte, prima `DELETE FROM chunks WHERE document_id = ...` per idempotenza.
6. `status = ready`, aggiorna `page_count` e `chunk_count`. Su eccezione: `status = error` + `error_message` sintetico.

### 3. UI

- Componente `DocumentUploader` che sostituisce i placeholder `TODO(modulo-c)` (flusso "Nuova partita" e pagina `/documents`): drag&drop o file picker multiplo; per ogni file un mini-form (titolo precompilato dal filename, descrizione, tipo) prima dell'invio.
- Stato di elaborazione visibile: le liste documenti fanno polling (ogni ~3s, solo se esiste almeno un documento `uploaded`/`processing`) su `GET /api/documents` finché tutto è `ready`/`error`. Badge coerenti con il modulo (b).
- Un documento appena caricato dal flusso "Nuova partita" viene associato automaticamente alla campagna in creazione.
- Pulsante "Riprova" sui documenti in `error` (re-enqueue del job).

## Criteri di accettazione

1. Carico un PDF di 100+ pagine: la risposta HTTP arriva subito, il documento appare `processing`, e con il worker attivo passa a `ready` con `page_count`/`chunk_count` valorizzati; in DB i chunks hanno embedding non nulli e pagine plausibili.
2. Carico 3 PDF insieme dal flusso "Nuova partita": tutti processati, tutti associati alla campagna.
3. Con il worker spento l'upload funziona comunque e il documento resta `uploaded`; riavviando il worker viene processato.
4. Un PDF corrotto/scansionato finisce in `error` con messaggio leggibile, e "Riprova" re-enqueua.
5. Rilanciare il job sullo stesso documento non duplica i chunks.
6. `npx tsc --noEmit` pulito; test dello splitter verdi.

Non implementare qui: ricerca/RAG (modulo d), chat (modulo e).
