import { sql, type SQL } from "drizzle-orm";
import {
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

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
