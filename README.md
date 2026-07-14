# Solo GM

Web app personale, self-hosted in locale, che fa da **Game Master AI** per giochi di ruolo in solitaria. Carichi i PDF dei manuali, l'app li indicizza in un vector store e un'AI (Claude, oppure Ollama con modelli locali o cloud) conduce la partita in chat usando RAG sui manuali + memoria a lungo termine della campagna.

Dettagli architetturali completi in [`docs/00-architettura.md`](docs/00-architettura.md).

## Prerequisiti

- Node.js versione indicata in [`.nvmrc`](.nvmrc) (`nvm use`)
- Docker (per Postgres + pgvector)
- Una API key Anthropic — oppure Ollama (locale o cloud) come provider chat alternativo
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
   - In alternativa a Claude: `CHAT_PROVIDER=ollama` + `OLLAMA_CHAT_MODEL` (es. `llama3.3`; per Ollama cloud aggiungi `OLLAMA_API_KEY` o usa un modello con suffisso `-cloud`). Tutto configurabile anche dalla pagina Impostazioni.
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

## Provider AI: come funziona (Claude o Ollama)

Tutte le interazioni chat — la partita condotta dal GM, l'aggiornamento della wiki di campagna e "migliora istruzioni" — passano da un unico provider, selezionabile dalla pagina **Impostazioni** (sezione "Provider AI"). Le impostazioni salvate nel DB hanno la precedenza; le variabili d'ambiente restano solo come fallback.

### Claude (Anthropic) — predefinito

- Richiede `ANTHROPIC_API_KEY` (o la chiave salvata dalle Impostazioni).
- Ogni funzione ha il suo modello configurabile: partita (GM), riassunto/wiki, migliora istruzioni.

### Ollama (locale o cloud)

- Si attiva scegliendo "Ollama" come provider nelle Impostazioni (o con `CHAT_PROVIDER=ollama`).
- Usa **un solo modello chat** per tutte le funzioni, indicato nel campo "Modello chat" della sezione Ollama (o `OLLAMA_CHAT_MODEL`), es. `llama3.3`, `qwen3`, `gpt-oss:20b`.
- L'**host** è lo stesso già usato per gli embeddings (`OLLAMA_HOST`, default `http://localhost:11434`).
- **Modelli cloud**, due modi:
  - host locale con account Ollama collegato (`ollama signin`) e un modello con suffisso `-cloud`, es. `gpt-oss:120b-cloud`: è il server locale a fare da ponte;
  - host `https://ollama.com` + chiave API (campo "Chiave API Ollama" nelle Impostazioni, o `OLLAMA_API_KEY`).
- Il modello deve supportare i **tool** (tiri di dado e letture della wiki li usano): i modelli solo-embedding o senza tool calling non funzionano come GM.
- Le impostazioni Claude restano salvate quando passi a Ollama (e viceversa): puoi cambiare provider avanti e indietro senza riconfigurare nulla.
- Gli errori tipici (server Ollama spento, modello non scaricato, chiave cloud rifiutata) vengono mostrati in chat con un messaggio che spiega come rimediare.

Lato codice, l'astrazione sta in [`src/lib/llm.ts`](src/lib/llm.ts): `createLlmClient(settings)` espone la stessa interfaccia (streaming e tool inclusi) per entrambi i provider; il formato interno di messaggi e tool è quello Anthropic e l'adapter Ollama traduce da/verso il suo schema. Il provider degli **embeddings** (Voyage o Ollama) resta un'impostazione separata e indipendente dal provider chat.

## Condividere il progetto con un amico (senza esperienza tecnica)

Tutto (app, worker, Postgres e Ollama per gli embedding) gira in Docker: il tuo amico non deve installare Node, Docker Desktop compreso, né sapere cosa sono API o container.

**Cosa prepari tu prima di mandarglielo:**

1. Scarica il progetto da GitHub (Code → Download ZIP) ed estrailo in una cartella.
2. Crea un file `.env` nella cartella (copiando `.env.example`) e compila **tu** le parti tecniche:
   - `AUTH_SECRET` (genera con `openssl rand -base64 32`)
   - `EMBEDDINGS_PROVIDER=ollama`
   - `OLLAMA_EMBED_MODEL=bge-m3` (o il modello che usi tu)
   - `ANTHROPIC_API_KEY`: se gli dai la tua, tieni presente che l'uso verrà addebitato sul tuo account Anthropic — valuta se fargliene creare una sua.
   - Lascia vuoti `APP_USER_EMAIL` e `APP_USER_PASSWORD`: sono le credenziali con cui lui accederà, gliele fai scegliere.
3. Zippa la cartella (il file `.env` compilato incluso — su GitHub non ci va perché è nel `.gitignore`, quindi va passato a parte, es. per email o chat) e mandagliela.

**Cosa fa lui (Windows):**

1. Installa [Docker Desktop](https://www.docker.com/products/docker-desktop/) (installer grafico, come qualsiasi altro programma) e lo avvia.
2. Estrae la cartella che gli hai mandato.
3. Se ha lasciato vuote `APP_USER_EMAIL`/`APP_USER_PASSWORD` nel `.env`, apre quel file con il Blocco Note e sceglie email/password con cui accederà.
4. Fa doppio click su `avvia.bat` e aspetta (la primissima volta scarica anche il modello AI locale per l'indicizzazione dei PDF, può richiedere qualche minuto): al termine si apre da solo il browser su `http://localhost:3000`.
5. Per spegnere tutto, doppio click su `ferma.bat` — i dati (campagne, documenti) restano salvati e li ritrova al prossimo avvio.

**Cosa fa lui (Mac):**

1. Installa [Docker Desktop](https://www.docker.com/products/docker-desktop/) e lo avvia.
2. Estrae la cartella che gli hai mandato.
3. Se ha lasciato vuote `APP_USER_EMAIL`/`APP_USER_PASSWORD` nel `.env`, apre quel file (con TextEdit) e sceglie email/password con cui accederà.
4. Fa doppio click su `avvia.command`. **La primissima volta** macOS mostra un avviso ("non è possibile aprire perché proviene da uno sviluppatore non identificato"): in quel caso fa tasto destro (o Control+click) su `avvia.command` → **Apri** → conferma **Apri** nel popup — da lì in poi il doppio click funziona normalmente. Si apre una finestra di Terminale che mostra l'avanzamento e al termine apre da solo il browser su `http://localhost:3000`.
5. Per spegnere tutto, doppio click su `ferma.command` (stessa cosa: la prima volta va aperto con tasto destro → Apri) — i dati restano salvati e li ritrova al prossimo avvio.

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
