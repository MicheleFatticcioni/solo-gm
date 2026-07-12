import { NextResponse } from "next/server";
import { z } from "zod";

import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";
import {
  getWikiPage,
  getWikiPages,
  isValidSlug,
  upsertWikiPage,
  WIKI_FOLDERS,
  WIKI_FOLDER_LABELS,
  type WikiFolder,
} from "@/lib/wiki";

type Params = { params: Promise<{ id: string }> };

// GET /api/campaigns/[id]/wiki — albero della wiki (solo metadati).
export async function GET(_request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const pages = await getWikiPages(id);
  const folders = WIKI_FOLDERS.map((folder) => ({
    folder,
    label: WIKI_FOLDER_LABELS[folder],
    pages: pages
      .filter((p) => p.folder === folder)
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        description: p.description,
        updatedAt: p.updatedAt,
      })),
  }));

  return NextResponse.json({ folders });
}

const createSchema = z.object({
  folder: z.enum(WIKI_FOLDERS),
  slug: z.string().trim(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

// POST /api/campaigns/[id]/wiki — crea una pagina (409 se esiste già).
export async function POST(request: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const id = parseId((await params).id);
  if (!id) return notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) return notFound();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Campi mancanti o non validi");
  const { folder, slug, title, description, content } = parsed.data;
  if (!isValidSlug(slug)) {
    return badRequest("Slug non valido: kebab-case, solo a-z, 0-9 e trattini");
  }

  const existing = await getWikiPage(id, folder as WikiFolder, slug);
  if (existing) {
    return NextResponse.json(
      { error: `La pagina ${folder}/${slug} esiste già` },
      { status: 409 },
    );
  }

  const saved = await upsertWikiPage(id, {
    folder: folder as WikiFolder,
    slug,
    title,
    description,
    content,
  });
  return NextResponse.json(saved, { status: 201 });
}
