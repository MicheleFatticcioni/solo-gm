import { NextResponse } from "next/server";

import { notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { enqueueUpdateWiki } from "@/lib/queue";
import { getUserId } from "@/lib/session";

type Params = { params: Promise<{ id: string }> };

// POST /api/campaigns/[id]/wiki/regenerate — enqueue immediato del job
// update-wiki (bypass della soglia; la guardia del job resta).
export async function POST(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  await enqueueUpdateWiki(id);
  return NextResponse.json({ enqueued: true }, { status: 202 });
}
