import { eq } from "drizzle-orm";

import { db } from "@/db";
import { messages } from "@/db/schema";
import { notFound, parseId, unauthorized } from "@/lib/api";
import { getActiveSummary, getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";
import { CORE_SLUG, getWikiPage } from "@/lib/wiki";

const timestampFormatter = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "medium",
  timeStyle: "short",
});

// GET /api/campaigns/[id]/export — cronologia completa in markdown
// scaricabile: intestazione, panoramica della wiki (fallback: riassunto
// legacy del modulo f), poi tutti i messaggi.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const [core, summary, history] = await Promise.all([
    getWikiPage(id, "core", CORE_SLUG),
    getActiveSummary(id),
    db
      .select({
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.campaignId, id))
      .orderBy(messages.createdAt, messages.id),
  ]);

  const transcript = history
    .map((m) => {
      const who = m.role === "user" ? "Giocatore" : "GM";
      return `**${who}:** _(${timestampFormatter.format(m.createdAt)})_\n\n${m.content}`;
    })
    .join("\n\n---\n\n");

  const markdown = [
    `# ${campaign.name}`,
    `Sistema: ${campaign.gameSystem} — Esportata il ${timestampFormatter.format(new Date())}`,
    `## Panoramica della campagna`,
    core?.content ?? summary?.content ?? "_Nessuna panoramica generata._",
    `## Cronologia`,
    transcript || "_Nessun messaggio._",
  ].join("\n\n");

  // Slug ASCII per il filename: gli header non gradiscono i caratteri
  // non latini e le virgolette.
  const slug =
    campaign.name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "campagna";

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="partita-${slug}.md"`,
    },
  });
}
