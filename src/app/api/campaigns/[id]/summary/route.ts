import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { campaignSummaries } from "@/db/schema";
import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { getActiveSummary, getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";

type Params = { params: Promise<{ id: string }> };

function toJson(summary: NonNullable<Awaited<ReturnType<typeof getActiveSummary>>>) {
  return {
    id: summary.id,
    content: summary.content,
    coversUntilMessageId: summary.coversUntilMessageId,
    isUserEdited: summary.isUserEdited,
    createdAt: summary.createdAt,
  };
}

// GET /api/campaigns/[id]/summary — riassunto attivo, 204 se non esiste.
export async function GET(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const summary = await getActiveSummary(id);
  if (!summary) return new Response(null, { status: 204 });

  return NextResponse.json(toJson(summary));
}

const putSchema = z.object({ content: z.string().trim().min(1) });

// PUT /api/campaigns/[id]/summary — modifica manuale: append-only, si
// inserisce una nuova riga con lo stesso covers_until dell'attivo.
export async function PUT(request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Contenuto mancante o vuoto");

  const active = await getActiveSummary(id);
  const [saved] = await db
    .insert(campaignSummaries)
    .values({
      campaignId: id,
      content: parsed.data.content,
      coversUntilMessageId: active?.coversUntilMessageId ?? null,
      isUserEdited: true,
    })
    .returning();

  return NextResponse.json(toJson(saved));
}
