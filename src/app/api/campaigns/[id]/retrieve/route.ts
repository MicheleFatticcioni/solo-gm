import { NextResponse } from "next/server";

import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { retrieve } from "@/lib/rag";
import { getUserId } from "@/lib/session";

// Route di debug: verifica a occhio la qualità del retrieval ibrido.
// GET /api/campaigns/[id]/retrieve?q=...&topK=8
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  if (!query) return badRequest("Parametro q mancante");

  const topKParam = searchParams.get("topK");
  const topK = topKParam ? Number(topKParam) : 8;
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    return badRequest("topK deve essere un intero tra 1 e 50");
  }

  return NextResponse.json(await retrieve(id, query, topK));
}
