import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { campaigns } from "@/db/schema";
import { badRequest, forbidden, notFound, parseId, unauthorized } from "@/lib/api";
import { asciiSlug } from "@/lib/format";
import { renderCampaignModulePdf } from "@/lib/module";
import { enqueueGenerateModule } from "@/lib/queue";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";

type Params = { params: Promise<{ id: string }> };

// Stato del modulo per la UI. Retrocompatibilità: i moduli generati
// prima della colonna module_status hanno il markdown ma status null.
function moduleStatus(campaign: {
  moduleStatus: "pending" | "ready" | "error" | null;
  moduleMarkdown: string | null;
}): "pending" | "ready" | "error" | null {
  return campaign.moduleStatus ?? (campaign.moduleMarkdown ? "ready" : null);
}

// POST /api/campaigns/[id]/module — accoda il job generate-module (la
// generazione LLM dura minuti: gira nel worker, non nella richiesta) e
// risponde subito. La UI segue l'avanzamento con GET ?format=status.
export async function POST(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  if (!campaign.concludedAt) {
    return forbidden(
      "Il modulo si può creare solo quando la campagna è conclusa.",
    );
  }
  // Nessun guard sullo stato pending: i duplicati li evita già il
  // singletonKey della coda, e così un job perso (worker caduto a metà)
  // si sblocca semplicemente richiedendo di nuovo la generazione.
  // Stato prima dell'enqueue: se il worker fosse velocissimo, un update
  // successivo sovrascriverebbe il suo esito.
  await db
    .update(campaigns)
    .set({ moduleStatus: "pending", moduleError: null })
    .where(eq(campaigns.id, id));
  await enqueueGenerateModule(id);

  return NextResponse.json({ status: "pending" }, { status: 202 });
}

// GET /api/campaigns/[id]/module?format=pdf|md|status — scarica il
// modulo già generato (PDF impaginato in stile GdR, default, oppure il
// markdown), o riporta lo stato del job per il polling della UI.
export async function GET(request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const format = new URL(request.url).searchParams.get("format") ?? "pdf";

  if (format === "status") {
    return NextResponse.json({
      status: moduleStatus(campaign),
      generatedAt: campaign.moduleGeneratedAt?.toISOString() ?? null,
      error: campaign.moduleError,
    });
  }

  if (!campaign.moduleMarkdown) {
    return badRequest("Il modulo non è ancora stato generato.");
  }

  const slug = asciiSlug(campaign.name);

  if (format === "md") {
    return new Response(campaign.moduleMarkdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="modulo-${slug}.md"`,
      },
    });
  }

  const pdf = await renderCampaignModulePdf(campaign, campaign.moduleMarkdown);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="modulo-${slug}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
