import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { embed } from "@/lib/embeddings";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  docType: string;
  documentDescription: string;
  pageStart: number;
  pageEnd: number;
  content: string;
  score: number;
};

// Riga grezza restituita dalle due ricerche SQL (colonne snake_case).
type CandidateRow = {
  chunk_id: string;
  document_id: string;
  document_title: string;
  doc_type: string;
  document_description: string;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  content: string;
};

// Candidati per ramo di ricerca: abbondanti rispetto a topK perché la
// fusione RRF premia i chunk presenti in entrambe le liste.
const CANDIDATES_PER_BRANCH = 30;
// Costante k della Reciprocal Rank Fusion (valore canonico).
const RRF_K = 60;

// Ricerca ibrida (semantica + lessicale, fusione RRF) sui documenti
// della campagna. Nessun reranker esterno in v1: se la qualità non
// bastasse, è QUI che andrebbe inserito un reranker (es. voyage rerank)
// sui ~60 candidati prima del taglio a topK.
export async function retrieve(
  campaignId: string,
  query: string,
  topK = 8,
): Promise<RetrievedChunk[]> {
  const [queryVector] = await embed([query], "query");

  const [semantic, lexical] = await Promise.all([
    semanticSearch(campaignId, queryVector),
    lexicalSearch(campaignId, query),
  ]);

  return dedupeAdjacent(fuseRrf([semantic, lexical]), topK);
}

// SQL raw: le espressioni pgvector (<=>) e tsquery non hanno API
// tipizzata in Drizzle. I parametri sono sempre bindati dal template.
const candidateColumns = sql`
  c.id as chunk_id,
  c.document_id,
  d.title as document_title,
  d.doc_type,
  d.description as document_description,
  c.chunk_index,
  c.page_start,
  c.page_end,
  c.content
`;

async function semanticSearch(
  campaignId: string,
  queryVector: number[],
): Promise<CandidateRow[]> {
  const rows = await db.execute(sql`
    select ${candidateColumns}
    from chunks c
    join documents d on d.id = c.document_id
    join campaign_documents cd on cd.document_id = d.id
    where cd.campaign_id = ${campaignId}
      and d.status = 'ready'
      and c.embedding is not null
    order by c.embedding <=> ${JSON.stringify(queryVector)}::vector
    limit ${CANDIDATES_PER_BRANCH}
  `);
  return rows as unknown as CandidateRow[];
}

async function lexicalSearch(
  campaignId: string,
  query: string,
): Promise<CandidateRow[]> {
  // websearch_to_tsquery tollera qualsiasi input utente (niente errori
  // di sintassi come to_tsquery); se non produce match, il ramo
  // lessicale resta semplicemente vuoto. La configurazione 'italian'
  // DEVE combaciare con quella della colonna generata tsv (db/schema).
  const rows = await db.execute(sql`
    select ${candidateColumns}
    from chunks c
    join documents d on d.id = c.document_id
    join campaign_documents cd on cd.document_id = d.id
    where cd.campaign_id = ${campaignId}
      and d.status = 'ready'
      and c.tsv @@ websearch_to_tsquery('italian', ${query})
    order by ts_rank(c.tsv, websearch_to_tsquery('italian', ${query})) desc
    limit ${CANDIDATES_PER_BRANCH}
  `);
  return rows as unknown as CandidateRow[];
}

// Reciprocal Rank Fusion: score = Σ 1/(RRF_K + rank) per ogni lista in
// cui il chunk appare. Ritorna i candidati ordinati per score.
function fuseRrf(
  lists: CandidateRow[][],
): (CandidateRow & { score: number })[] {
  const fused = new Map<string, CandidateRow & { score: number }>();
  for (const list of lists) {
    list.forEach((row, i) => {
      const rank = i + 1;
      const existing = fused.get(row.chunk_id);
      if (existing) {
        existing.score += 1 / (RRF_K + rank);
      } else {
        fused.set(row.chunk_id, { ...row, score: 1 / (RRF_K + rank) });
      }
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

// Scorre i candidati in ordine di score e scarta i chunk adiacenti
// (stesso documento, chunk_index consecutivo) a uno già selezionato:
// l'overlap del chunking li rende ridondanti. Tenendo il primo
// incontrato si tiene automaticamente il migliore.
function dedupeAdjacent(
  candidates: (CandidateRow & { score: number })[],
  topK: number,
): RetrievedChunk[] {
  const selected: (CandidateRow & { score: number })[] = [];
  for (const candidate of candidates) {
    if (selected.length >= topK) break;
    const adjacent = selected.some(
      (s) =>
        s.document_id === candidate.document_id &&
        Math.abs(s.chunk_index - candidate.chunk_index) === 1,
    );
    if (!adjacent) selected.push(candidate);
  }

  return selected.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    docType: row.doc_type,
    documentDescription: row.document_description,
    pageStart: row.page_start ?? 0,
    pageEnd: row.page_end ?? 0,
    content: row.content,
    score: row.score,
  }));
}

// Risultati per ricerca esplicita del GM: meno del topK del retrieval
// automatico perché la query del modello è già mirata alla regola.
export const SEARCH_MANUALS_TOP_K = 6;

// Tool per il loop agentico del GM: espone retrieve() al modello, che
// formula da sé la query quando gli estratti automatici non bastano.
export const searchManualsTool: Anthropic.Tool = {
  name: "search_manuals",
  description:
    "Cerca nei manuali e documenti della campagna (ricerca ibrida semantica + lessicale) e restituisce gli estratti più pertinenti con documento e pagine. Usalo quando una regola, tabella o dettaglio che ti serve NON compare negli estratti già forniti nel turno. Formula la query con i termini con cui la regola è scritta sul manuale (nome della regola, della tabella, dell'oggetto), non con la descrizione della scena.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Termini di ricerca, es. 'prova di atletica scalare' o 'tabella armi da mischia costi'",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
};

export type SearchManualsInput = { query: string };

// Formatta i chunk nel blocco <estratti_manuali>: usato sia per gli
// estratti automatici del turno (lib/context) sia per i risultati di
// search_manuals, così il modello vede un formato solo.
export function formatExcerpts(retrieved: RetrievedChunk[]): string {
  if (retrieved.length === 0) {
    return "<estratti_manuali>\n(nessun estratto rilevante trovato)\n</estratti_manuali>";
  }
  const excerpts = retrieved
    .map(
      (c) =>
        `  <estratto documento="${escapeAttribute(c.documentTitle)}" tipo="${c.docType}" pagine="${c.pageStart}-${c.pageEnd}">\n${c.content}\n  </estratto>`,
    )
    .join("\n");
  return `<estratti_manuali>\n${excerpts}\n</estratti_manuali>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const RECENT_MESSAGES_FOR_QUERY = 2;
const RECENT_MESSAGE_MAX_CHARS = 300;

// Il messaggio del giocatore da solo è spesso una pessima query
// ("attacco!"): lo si arricchisce con gli ultimi messaggi per dare
// contesto al retrieval.
//
// v1 deterministica e gratuita. Upgrade opzionale predisposto: sostituire
// la concatenazione con una riscrittura della query via chiamata LLM
// economica (es. Haiku), dietro un flag tipo RAG_QUERY_REWRITE=llm.
export function buildRetrievalQuery(
  userMessage: string,
  recentMessages: { role: string; content: string }[],
): string {
  const context = recentMessages
    .slice(-RECENT_MESSAGES_FOR_QUERY)
    .map((m) => m.content.slice(0, RECENT_MESSAGE_MAX_CHARS));
  return [...context, userMessage].join("\n");
}
