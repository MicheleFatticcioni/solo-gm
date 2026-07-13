# Prompt modulo (g) — Wiki della campagna (memoria ibrida)

> Incolla questo documento in una conversazione nuova. È autosufficiente. Presuppone completati i moduli (a)–(f). Sostituisce il riassunto progressivo monolitico (modulo f) con una **memoria ibrida**: un nucleo fisso sempre in contesto + una wiki di pagine recuperate on demand via tool use. I dati legacy (`campaign_summaries`) restano in DB come seed e fallback.

## Contesto architetturale (progetto "Solo GM")

"Solo GM" è una web app personale self-hosted (locale, mono-utente): Game Master AI per GdR in solitaria. Fino al modulo (f) la memoria a lungo termine era un riassunto progressivo cappato a ~1500 token: costo fisso piccolo ma qualità che degrada su campagne lunghe (il riassunto è costretto a dimenticare). Questo modulo la sostituisce con una wiki per campagna: la memoria scala senza degradare e il GM legge solo ciò che serve alla scena.

Stack: Next.js App Router + TypeScript + Tailwind; PostgreSQL + Drizzle; worker Node (`src/worker/index.ts`) con pg-boss. LLM: Claude via `@anthropic-ai/sdk`, sempre streaming (`client.messages.stream(...).finalMessage()`), `thinking: {type:"adaptive"}`, niente `temperature`. Il loop agentico della chat è manuale (SSE verso il browser, vedi `src/app/api/campaigns/[id]/chat/route.ts`).

## Design della memoria ibrida

Due livelli, pensati attorno al prompt caching Anthropic (prefix-match):

1. **Nucleo sempre in contesto** (blocco system con `cache_control`, stabile tra turni):
   - la pagina **core** (`core/panoramica`): sinossi, stato del party, fili aperti, decisioni importanti — ciò che serve *sempre*;
   - tutte le pagine **note** (note temporanee): vanno sempre in chiaro perché il GM non sa di doverle cercare (es. "il PG ha messo una sedia contro la porta");
   - l'**indice della wiki**: per ogni pagina `cartella/slug — titolo: descrizione` (una riga), generato da query, mai manutenuto dall'LLM.
2. **Recupero selettivo via tool use**: il GM ha un tool `read_wiki_page { folder, slug }` con cui legge al massimo 2–3 pagine rilevanti per turno (PNG in scena, luogo attuale, scheda per il combattimento), scelte leggendo l'indice.

Cartelle (enum chiuso, niente cartelle libere):

| folder   | contenuto                                                                    |
| -------- | ---------------------------------------------------------------------------- |
| `core`   | SOLO `core/panoramica` (una pagina per campagna, sempre in contesto)          |
| `pg`     | un PG per pagina: descrizione, background + scheda meccanica in una sezione   |
| `npc`    | un PNG per pagina: chi è, atteggiamento verso il party, obiettivi + scheda    |
| `luoghi` | un luogo per pagina: descrizione, PNG presenti (come `[[link]]`)              |
| `eventi` | eventi chiave / decisioni importanti che impattano il futuro                  |
| `storia` | andamento generale della trama (archi, capitoli)                              |
| `note`   | note temporanee a scadenza breve, sempre in contesto, da POTARE quando scadono |

Scelta deliberata: PG e scheda PG (e PNC/scheda PNG) sono **una sola pagina** con la scheda in una sezione `## Scheda` — due file per la stessa entità si desincronizzano. Ogni entità ha una sola fonte di verità: le altre pagine la citano solo come `[[link]]`.

Formato pagina (markdown, il frontmatter NON si salva nel content: title/description/updated sono colonne):

```
## Contenuto libero in markdown
Link interni: [[folder/slug]] (es. [[npc/lord-anor]], [[luoghi/torre-grigia]])
```

Slug: kebab-case `[a-z0-9-]{1,64}`, unico per (campagna, cartella).

## Compito di questo modulo

### 1. Schema DB (Drizzle + migrazione)

