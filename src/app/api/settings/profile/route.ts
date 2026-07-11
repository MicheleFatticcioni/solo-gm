import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { users } from "@/db/schema";
import { badRequest, unauthorized } from "@/lib/api";
import { getUserId } from "@/lib/session";

const profileSchema = z.object({
  firstName: z.string().trim().min(1, "Il nome è obbligatorio"),
  lastName: z.string().trim().min(1, "Il cognome è obbligatorio"),
  email: z.email("Email non valida"),
});

// PATCH /api/settings/profile — aggiorna i dati dell'utente loggato.
export async function PATCH(request: Request) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const parsed = profileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Dati non validi");
  }
  const { firstName, lastName, email } = parsed.data;

  const emailTaken = await db.query.users.findFirst({
    where: and(eq(users.email, email), ne(users.id, userId)),
  });
  if (emailTaken) return badRequest("Email già in uso");

  const [updated] = await db
    .update(users)
    .set({ firstName, lastName, email })
    .where(eq(users.id, userId))
    .returning({
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    });
  if (!updated) return unauthorized();

  return NextResponse.json(updated);
}
