import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { docTypeEnum, documents } from "@/db/schema";
import { badRequest, unauthorized } from "@/lib/api";
import { listLibrary } from "@/lib/queries";
import { enqueueProcessPdf } from "@/lib/queue";
import { getUserId } from "@/lib/session";

export async function GET() {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  return NextResponse.json(await listLibrary(userId));
}

const UPLOAD_DIR = path.join("storage", "uploads");

const uploadSchema = z.object({
  title: z.string().trim().min(1, "Il titolo è obbligatorio"),
  description: z
    .string()
    .trim()
    .min(1, "La descrizione è obbligatoria: indica contenuto e uso del documento"),
  docType: z.enum(docTypeEnum.enumValues, { error: "Tipo di documento non valido" }),
});

export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const form = await request.formData().catch(() => null);
  if (!form) return badRequest("Atteso multipart/form-data");

  const file = form.get("file");
  if (!(file instanceof File)) return badRequest("File PDF mancante");
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) return badRequest("Il file deve essere un PDF");

  const maxMb = Number(process.env.MAX_PDF_MB) || 100;
  if (file.size > maxMb * 1024 * 1024) {
    return badRequest(`Il file supera il limite di ${maxMb} MB`);
  }

  const parsed = uploadSchema.safeParse({
    title: form.get("title"),
    description: form.get("description"),
    docType: form.get("docType"),
  });
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Dati non validi");
  }

  // Id generato prima dell'insert: il percorso su disco lo contiene.
  const id = crypto.randomUUID();
  const storagePath = path.join(UPLOAD_DIR, `${id}.pdf`);

  const [doc] = await db
    .insert(documents)
    .values({ id, userId, filename: file.name, storagePath, ...parsed.data })
    .returning();

  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    await pipeline(
      Readable.fromWeb(file.stream() as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(storagePath),
    );
    // L'elaborazione avviene solo nel worker: qui si accoda e basta.
    await enqueueProcessPdf(id);
  } catch (error) {
    await db.delete(documents).where(eq(documents.id, id));
    await unlink(storagePath).catch(() => {});
    console.error("Upload fallito:", error);
    return NextResponse.json(
      { error: "Salvataggio del file non riuscito" },
      { status: 500 },
    );
  }

  return NextResponse.json(doc, { status: 201 });
}