```
wiki_folder enum: core|pg|npc|luoghi|eventi|storia|note

wiki_pages  id uuid PK, campaign_id FK→campaigns (CASCADE),
            folder wiki_folder, slug text, title text,
            description text (una riga, usata nell'indice),
            content text (markdown),
            created_at, updated_at timestamptz
            UNIQUE (campaign_id, folder, slug)
            INDEX (campaign_id, folder)

campaigns   + wiki_covers_until_message_id uuid NULL FK→messages
            (watermark: la wiki copre la storia fino a quel messaggio incluso)
```

Le pagine si aggiornano **in place** (a differenza dei summary append-only): la storia integrale resta comunque nei `messages`.

### 2. Libreria `src/lib/wiki.ts`

- Costanti cartelle + etichette italiane; validazione slug/folder (zod-friendly).
- `getWikiPages(campaignId)`, `getWikiPage(campaignId, folder, slug)`, upsert e delete.
- `buildWikiIndex(pages)`: indice testuale raggruppato per cartella, una riga per pagina.
- `buildMemoryBlock(campaignId)`: nucleo (core + note + indice) come stringa per il blocco system; se la wiki è vuota, fallback al riassunto legacy attivo (`getActiveSummary`).
- `readWikiPageTool`: definizione `Anthropic.Tool` di `read_wiki_page { folder, slug }` (strict), con descrizione che impone: prima l'indice, max 2–3 pagine per turno, non rileggere pagine già lette nel turno.

### 3. Contesto GM (`src/lib/context.ts`)

