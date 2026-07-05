# Solo GM

Web app personale, self-hosted in locale, che fa da **Game Master AI** per giochi di ruolo in solitaria. Carichi i PDF dei manuali, l'app li indicizza in un vector store e Claude conduce la partita in chat usando RAG sui manuali + memoria a lungo termine della campagna.

Dettagli architetturali completi in [`docs/00-architettura.md`](docs/00-architettura.md).

## Prerequisiti

- Node.js versione indicata in [`.nvmrc`](.nvmrc) (`nvm use`)
- Docker (per Postgres + pgvector)
- Una API key Anthropic
- Una API key Voyage AI (embeddings) — oppure Ollama in locale come alternativa

## Avvio

1. Installa le dipendenze:

   ```bash
   npm install
   ```

2. Avvia Postgres (con estensione pgvector):

   ```bash
   docker compose up -d
   ```

3. Copia `.env.example` in `.env.local` e compila le variabili:

   ```bash
   cp .env.example .env.local
   ```

   Note:
   - `AUTH_SECRET`: genera con `openssl rand -base64 32`.
   - `APP_USER_EMAIL` / `APP_USER_PASSWORD`: credenziali dell'utente singolo creato dal seed.
   - `ANTHROPIC_API_KEY`: per il GM e la summarization.
   - `VOYAGE_API_KEY` (o `EMBEDDINGS_PROVIDER=ollama` + `OLLAMA_EMBED_MODEL`): per gli embeddings dei manuali.

4. Applica le migrazioni e crea l'utente:

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

5. Avvia i due processi in sviluppo (in terminali separati):

   ```bash
   npm run dev      # Next.js — http://localhost:3000
   npm run worker   # worker pg-boss (processing PDF, summarization)
   ```

6. Accedi su [http://localhost:3000](http://localhost:3000) con le credenziali del seed.

## Script utili

| Comando | Descrizione |
|---|---|
| `npm run dev` | Server Next.js in sviluppo |
| `npm run worker` | Worker per job asincroni (upload PDF, summarization) |
| `npm run build` / `npm run start` | Build e avvio in produzione |
| `npm run db:generate` | Genera una nuova migrazione Drizzle da `src/db/schema.ts` |
| `npm run db:migrate` | Applica le migrazioni al database |
| `npm run db:seed` | Crea l'utente applicativo da `APP_USER_EMAIL`/`APP_USER_PASSWORD` |
| `npm run test` | Esegue i test in `src/lib/*.test.ts` |
| `npm run lint` | Lint del progetto |

## Struttura

Vedi la sezione "Struttura cartelle" in [`docs/00-architettura.md`](docs/00-architettura.md) e i documenti `docs/01..06` per il dettaglio di ciascun modulo.
