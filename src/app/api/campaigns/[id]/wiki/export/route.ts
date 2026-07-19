import JSZip from "jszip";

import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { asciiSlug } from "@/lib/format";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";
import { getWikiPages, WIKI_FOLDER_LABELS } from "@/lib/wiki";

// GET /api/campaigns/[id]/wiki/export — scarica la wiki come archivio
// zip, un file markdown per pagina dentro la sua cartella
// (npc/lord-anor.md, luoghi/taverna.md, ...). Titolo e descrizione
// stanno nel frontmatter: nel DB sono colonne, nel file vanno conservati.
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

  const pages = await getWikiPages(id);
  if (pages.length === 0) {
    return badRequest("La wiki non ha ancora pagine da esportare.");
  }

  const zip = new JSZip();
  for (const page of pages) {
    const frontmatter = [
      "---",
      `title: ${JSON.stringify(page.title)}`,
      `description: ${JSON.stringify(page.description)}`,
      `folder: ${page.folder} (${WIKI_FOLDER_LABELS[page.folder]})`,
      `updated: ${page.updatedAt.toISOString()}`,
      "---",
    ].join("\n");
    // Molte pagine iniziano già con "# Titolo": il titolo si aggiunge
    // solo quando manca, per non duplicarlo.
    const body = page.content.trimStart().startsWith("# ")
      ? page.content
      : `# ${page.title}\n\n${page.content}`;
    zip.file(`${page.folder}/${page.slug}.md`, `${frontmatter}\n\n${body}\n`);
  }

  const archive = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });

  return new Response(new Uint8Array(archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="wiki-${asciiSlug(campaign.name)}.zip"`,
    },
  });
}