- Il blocco system `## Riassunto della campagna` diventa `## Memoria della campagna` con il nucleo di `buildMemoryBlock`, sempre con `cache_control` (il nucleo cambia solo quando il worker o l'utente scrivono pagine: la cache regge tra turni consecutivi).
- Le istruzioni GM fisse guadagnano una sezione `## Memoria e wiki`: come usare l'indice, il tool, il limite di letture, e che le pagine lette valgono più della memoria implicita.
- La storia recente in chiaro ora parte da `campaigns.wiki_covers_until_message_id` (fallback: `covers_until` del summary legacy se la wiki non è ancora popolata).

### 4. Chat (`src/app/api/campaigns/[id]/chat/route.ts`)

- Aggiungere `readWikiPageTool` ai tools; nel loop agentico eseguire `read_wiki_page` (lettura DB; pagina inesistente → `tool_result` con `is_error` e suggerimento di consultare l'indice).
- Nuovo evento SSE `{ type: "wiki"; folder; slug; title }` così la UI mostra "consulta la wiki: …". Salvare le letture nei metadata del messaggio assistant.
- `MAX_ITERATIONS` da 5 a 8 (dadi + letture wiki nello stesso turno).
- `maybeTriggerSummary` → `maybeTriggerWikiUpdate`: conteggio dei messaggi dopo il watermark wiki; enqueue di `update-wiki` quando quelli archiviabili (oltre la guardia di coda) raggiungono la soglia minima del job (costanti condivise `WIKI_TAIL_GUARD`/`WIKI_MIN_NEW_MESSAGES` in `lib/wiki`). Niente soglia a token: sarebbe più larga della storia in chiaro e aprirebbe un buco di messaggi invisibili al GM.

### 5. Job worker `update-wiki` (sostituisce `update-summary`)

`src/worker/jobs/update-wiki.ts`, coda pg-boss `update-wiki` (policy `stately`, `singletonKey` = campaignId, retry 2). Il vecchio job e la vecchia coda si rimuovono dal codice (la tabella `campaign_summaries` resta).

1. Watermark = `campaigns.wiki_covers_until_message_id`; carica i messaggi successivi. **Guardia**: escludi gli ultimi ~4 (restano in chiaro in chat) e chiudi la finestra su un turno del GM, così la storia in chiaro riparte da un messaggio user; se ne restano meno di ~6, esci (costanti condivise `WIKI_TAIL_GUARD`/`WIKI_MIN_NEW_MESSAGES` in `lib/wiki`). Il backlog non archiviato non apre mai buchi: la storia in chiaro della chat è ancorata al watermark e lo copre tutto (i cap di `context.ts` sono solo un paracadute, con warning nel log quando tagliano). Prima esecuzione (watermark NULL e wiki vuota): usa il riassunto legacy attivo come materiale di seed oltre alla trascrizione.
2. Loop agentico "archivista" con tools:
   - `upsert_wiki_page { folder, slug, title, description, content }`
   - `delete_wiki_page { folder, slug }` (per le note scadute)
   - `read_wiki_page { folder, slug }`
   In input: indice completo + contenuto di core e note + trascrizione nuovi eventi (`Giocatore:`/`GM:`). Istruzioni chiave: non inventare; una entità = una pagina (aggiorna, non duplicare); `core/panoramica` va sempre mantenuta aggiornata e densa di fatti concreti, inclusi scena in corso e ultimi sviluppi (~800 token max); descrizioni di una riga pensate per scegliere dall'indice; potare le note temporanee superate; leggere una pagina prima di riscriverla se non è già nell'input; comprimere gli eventi remoti più dei recenti. Max ~20 iterazioni.
3. A fine loop aggiorna il watermark all'ultimo messaggio della finestra; se durante il run (lento con i modelli locali) si è già riaccumulata una finestra archiviabile, riaccoda subito il job invece di aspettare il turno successivo. Errori: logga e lascia fallire (retry pg-boss); un fallimento non blocca mai la chat.
4. Modello: `settings.modelSummary` (riusa l'impostazione esistente).

### 6. API wiki

- `GET  /api/campaigns/[id]/wiki` → albero `{ folders: [{ folder, pages: [{ slug, title, description, updatedAt }] }] }`.
- `POST /api/campaigns/[id]/wiki` body `{ folder, slug, title, description, content }` → crea (409 se esiste).
- `GET/PUT/DELETE /api/campaigns/[id]/wiki/[folder]/[slug]` → pagina singola; PUT body `{ title, description, content }`.
- `POST /api/campaigns/[id]/wiki/regenerate` → enqueue `update-wiki` (bypass soglia; la guardia del job si applica comunque).
- Rimuovere le route legacy `summary` e `summary/regenerate`.

### 7. UI — sezione "Memoria della campagna (wiki)"

In `/campaigns/[id]`, al posto del componente riassunto:
- elenco cartelle con conteggio pagine; click su una pagina → vista markdown renderizzata con titolo, descrizione, data aggiornamento;
- Modifica (textarea markdown + titolo/descrizione), Crea pagina, Elimina (con conferma);
- "Aggiorna ora" → POST regenerate con feedback (polling del GET finché cambia qualche `updatedAt`);
- stato vuoto: "La wiki verrà popolata automaticamente man mano che giochi."
In chat (`play/chat.tsx`): render dell'evento `wiki` come riga discreta stile evento dado ("📖 consulta la wiki: Lord Anor").

### 8. Export

`GET /api/campaigns/[id]/export`: al posto del riassunto attivo, la pagina `core/panoramica` (fallback: riassunto legacy), poi la cronologia integrale come oggi.

## Criteri di accettazione

1. Con wiki vuota il GM funziona come prima (fallback al riassunto legacy nel nucleo, nessun errore se non c'è nulla).
2. Dopo una sessione oltre soglia, il worker popola/aggiorna pagine coerenti (una per entità, niente duplicati), mantiene `core/panoramica` e aggiorna il watermark; il turno successivo manda in chiaro solo i messaggi non coperti.
3. In un turno che riguarda un PNG schedato, il GM legge la pagina giusta via tool (evento visibile in chat) e ne rispetta i fatti.
4. Modifico a mano una pagina: il GM la rispetta nei turni successivi e il job non la sovrascrive con informazioni più vecchie.
5. Le note temporanee superate vengono eliminate dal job.
6. Due job concorrenti sulla stessa campagna non si sovrappongono (singleton pg-boss).
7. `npx tsc --noEmit` pulito; test esistenti verdi.

Nota di evoluzione (non implementare ora): ricerca full-text sulle pagine wiki (tsvector) come secondo tool `search_wiki` quando le campagne superano il centinaio di pagine.
