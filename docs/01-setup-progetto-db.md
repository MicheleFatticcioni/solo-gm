# Prompt modulo (a) — Setup progetto e database

> Incolla questo documento in una conversazione nuova. È autosufficiente.

## Contesto architetturale (progetto "Solo GM")

Stai avviando "Solo GM", una web app personale self-hosted (uso locale, mono-utente) che fa da Game Master AI per giochi di ruolo in solitaria: l'utente carica PDF di manuali/avventure, l'app li indicizza in un vector store (RAG) e Claude conduce la partita in chat mantenendo la coerenza narrativa.

Decisioni architetturali già prese — non rimetterle in discussione:

- **Stack**: Next.js (App Router, ultima stabile), TypeScript strict, Tailwind CSS. Un solo repo con **due processi**: il server Next (`npm run dev`) e un worker Node per i job pesanti (`npm run worker`, entrypoint `src/worker/index.ts`, eseguito con `tsx`).
- **DB**: PostgreSQL 16 con estensione **pgvector**, in docker-compose. ORM **Drizzle** (`src/db/schema.ts`, migrazioni con drizzle-kit).
- **Coda job**: **pg-boss** sullo stesso Postgres (niente Redis).
- **LLM**: Claude via `@anthropic-ai/sdk` (usato nei moduli successivi, qui solo dipendenza + env).
- **Embeddings**: Voyage AI `voyage-3.5`, vettori a **1024 dimensioni** (Anthropic non offre embeddings). Qui conta solo per la colonna `vector(1024)`.
- **Storage PDF**: filesystem locale `./storage/uploads/` (gitignored).
- **Auth**: Auth.js v5 (`next-auth@beta`) con provider **Credentials**, utente singolo seedato in DB, hash con `bcryptjs`.

## Compito di questo modulo

Creare lo scaffolding completo del progetto: repo Next.js, docker-compose per Postgres+pgvector, schema Drizzle con migrazioni, autenticazione funzionante, layout base protetto.

### 1. Scaffolding

- `create-next-app` con TypeScript, Tailwind, App Router, alias `@/*` → `src/*`.
- Dipendenze: `drizzle-orm`, `drizzle-kit`, `postgres` (driver), `pg-boss`, `@anthropic-ai/sdk`, `next-auth@beta`, `bcryptjs`, `zod`, `tsx` (dev).
- Script in `package.json`: `dev`, `build`, `worker` (`tsx src/worker/index.ts`), `db:generate`, `db:migrate`, `db:seed`.
- `.env.example` con: `DATABASE_URL`, `AUTH_SECRET`, `APP_USER_EMAIL`, `APP_USER_PASSWORD` (per il seed), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_GM=claude-opus-4-8`, `ANTHROPIC_MODEL_SUMMARY=claude-opus-4-8`, `VOYAGE_API_KEY`, `EMBEDDINGS_PROVIDER=voyage`.

### 2. docker-compose

Servizio `postgres` con immagine `pgvector/pgvector:pg16`, volume persistente, porta 5432, healthcheck.

### 3. Schema Drizzle (`src/db/schema.ts`)

```
users               id uuid PK default random, email text unique not null,
                    password_hash text not null, created_at timestamptz default now
documents           id uuid PK, user_id FK→users, filename text, title text not null,
                    storage_path text not null,
                    description text not null,      -- descrizione utente (routing RAG)
                    doc_type enum: regolamento|avventura|bestiario|tabelle|ambientazione|altro,
                    status enum: uploaded|processing|ready|error (default uploaded),
                    error_message text, page_count int, chunk_count int,
                    created_at timestamptz
chunks              id uuid PK, document_id FK→documents ON DELETE CASCADE,
                    chunk_index int not null, page_start int, page_end int,
                    content text not null,
                    embedding vector(1024),          -- tipo custom pgvector
                    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
campaigns           id uuid PK, user_id FK→users, name text not null,
                    game_system text not null, created_at timestamptz,
                    last_played_at timestamptz
campaign_documents  campaign_id FK→campaigns CASCADE, document_id FK→documents CASCADE,
                    PK (campaign_id, document_id)    -- N:N, documenti riusabili tra campagne
messages            id uuid PK, campaign_id FK→campaigns CASCADE,
                    role enum: user|assistant, content text not null,
                    input_tokens int, output_tokens int,
                    metadata jsonb,                  -- chunk recuperati, tiri di dado
                    created_at timestamptz
campaign_summaries  id uuid PK, campaign_id FK→campaigns CASCADE, content text not null,
                    covers_until_message_id uuid FK→messages,
                    is_user_edited boolean default false, created_at timestamptz
                    -- append-only: il più recente per campagna è quello attivo
```

Note implementative:
- Per `vector(1024)` e `tsvector` definisci custom types Drizzle (oppure colonna generata via migrazione SQL manuale se drizzle-kit non supporta la GENERATED column: va bene aggiungere SQL a mano nel file di migrazione).
- Nella prima migrazione includi: `CREATE EXTENSION IF NOT EXISTS vector;`
- Indici: HNSW su `chunks.embedding` con `vector_cosine_ops`; GIN su `chunks.tsv`; B-tree su `messages(campaign_id, created_at)`; B-tree su `chunks(document_id)`.

### 4. Client DB e seed

- `src/db/index.ts`: client `postgres` + Drizzle, singleton compatibile con l'hot-reload di Next.
- `scripts` di seed (`db:seed`): crea l'utente da `APP_USER_EMAIL`/`APP_USER_PASSWORD` (hash bcrypt) se non esiste.

### 5. Auth

- Auth.js v5 con Credentials provider: verifica email+password contro `users`, sessione JWT.
- Config in `src/auth.ts`, route handler `src/app/api/auth/[...nextauth]/route.ts`.
- `middleware.ts`: tutte le route protette tranne `/login` e gli asset.
- Pagina `/login` minimale (form email+password, errori visibili).

### 6. Layout base

- Layout autenticato con header (nome app, link "Dashboard" e "Documenti", logout).
- `/dashboard` placeholder ("Nessuna campagna — verrà implementato nel modulo successivo").
- `src/worker/index.ts` placeholder: avvia pg-boss, logga "worker pronto", nessun job ancora registrato.

## Criteri di accettazione

1. `docker compose up -d` + `npm run db:migrate` + `npm run db:seed` completano senza errori; in DB esistono tutte le tabelle, l'estensione `vector` e gli indici.
2. `npm run dev`: visitando `/dashboard` da non autenticato → redirect a `/login`; con le credenziali del seed si entra; logout funziona.
3. `npm run worker` parte e resta in ascolto senza errori.
4. `npx tsc --noEmit` pulito.

Non implementare in questo modulo: upload PDF, chunking, chat, RAG, summarization (moduli successivi). Mantieni il codice essenziale e tipato; niente librerie UI oltre Tailwind.
