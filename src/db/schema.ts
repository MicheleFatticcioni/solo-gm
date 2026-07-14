import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// tsvector non è supportato nativamente da Drizzle
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const docTypeEnum = pgEnum("doc_type", [
  "regolamento",
  "avventura",
  "bestiario",
  "tabelle",
  "ambientazione",
  "altro",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "uploaded",
  "processing",
  "ready",
  "error",
]);

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);

export const wikiFolderEnum = pgEnum("wiki_folder", [
  "core",
  "pg",
  "npc",
  "luoghi",
  "eventi",
  "storia",
  "note",
]);

export const embeddingsProviderEnum = pgEnum("embeddings_provider", [
  "voyage",
  "ollama",
]);

export const chatProviderEnum = pgEnum("chat_provider", ["anthropic", "ollama"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Chiavi API e modelli dei servizi AI, gestiti dall'interfaccia
// (pagina Impostazioni). Le variabili d'ambiente restano solo come
// fallback per le installazioni esistenti: il DB ha la precedenza.
// Ogni sezione dell'app (partita, riassunto, migliora istruzioni)
// ha il suo modello, tutti null-able: null = usa fallback/default.
export const userSettings = pgTable("user_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  // Provider delle interazioni chat (partita, riassunti, migliora
  // istruzioni): Claude oppure Ollama (locale o cloud).
  chatProvider: chatProviderEnum("chat_provider"),
  anthropicApiKey: text("anthropic_api_key"),
  modelGm: text("model_gm"),
  modelSummary: text("model_summary"),
  modelImprove: text("model_improve"),
  embeddingsProvider: embeddingsProviderEnum("embeddings_provider"),
  voyageApiKey: text("voyage_api_key"),
  ollamaHost: text("ollama_host"),
  // Chiave API di Ollama: serve solo per Ollama cloud (host ollama.com).
  ollamaApiKey: text("ollama_api_key"),
  // Modello chat usato per tutte le funzioni quando il provider è Ollama.
  ollamaChatModel: text("ollama_chat_model"),
  ollamaEmbedModel: text("ollama_embed_model"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  filename: text("filename"),
  title: text("title").notNull(),
  storagePath: text("storage_path").notNull(),
  // descrizione fornita dall'utente, usata per il routing RAG
  description: text("description").notNull(),
  docType: docTypeEnum("doc_type").notNull(),
  status: documentStatusEnum("status").notNull().default("uploaded"),
  errorMessage: text("error_message"),
  pageCount: integer("page_count"),
  chunkCount: integer("chunk_count"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    tsv: tsvector("tsv").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', ${chunks.content})`,
    ),
  },
  (t) => [
    index("chunks_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("chunks_tsv_gin_idx").using("gin", t.tsv),
    index("chunks_document_id_idx").on(t.documentId),
  ],
);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  gameSystem: text("game_system").notNull(),
  // Indicazioni libere del giocatore su come l'AI deve condurre la campagna.
  aiInstructions: text("ai_instructions"),
  // Watermark della wiki: le pagine coprono la storia fino a questo
  // messaggio incluso. Riferimento lazy e tipo esplicito AnyPgColumn:
  // campaigns e messages si citano a vicenda (ciclo).
  wikiCoversUntilMessageId: uuid("wiki_covers_until_message_id").references(
    (): AnyPgColumn => messages.id,
  ),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true }),
});

// N:N — i documenti sono riusabili tra campagne
export const campaignDocuments = pgTable(
  "campaign_documents",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.documentId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    // chunk recuperati, tiri di dado, ecc.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_campaign_id_created_at_idx").on(t.campaignId, t.createdAt)],
);

// Wiki della campagna: una pagina per entità (PG, PNG, luogo, ...),
// aggiornata IN PLACE (la storia integrale resta nei messages).
// title/description sono colonne, non frontmatter nel content: la
// description alimenta l'indice con cui il GM sceglie cosa leggere.
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    folder: wikiFolderEnum("folder").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wiki_pages_campaign_folder_slug_idx").on(
      t.campaignId,
      t.folder,
      t.slug,
    ),
    index("wiki_pages_campaign_folder_idx").on(t.campaignId, t.folder),
  ],
);

// Append-only: il summary più recente per campagna è quello attivo
export const campaignSummaries = pgTable("campaign_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  coversUntilMessageId: uuid("covers_until_message_id").references(() => messages.id),
  isUserEdited: boolean("is_user_edited").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
