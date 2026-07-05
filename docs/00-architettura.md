# Solo GM — Architettura generale

Web app personale, self-hosted in locale, che fa da **Game Master AI** per giochi di ruolo in solitaria. L'utente carica i PDF dei manuali, l'app li indicizza in un vector store e Claude conduce la partita in chat usando RAG sui manuali + memoria a lungo termine della campagna.

Questo documento fissa le decisioni architetturali. I sei documenti in `docs/01..06` sono prompt autosufficienti per implementare i moduli in conversazioni separate, e richiamano queste decisioni.

---

## 1. Decisioni di alto livello (con motivazione)

| Decisione | Scelta | Perché |
|---|---|---|
| Backend | **Solo Next.js (App Router) + un processo worker Node nello stesso repo** | Le API routes di Next coprono CRUD, upload e streaming SSE della chat senza problemi. Un Express separato duplicherebbe auth, config e deploy senza benefici. L'unico lavoro incompatibile con le API routes (elaborazione PDF da 100+ pagine, summarization) va in un **worker separato** (`npm run worker`), non in un secondo web server. |
| Coda job | **pg-boss** (code su Postgres) | Evita Redis: per un progetto personale una dipendenza infrastrutturale in meno. pg-boss dà retry, stato dei job e scheduling usando lo stesso Postgres già presente. |
| Database | **PostgreSQL 16 + pgvector**, via docker-compose | Un solo datastore per dati relazionali, vettori e full-text search. A questa scala (decine di PDF, ~10⁴–10⁵ chunk) pgvector con indice HNSW è più che sufficiente; un vector DB dedicato (Qdrant, Weaviate) aggiungerebbe solo operatività. |
| ORM | **Drizzle** | Migrazioni SQL-first, supporto semplice ai tipi custom (`vector`, `tsvector`), leggero. |
| Embeddings | **Voyage AI `voyage-3.5`** (1024 dim, multilingue) | ⚠️ **Anthropic non offre un endpoint embeddings** — serve un provider esterno. Voyage è quello raccomandato da Anthropic, economico, multilingue (manuali in IT e EN). Alternativa 100% locale: `bge-m3` via Ollama (stessa interfaccia astratta in `lib/embeddings.ts`, si cambia via env). |
| LLM | **Claude via `@anthropic-ai/sdk`**, modello default `claude-opus-4-8` | Modello Opus corrente: il migliore per coerenza narrativa lunga e aderenza alle regole. Configurabile via env (`ANTHROPIC_MODEL_GM`, `ANTHROPIC_MODEL_SUMMARY`) — scendere a `claude-sonnet-5` ($3/$15 vs $5/$25 per MTok) è una decisione di costo tua, non un default. Thinking adattivo (`thinking: {type: "adaptive"}`), streaming sempre. |
| Ricerca | **Ibrida: pgvector (coseno, HNSW) + full-text Postgres (tsvector), fusione RRF** | I manuali GdR sono pieni di termini esatti (nomi di incantesimi, tabelle, sigle) dove il full-text batte il semantico; le domande narrative vanno meglio col semantico. RRF combina i due senza tuning. |
| Storage PDF | Filesystem locale `./storage/uploads/{documentId}.pdf` | App locale mono-utente: S3/MinIO sarebbe overkill. |
| Auth | **Auth.js v5 (NextAuth), provider Credentials**, utente singolo in DB | Il minimo che soddisfa "login utente" senza servizi esterni. |
| Voce | **Web Speech API** (dettatura nel browser, Chrome/Edge) | Zero costi e zero backend. Limite: non funziona su Firefox — accettabile per uso personale. |
| Parsing PDF | **unpdf** (basato su PDF.js, puro Node) | Estrae testo pagina per pagina senza binari nativi. PDF scansionati (immagini) sono fuori scope v1 → stato `error` con messaggio chiaro. |

---

## 2. Schema DB

