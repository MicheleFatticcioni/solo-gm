import { unlink } from "node:fs/promises";

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { campaignDocuments, campaigns, docTypeEnum, documents } from "@/db/schema";
import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { getUserId } from "@/lib/session";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().optional(),
    docType: z.enum(docTypeEnum.enumValues).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "Nessun campo da aggiornare",
  });

export async function PATCH(request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Dati non validi");
  }

  const [updated] = await db
    .update(documents)
    .set(parsed.data)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)))
    .returning();
  if (!updated) return notFound();

  return NextResponse.json(updated);
}

export async function DELETE(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)));
  if (!doc) return notFound();

  const usedBy = await db
    .select({ name: campaigns.name })
    .from(campaignDocuments)
    .innerJoin(campaigns, eq(campaigns.id, campaignDocuments.campaignId))
    .where(eq(campaignDocuments.documentId, id));

  if (usedBy.length > 0) {
    return NextResponse.json(
      {
        error: `Il documento è usato da ${usedBy.length === 1 ? "una campagna" : `${usedBy.length} campagne`} (${usedBy
          .map((c) => c.name)
          .join(", ")}). Rimuovi prima l'associazione.`,
      },
      { status: 409 },
    );
  }

  // I chunks cadono in cascade; il file su disco si elimina best-effort dopo.
  await db.delete(documents).where(eq(documents.id, id));

  try {
    await unlink(doc.storagePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return NextResponse.json({ ok: true });
}
