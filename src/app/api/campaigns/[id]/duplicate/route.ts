import { NextResponse } from "next/server";

import { notFound, parseId, unauthorized } from "@/lib/api";
import { duplicateCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const copy = await duplicateCampaign(userId, id);
  if (!copy) return notFound();

  return NextResponse.json(copy, { status: 201 });
}
