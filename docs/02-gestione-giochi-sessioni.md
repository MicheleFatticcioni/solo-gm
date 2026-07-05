# Prompt modulo (b) — Gestione giochi / campagne / documenti

> Incolla questo documento in una conversazione nuova. È autosufficiente. Presuppone completato il modulo (a) "Setup progetto e DB".

## Contesto architetturale (progetto "Solo GM")

"Solo GM" è una web app personale self-hosted (locale, mono-utente) che fa da Game Master AI per GdR in solitaria: l'utente carica PDF di manuali, l'app li indicizza (RAG) e Claude conduce la partita in chat.

Stack già in piedi dal modulo precedente:
- Next.js App Router + TypeScript + Tailwind; API routes Next; worker Node separato (pg-boss su Postgres) per i job pesanti.
- PostgreSQL 16 + pgvector in docker, ORM Drizzle (`src/db/schema.ts`), auth con Auth.js v5 Credentials (utente singolo), tutte le pagine protette da middleware.

Tabelle rilevanti (già esistenti):

```
documents           id, user_id, filename, title, storage_path, description,
                    doc_type(regolamento|avventura|bestiario|tabelle|ambientazione|altro),
                    status(uploaded|processing|ready|error), error_message,
                    page_count, chunk_count, created_at
campaigns           id, user_id, name, game_system, created_at, last_played_at
campaign_documents  (campaign_id, document_id) PK composita  -- N:N
messages            id, campaign_id, role, content, ..., created_at
```

Vincolo di dominio importante: **i documenti sono una libreria globale dell'utente, riusabili in più campagne** (relazione N:N via `campaign_documents`). L'upload vero e proprio con elaborazione è il modulo (c) — qui si gestiscono solo metadati e associazioni; dove serve un punto di aggancio per l'upload, lascia un componente placeholder chiaramente marcato `TODO(modulo-c)`.

## Compito di questo modulo

CRUD completo di campagne e libreria documenti, dashboard, flusso "Nuova partita".

### 1. API routes

- `GET/POST /api/campaigns` — lista (con conteggio documenti associati e data ultimo messaggio) / creazione. Body creazione validato con zod: `{ name, gameSystem, documentIds?: string[] }`.
- `GET/PATCH/DELETE /api/campaigns/[id]` — dettaglio (con documenti associati), rinomina, eliminazione (cascade su messaggi/summary; i documenti NON si eliminano, solo l'associazione).
- `PUT /api/campaigns/[id]/documents` — sostituisce l'insieme dei documenti associati (`{ documentIds: string[] }`). Deve funzionare anche a partita già iniziata.
- `GET /api/documents` — libreria: tutti i documenti dell'utente con status e campagne che li usano.
- `PATCH/DELETE /api/documents/[id]` — modifica titolo/descrizione/doc_type; eliminazione consentita solo se non associato ad alcuna campagna (altrimenti 409 con messaggio), cancella anche il file su disco e i chunks (cascade).

Tutte le route verificano la sessione e che le risorse appartengano all'utente.

### 2. Pagine

- **`/dashboard`** — griglia di card campagne: nome, sistema di gioco, n° documenti, ultima giocata; pulsante primario "Nuova partita"; stato vuoto curato.
- **Flusso "Nuova partita"** (`/campaigns/new`, anche multi-step semplice):
  1. nome del sistema di gioco (es. "Ironsworn") e nome della campagna;
  2. selezione dei documenti già in libreria da associare (checkbox con titolo, tipo, descrizione, stato) + area placeholder "Carica nuovi PDF" `TODO(modulo-c)`;
  3. crea → redirect al dettaglio campagna.
- **`/campaigns/[id]`** — dettaglio: intestazione (nome, sistema, rinomina inline), elenco documenti associati con badge di stato (`ready` verde, `processing` giallo con nota "in elaborazione", `error` rosso con messaggio), pulsante "Gestisci documenti" (modale/sezione con la stessa selezione multipla), pulsante prominente **"Avvia partita" → `/campaigns/[id]/play`**. La pagina `/play` è il modulo (e): creala come placeholder.
- **`/documents`** — libreria globale: tabella con titolo, tipo, descrizione, stato, campagne che lo usano; edit metadati; delete con conferma.

### 3. Dettagli UX

- "Avvia partita" disabilitato con tooltip se nessun documento associato è `ready` (si può comunque entrare se almeno uno è pronto).
- Le liste si aggiornano dopo ogni mutazione (router.refresh o revalidate — scegli un pattern e usalo ovunque).
- Componenti server dove possibile; client solo per form e interazioni.

## Criteri di accettazione

1. Creo una campagna con 2 documenti associati; la card appare in dashboard con i conteggi giusti.
2. Lo stesso documento può essere associato a due campagne diverse; eliminando una campagna il documento resta in libreria.
3. Posso aggiungere/rimuovere documenti a una campagna esistente in qualsiasi momento.
4. Un documento associato a una campagna non è eliminabile (409 mostrato in UI); dopo la rimozione dell'associazione sì.
5. `npx tsc --noEmit` pulito.

Non implementare qui: upload/elaborazione PDF (modulo c), chat (modulo e), RAG (modulo d), riassunti (modulo f).
