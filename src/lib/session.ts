import { auth } from "@/auth";

// Ritorna l'id dell'utente autenticato, o null se la sessione manca.
export async function getUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
