import { NextResponse } from "next/server";
import { z } from "zod";

import { badRequest, notFound, parseId, unauthorized } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";
import {
  deleteWikiPage,
  getWikiPage,
  isValidSlug,
  isWikiFolder,
  upsertWikiPage,
  type WikiFolder,
} from "@/lib/wiki";

type Params = { params: Promise<{ id: string; folder: string; slug: string }> };

// Valida sessione + campagna + segmenti; null → il chiamante risponde 4xx.
async function resolve(params: Params["params"]) {
  const userId = await getUserId();
  if (!userId) return { error: unauthorized() } as const;

  const { id: rawId, folder, slug } = await params;
  const id = parseId(rawId);
  if (!id || !isWikiFolder(folder) || !isValidSlug(slug)) {
    return { error: notFound() } as const;
  }

  const campaign = await getCampaign(userId, id);
  if (!campaign) return { error: notFound() } as const;

  return { id, folder: folder as WikiFolder, slug } as const;
}

// GET /api/campaigns/[id]/wiki/[folder]/[slug] — pagina singola.
export async function GET(_request: Request, { params }: Params) {
  const resolved = await resolve(params);
  if ("error" in resolved) return resolved.error;

  const page = await getWikiPage(resolved.id, resolved.folder, resolved.slug);
  if (!page) return notFound();
  return NextResponse.json(page);
}

const putSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

// PUT — modifica manuale della pagina (upsert: crea anche se mancante).
export async function PUT(request: Request, { params }: Params) {
  const resolved = await resolve(params);
  if ("error" in resolved) return resolved.error;

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest("Campi mancanti o non validi");

  const saved = await upsertWikiPage(resolved.id, {
    folder: resolved.folder,
    slug: resolved.slug,
    ...parsed.data,
  });
  return NextResponse.json(saved);
}

// DELETE — elimina la pagina.
export async function DELETE(_request: Request, { params }: Params) {
  const resolved = await resolve(params);
  if ("error" in resolved) return resolved.error;

  const deleted = await deleteWikiPage(resolved.id, resolved.folder, resolved.slug);
  if (!deleted) return notFound();
  return new Response(null, { status: 204 });
}
