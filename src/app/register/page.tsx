import { redirect } from "next/navigation";

import { hasAnyUser } from "@/lib/queries";

import { RegisterForm } from "./register-form";

// La registrazione crea solo il primo utente dell'istanza: se esiste già,
// niente self-service (il proxy edge non può fare questo controllo sul DB).
// force-dynamic: senza segnali di dinamicità (cookies/auth), Next tenterebbe
// di prerenderizzare la pagina a build time, quando il DB non è raggiungibile.
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await hasAnyUser()) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-semibold text-zinc-100">
          Solo GM
        </h1>
        <RegisterForm />
      </div>
    </main>
  );
}
