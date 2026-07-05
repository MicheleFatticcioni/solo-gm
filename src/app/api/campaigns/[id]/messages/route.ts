import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { messages } from "@/db/schema";
import { badRequest, notFound, parseId, uuidSchema } from "@/lib/api";
import { unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";

// GET /api/campaigns/[id]/messages?before=<messageId>&limit=50
// Paginazione a cursore all'indietro per lo scroll verso l'alto:
// ritorna la pagina più recente prima del cursore, in ordine cronologico.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const searchParams = request.nextUrl.searchParams;

  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return badRequest("limit deve essere un intero tra 1 e 100");
  }

  const beforeParam = searchParams.get("before");
  let beforeCondition;
  if (beforeParam) {
    if (!uuidSchema.safeParse(beforeParam).success) {
      return badRequest("before deve essere l'id di un messaggio");
    }
    // Confronto di tupla (created_at, id) per un ordine totale stabile
    // anche con timestamp identici.
    beforeCondition = sql`(${messages.createdAt}, ${messages.id}) < (
      select created_at, id from messages
      where id = ${beforeParam} and campaign_id = ${id}
    )`;
  }

  // Una riga in più del limite per sapere se esistono messaggi precedenti.
  const page = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.campaignId, id), beforeCondition))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const hasMore = page.length > limit;
  const items = page.slice(0, limit).reverse();

  return NextResponse.json({ messages: items, hasMore });
}
