import { NextResponse } from "next/server";
import { z } from "zod";

export function unauthorized() {
  return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });
}

export function forbidden(message: string) {
  return NextResponse.json({ error: message }, { status: 403 });
}

export function notFound() {
  return NextResponse.json({ error: "Risorsa non trovata" }, { status: 404 });
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export const uuidSchema = z.uuid();

// Valida il segmento dinamico [id]: un uuid malformato farebbe
// esplodere la query Postgres, meglio un 404 pulito.
export function parseId(id: string): string | null {
  const parsed = uuidSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}
