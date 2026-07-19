import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { campaigns } from "@/db/schema";
import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign, listCampaignDocuments } from "@/lib/queries";
import { getUserId } from "@/lib/session";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const documents = await listCampaignDocuments(id);
  return NextResponse.json({ ...campaign, documents });
}

const patchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    gameSystem: z.string().trim().min(1).optional(),
    // Stringa vuota = rimozione delle istruzioni (salvata come null).
    aiInstructions: z
      .string()
      .trim()
      .transform((value) => value || null)
      .optional(),
    // Switch "campagna conclusa": true imposta concluded_at a ora,
    // false lo azzera (la campagna torna giocabile).
    concluded: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
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

  const { concluded, ...fields } = parsed.data;
  const [updated] = await db
    .update(campaigns)
    .set({
      ...fields,
      ...(concluded !== undefined
        ? { concludedAt: concluded ? new Date() : null }
        : {}),
    })
    .where(and(eq(campaigns.id, id), eq(campaigns.userId, userId)))
    .returning();
  if (!updated) return notFound();

  return NextResponse.json(updated);
}

export async function DELETE(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  // Il cascade elimina associazioni, messaggi e summary; i documenti restano.
  const deleted = await db
    .delete(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.userId, userId)))
    .returning({ id: campaigns.id });
  if (deleted.length === 0) return notFound();

  return NextResponse.json({ ok: true });
}
