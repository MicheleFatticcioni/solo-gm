import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { documents } from "@/db/schema";
import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { enqueueProcessPdf } from "@/lib/queue";
import { getUserId } from "@/lib/session";

// Re-enqueue di un documento finito in errore.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)));
  if (!doc) return notFound();

  if (doc.status !== "error") {
    return badRequest("Solo i documenti in errore possono essere rielaborati");
  }

  const [updated] = await db
    .update(documents)
    .set({ status: "uploaded", errorMessage: null })
    .where(eq(documents.id, id))
    .returning();

  await enqueueProcessPdf(id);

  return NextResponse.json(updated);
}