```
users               id uuid PK, email unique, password_hash, created_at
documents           id uuid PK, user_id FK, filename, title, storage_path,
                    description text            -- descrizione utente, usata nel routing RAG
                    doc_type enum(regolamento|avventura|bestiario|tabelle|ambientazione|altro),
                    status enum(uploaded|processing|ready|error), error_message,
                    page_count int, chunk_count int, created_at
chunks              id uuid PK, document_id FK (cascade), chunk_index int,
                    page_start int, page_end int, content text,
                    embedding vector(1024),     -- pgvector, dim = voyage-3.5
                    tsv tsvector GENERATED (to_tsvector('simple', content))
campaigns           id uuid PK, user_id FK, name, game_system, created_at, last_played_at
campaign_documents  campaign_id FK + document_id FK, PK composita
                    -- N:N — un documento è riusabile in più campagne
messages            id uuid PK, campaign_id FK (cascade), role enum(user|assistant),
                    content text, input_tokens int, output_tokens int,
                    metadata jsonb,             -- id chunk recuperati, tiri di dado
                    created_at
campaign_summaries  id uuid PK, campaign_id FK (cascade), content text,
                    covers_until_message_id FK, -- fin dove arriva il riassunto
                    is_user_edited bool, created_at
                    -- append-only: l'ultimo per campaign è quello attivo
```

Indici: HNSW su `chunks.embedding` (`vector_cosine_ops`), GIN su `chunks.tsv`, B-tree su `messages(campaign_id, created_at)`. pg-boss crea da sé il proprio schema `pgboss`.

---

## 3. Struttura cartelle

```
solo-gm/
├── docker-compose.yml            # postgres con pgvector
├── drizzle.config.ts
├── storage/uploads/              # PDF (gitignored)
├── src/
│   ├── app/
│   │   ├── login/
│   │   ├── dashboard/            # elenco campagne + "Nuova partita"
│   │   ├── documents/            # libreria documenti globale
│   │   ├── campaigns/[id]/       # dettaglio campagna
│   │   │   └── play/             # interfaccia chat
│   │   └── api/
│   │       ├── auth/[...nextauth]/
│   │       ├── documents/        # POST upload, GET lista
│   │       ├── documents/[id]/   # GET stato, DELETE
│   │       ├── campaigns/        # CRUD + associazione documenti
│   │       └── campaigns/[id]/
│   │           ├── chat/         # POST → streaming SSE
│   │           ├── messages/     # GET cronologia paginata
│   │           └── summary/      # GET / PUT (modifica manuale)
│   ├── db/                       # schema.ts, index.ts, migrations/
│   ├── lib/
│   │   ├── anthropic.ts          # client + costanti modello
│   │   ├── embeddings.ts         # astrazione Voyage/Ollama
│   │   ├── chunking.ts
│   │   ├── rag.ts                # ricerca ibrida + RRF
│   │   ├── context.ts            # assemblaggio prompt GM
│   │   └── queue.ts              # pg-boss (send)
│   └── worker/
│       ├── index.ts              # entrypoint `npm run worker`
│       └── jobs/
│           ├── process-pdf.ts
│           └── update-summary.ts
└── .env.local
```

Due processi in sviluppo: `npm run dev` (Next) e `npm run worker`.

---

## 4. Flussi dati

### Upload → indicizzazione (asincrono)
```
UI upload (PDF + titolo + descrizione + doc_type)
 → API: salva file su disco, riga in documents (status=uploaded),
   job pg-boss "process-pdf" → risponde subito 201
 → Worker: status=processing → unpdf estrae testo per pagina
   → chunking (~1000 token, overlap 15%, traccia pagine)
   → embeddings Voyage a batch → INSERT chunks → status=ready
   (errore → status=error + error_message)
 → UI: polling GET /api/documents/[id] finché ready
```

### Turno di chat (RAG + streaming)
```
Messaggio giocatore → POST /api/campaigns/[id]/chat
 1. salva messaggio user
 2. retrieval ibrido sui soli documenti della campagna (top ~8 chunk, RRF)
 3. assembla prompt (vedi §5) → claude, streaming SSE verso il browser
 4. (tool use: roll_dice — dadi tirati dal server, non "immaginati" dal modello)
 5. fine stream: salva messaggio assistant + usage token + metadata
 6. se token non riassunti > soglia → job "update-summary"
```

### Summarization (background)
```
Worker: prende summary attivo + messaggi successivi a covers_until_message_id
 → Claude genera/aggiorna il riassunto strutturato (eventi, PNG, stato del
   party, fili aperti) → nuova riga campaign_summaries
L'utente può vederlo/correggerlo (PUT → is_user_edited=true)
```

---

## 5. Struttura del prompt e caching

