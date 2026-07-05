import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { campaigns } from "@/db/schema";
import { badRequest, unauthorized, uuidSchema } from "@/lib/api";
import { listCampaigns, ownsAllDocuments, replaceCampaignDocuments } from "@/lib/queries";
import { getUserId } from "@/lib/session";

export async function GET() {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  return NextResponse.json(await listCampaigns(userId));
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Il nome della campagna è obbligatorio"),
  gameSystem: z.string().trim().min(1, "Il sistema di gioco è obbligatorio"),
  documentIds: z.array(uuidSchema).optional().default([]),
});

export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Dati non validi");
  }
  const { name, gameSystem, documentIds } = parsed.data;

  if (!(await ownsAllDocuments(userId, documentIds))) {
    return badRequest("Uno o più documenti non esistono");
  }

  const [campaign] = await db
    .insert(campaigns)
    .values({ userId, name, gameSystem })
    .returning();

  if (documentIds.length > 0) {
    await replaceCampaignDocuments(campaign.id, documentIds);
  }

  return NextResponse.json(campaign, { status: 201 });
}
