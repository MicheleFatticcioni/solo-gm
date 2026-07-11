import Link from "next/link";
import { notFound } from "next/navigation";

import { StatusBadge } from "@/components/status-badge";
import { parseId } from "@/lib/api";
import { docTypeLabels } from "@/lib/format";
import {
  getActiveSummary,
  getCampaign,
  listCampaignDocuments,
  listLibrary,
} from "@/lib/queries";
import { getUserId } from "@/lib/session";

import { CampaignHeader } from "./campaign-header";
import { CampaignInstructions } from "./campaign-instructions";
import { CampaignSummary } from "./campaign-summary";
import { ManageDocuments } from "./manage-documents";

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserId();
  if (!userId) return null;

  const id = parseId((await params).id);
  if (!id) notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) notFound();

  const [associated, library, summary] = await Promise.all([
    listCampaignDocuments(id),
    listLibrary(userId),
    getActiveSummary(id),
  ]);

  const hasReadyDocument = associated.some((doc) => doc.status === "ready");

  return (
    <div className="space-y-8">
      <CampaignHeader
        campaign={{
          id: campaign.id,
          name: campaign.name,
          gameSystem: campaign.gameSystem,
        }}
      />

      <div className="flex items-center gap-3">
        {hasReadyDocument ? (
          <Link
            href={`/campaigns/${campaign.id}/play`}
            className="rounded bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500"
          >
            Avvia partita
          </Link>
        ) : (
          <span
            title="Serve almeno un documento pronto per avviare la partita"
            className="cursor-not-allowed rounded bg-zinc-800 px-5 py-2.5 font-medium text-zinc-500"
          >
            Avvia partita
          </span>
        )}
        {!hasReadyDocument && (
          <span className="text-sm text-zinc-500">
            Serve almeno un documento pronto.
          </span>
        )}
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Documenti associati</h2>
          <ManageDocuments
            campaignId={campaign.id}
            library={library.map((doc) => ({
              id: doc.id,
              title: doc.title,
              description: doc.description,
              docType: doc.docType,
              status: doc.status,
            }))}
            selectedIds={associated.map((doc) => doc.id)}
          />
        </div>

        {associated.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
            Nessun documento associato. Usa &ldquo;Gestisci documenti&rdquo; per
            aggiungerne dalla libreria.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded border border-zinc-800">
            {associated.map((doc) => (
              <li key={doc.id} className="flex items-start gap-3 p-3">
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{doc.title}</span>
                    <span className="text-xs text-zinc-500">
                      {docTypeLabels[doc.docType] ?? doc.docType}
                    </span>
                    <StatusBadge status={doc.status} />
                  </div>
                  {doc.description && (
                    <p className="mt-0.5 text-sm text-zinc-400">{doc.description}</p>
                  )}
                  {doc.status === "error" && doc.errorMessage && (
                    <p className="mt-1 text-sm text-red-400">{doc.errorMessage}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CampaignInstructions
        campaignId={campaign.id}
        initialInstructions={campaign.aiInstructions}
      />

      <CampaignSummary
        campaignId={campaign.id}
        initialSummary={
          summary && {
            id: summary.id,
            content: summary.content,
            isUserEdited: summary.isUserEdited,
            createdAt: summary.createdAt.toISOString(),
          }
        }
      />
    </div>
  );
}
