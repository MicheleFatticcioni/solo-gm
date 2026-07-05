import Link from "next/link";

import { formatDate } from "@/lib/format";
import { listCampaigns } from "@/lib/queries";
import { getUserId } from "@/lib/session";

export default async function DashboardPage() {
  const userId = await getUserId();
  if (!userId) return null; // il proxy protegge già la route

  const campaignList = await listCampaigns(userId);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Le tue campagne</h1>
        <Link
          href="/campaigns/new"
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Nuova partita
        </Link>
      </div>

      {campaignList.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-700 p-12 text-center">
          <p className="text-4xl">🎲</p>
          <h2 className="mt-4 text-lg font-medium">Nessuna campagna</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Crea la tua prima partita: scegli un sistema di gioco e associa i
            manuali dalla libreria.
          </p>
          <Link
            href="/campaigns/new"
            className="mt-6 inline-block rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Nuova partita
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaignList.map((campaign) => {
            const lastPlayed = formatDate(
              campaign.lastPlayedAt ?? campaign.lastMessageAt,
            );
            return (
              <Link
                key={campaign.id}
                href={`/campaigns/${campaign.id}`}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition hover:border-zinc-600"
              >
                <h2 className="font-semibold">{campaign.name}</h2>
                <p className="text-sm text-zinc-400">{campaign.gameSystem}</p>
                <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
                  <span>
                    {campaign.documentCount}{" "}
                    {campaign.documentCount === 1 ? "documento" : "documenti"}
                  </span>
                  <span>
                    {lastPlayed ? `Ultima giocata: ${lastPlayed}` : "Mai giocata"}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
