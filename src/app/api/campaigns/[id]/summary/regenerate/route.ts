import { NextResponse } from "next/server";

import { notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { enqueueUpdateSummary } from "@/lib/queue";
import { getUserId } from "@/lib/session";

// POST /api/campaigns/[id]/summary/regenerate — enqueue immediato del
// job update-summary (bypassa la soglia token; la guardia sui messaggi
// minimi resta nel job).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  await enqueueUpdateSummary(id);
  return NextResponse.json({ ok: true }, { status: 202 });
}
