import Link from "next/link";

import { auth, signOut } from "@/auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Solo GM</span>
          <nav className="flex gap-4 text-sm text-zinc-300">
            <Link href="/dashboard" className="hover:text-white">
              Dashboard
            </Link>
            <Link href="/documenti" className="hover:text-white">
              Documenti
            </Link>
            <Link href="/impostazioni" className="hover:text-white">
              Impostazioni
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-zinc-400">
            <span>{session?.user?.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 hover:text-white"
              >
                Esci
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
