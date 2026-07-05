import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";

import { db } from "../../db";
import { chunks, documents } from "../../db/schema";
import { chunkPages } from "../../lib/chunking";
import { embed } from "../../lib/embeddings";

// Sotto questa media di caratteri per pagina il PDF è quasi
// certamente una scansione senza layer di testo.
const MIN_AVG_CHARS_PER_PAGE = 200;

// Allineato al limite per richiesta di Voyage: ogni batch è
// una chiamata embeddings + un INSERT multi-riga (atomico).
const BATCH_SIZE = 128;

export async function processPdf(documentId: string): Promise<void> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc) {
    console.warn(`process-pdf: documento ${documentId} non trovato, salto`);
    return;
  }

  await db
    .update(documents)
    .set({ status: "processing", errorMessage: null })
    .where(eq(documents.id, documentId));

  try {
    const buffer = await readFile(doc.storagePath);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });

    const totalChars = text.reduce((sum, page) => sum + page.trim().length, 0);
    if (totalPages === 0 || totalChars / totalPages < MIN_AVG_CHARS_PER_PAGE) {
      // Fallimento permanente: ritentare non aiuta, niente throw.
      await db
        .update(documents)
        .set({
          status: "error",
          errorMessage: "PDF senza testo estraibile (scansione?). OCR non supportato.",
          pageCount: totalPages,
        })
        .where(eq(documents.id, documentId));
      return;
    }

    const textChunks = chunkPages(text.map((t, i) => ({ page: i + 1, text: t })));

    // Idempotenza: se il job riparte (retry, riavvio worker) non
    // devono restare chunks del tentativo precedente.
    await db.delete(chunks).where(eq(chunks.documentId, documentId));

    for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
      const batch = textChunks.slice(i, i + BATCH_SIZE);
      const embeddings = await embed(batch.map((c) => c.content), "document");
      await db.insert(chunks).values(
        batch.map((chunk, j) => ({
          documentId,
          chunkIndex: i + j,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          content: chunk.content,
          embedding: embeddings[j],
        })),
      );
    }

    await db
      .update(documents)
      .set({ status: "ready", pageCount: totalPages, chunkCount: textChunks.length })
      .where(eq(documents.id, documentId));

    console.log(
      `process-pdf: "${doc.title}" pronto (${totalPages} pagine, ${textChunks.length} chunks)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(documents)
      .set({
        status: "error",
        errorMessage: `Elaborazione fallita: ${message}`.slice(0, 500),
      })
      .where(eq(documents.id, documentId));
    // rilancia: i retry (con backoff) restano in mano a pg-boss
    throw error;
  }
}
