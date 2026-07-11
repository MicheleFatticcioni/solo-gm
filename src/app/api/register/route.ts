import { hash } from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { users } from "@/db/schema";
import { badRequest, forbidden } from "@/lib/api";
import { hasAnyUser } from "@/lib/queries";

const registerSchema = z.object({
  firstName: z.string().trim().min(1, "Il nome è obbligatorio"),
  lastName: z.string().trim().min(1, "Il cognome è obbligatorio"),
  email: z.email("Email non valida"),
  password: z.string().min(8, "La password deve avere almeno 8 caratteri"),
});

// Registrazione consentita solo per creare il primo utente dell'istanza:
// una volta esistente, l'app torna a essere single-tenant.
export async function POST(request: Request) {
  if (await hasAnyUser()) {
    return forbidden("La registrazione non è disponibile");
  }

  const parsed = registerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Dati non validi");
  }
  const { firstName, lastName, email, password } = parsed.data;

  const [user] = await db
    .insert(users)
    .values({
      firstName,
      lastName,
      email,
      passwordHash: await hash(password, 12),
    })
    .returning({ id: users.id, email: users.email });

  return NextResponse.json(user, { status: 201 });
}
