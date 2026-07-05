import { NextResponse } from "next/server";
import { z } from "zod";

import { badRequest, notFound, parseId, unauthorized, uuidSchema } from "@/lib/api";
import {
  getCampaign,
  listCampaignDocuments,
  ownsAllDocuments,
  replaceCampaignDocuments,
} from "@/lib/queries";
import { getUserId } from "@/lib/session";

const putSchema = z.object({
  documentIds: z.array(uuidSchema),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Dati non validi: atteso { documentIds: string[] }");

  const documentIds = [...new Set(parsed.data.documentIds)];
  if (!(await ownsAllDocuments(userId, documentIds))) {
    return badRequest("Uno o più documenti non esistono");
  }

  await replaceCampaignDocuments(id, documentIds);
  return NextResponse.json(await listCampaignDocuments(id));
}