Il prompt caching Anthropic è un **prefix-match**: qualunque byte cambi invalida tutto ciò che segue. Quindi ordine dal più stabile al più volatile:

```
system[0]  Istruzioni GM (fisse, MAI interpolare dati dinamici)   ← cache_control
system[1]  Catalogo documenti campagna (titolo+tipo+descrizione)  ← cache_control
system[2]  Riassunto campagna (cambia solo quando rigenerato)     ← cache_control
messages   Ultimi N messaggi (~20 / 8k token)                     ← cache_control sull'ultimo turno precedente
           Ultimo messaggio user = <estratti_manuali> RAG (volatili, per-turno)
           + testo del giocatore   → DOPO tutti i breakpoint
```

Gli estratti RAG **non vanno mai nel system prompt**: cambiano a ogni turno e distruggerebbero la cache. Vanno iniettati nell'ultimo turno user. Nel DB si salva solo il testo del giocatore, non gli estratti (ricostruibili dai metadata).

---

## 6. Librerie

| Scopo | Libreria |
|---|---|
| LLM | `@anthropic-ai/sdk` |
| Embeddings | Voyage AI REST (`voyage-3.5`) / `ollama` come fallback locale |
| Parsing PDF | `unpdf` |
| Stima token | `count_tokens` API per calibrare; a runtime euristica `chars/3.5` + usage reale delle risposte |
| Coda | `pg-boss` |
| ORM | `drizzle-orm` + `drizzle-kit` |
| Auth | `next-auth@beta` (Auth.js v5) + `bcryptjs` |
| UI | Tailwind CSS; markdown risposta GM: `react-markdown` |
| Validazione | `zod` |

---

## 7. Criticità e alternative valutate

1. **Embeddings ≠ Anthropic.** È il punto più fragile del piano se ci si aspettava un solo provider. Voyage richiede una seconda API key; l'alternativa locale (Ollama + bge-m3) rende tutto offline ma richiede di rifare gli embeddings se si cambia modello (dimensioni diverse → colonna vector da migrare). L'astrazione `lib/embeddings.ts` isola il rischio, ma **la scelta va fatta prima di indicizzare** i primi PDF.
2. **PDF scansionati o con layout complessi** (tabelle a doppia colonna, statblock). unpdf estrae testo lineare: le tabelle degli incontri possono uscire mescolate. Mitigazione v1: chunking con overlap generoso + descrizione utente del documento per instradare. Se diventa un problema reale: OCR/parsing strutturato (es. via Claude vision sulle pagine incriminate) come miglioria successiva, costa ~pochi $ per manuale.
3. **I dadi.** Un LLM non genera numeri casuali affidabili. Soluzione: tool `roll_dice` lato server (RNG vero) esposto via tool use — il GM dichiara il tiro, il server lo esegue, il risultato torna nel contesto. Senza questo, il "GM" bara sistematicamente.
4. **Deriva dello stato di gioco** (PF, inventario, risorse): il riassunto testuale aiuta ma non è una fonte di verità. V1: sezione "Stato del party" dentro il riassunto, correggibile a mano. Evoluzione possibile: scheda strutturata (jsonb) aggiornata via tool use.
5. **Costi.** Con Opus 4.8 un turno con ~15k token di contesto costa ~$0.08–0.10 di input senza cache; con la struttura di caching sopra la parte stabile scende a ~0.1×. La summarization periodica riduce il contesto ma ha un suo costo. Se il costo per sessione dà fastidio: `ANTHROPIC_MODEL_GM=claude-sonnet-5` — decisione tua.
6. **Web Speech API** solo su Chrome/Edge. Alternativa (non v1): upload audio + trascrizione esterna.
7. **Copyright**: i manuali indicizzati restano in locale, uso personale — nessun contenuto viene pubblicato.

---

## 8. Ordine di implementazione

1. `01-setup-progetto-db.md` — scaffolding, docker, schema, auth
2. `02-gestione-giochi-sessioni.md` — CRUD campagne/documenti, dashboard
3. `03-upload-pipeline-pdf.md` — upload, worker, chunking, embeddings
4. `04-motore-rag.md` — ricerca ibrida + assemblaggio contesto
5. `05-interfaccia-chat.md` — chat streaming, dadi, voce
6. `06-summarization-contesto.md` — memoria a lungo termine

Ogni documento è pensato per essere incollato in una conversazione nuova, senza memoria di questa.
