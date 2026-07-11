import { compare, hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { users } from "@/db/schema";
import { badRequest, unauthorized } from "@/lib/api";
import { getUserId } from "@/lib/session";

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "La password attuale è obbligatoria"),
  newPassword: z
    .string()
    .min(8, "La nuova password deve avere almeno 8 caratteri"),
});

// POST /api/settings/password — cambia la password verificando quella attuale.
export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const parsed = passwordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Dati non validi");
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return unauthorized();

  const passwordOk = await compare(parsed.data.currentPassword, user.passwordHash);
  if (!passwordOk) return badRequest("La password attuale non è corretta");

  await db
    .update(users)
    .set({ passwordHash: await hash(parsed.data.newPassword, 12) })
    .where(eq(users.id, userId));

  return NextResponse.json({ ok: true });
}
