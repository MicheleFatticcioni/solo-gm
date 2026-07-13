import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, sql } from "drizzle-orm";

// Import relativi (niente alias @/): questo modulo è usato anche dal
// worker, che gira con tsx senza la risoluzione dei path di Next.
import { db } from "../db";
import { wikiPages } from "../db/schema";

// Cartelle della wiki (enum chiuso, allineato a wiki_folder in schema).
// "core" contiene solo core/panoramica; "note" sono le note temporanee:
// entrambe stanno SEMPRE nel nucleo in contesto, il resto si legge on
// demand via tool use.
export const WIKI_FOLDERS = [
  "core",
  "pg",
  "npc",
  "luoghi",
  "eventi",
  "storia",
  "note",
] as const;

export type WikiFolder = (typeof WIKI_FOLDERS)[number];

export const WIKI_FOLDER_LABELS: Record<WikiFolder, string> = {
  core: "Panoramica",
  pg: "Personaggi giocanti",
  npc: "Personaggi non giocanti",
  luoghi: "Luoghi",
  eventi: "Eventi chiave",
  storia: "Storia",
  note: "Note temporanee",
};

export const CORE_SLUG = "panoramica";

// Cadenza dell'archiviazione, condivisa tra il job update-wiki e il
// trigger della chat. Gli ultimi WIKI_TAIL_GUARD messaggi restano
// sempre fuori dalla finestra archiviata; il job vale la pena solo
// quando i messaggi archiviabili sono almeno WIKI_MIN_NEW_MESSAGES.
// Il backlog non archiviato oscilla quindi tra TAIL_GUARD e
// TAIL_GUARD + MIN_NEW_MESSAGES messaggi (più quelli arrivati durante
// un run): la storia recente di context.ts li copre tutti, perché è
// ancorata al watermark e non a un cap fisso.
export const WIKI_TAIL_GUARD = 4;
export const WIKI_MIN_NEW_MESSAGES = 6;

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export function isWikiFolder(value: string): value is WikiFolder {
  return (WIKI_FOLDERS as readonly string[]).includes(value);
}

export function isValidSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

// Titolo → slug kebab-case ("Lord Anor" → "lord-anor").
export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
}

export type WikiPageMeta = {
  folder: WikiFolder;
  slug: string;
  title: string;
  description: string;
  updatedAt: Date;
};

export async function getWikiPages(campaignId: string) {
  return db
    .select()
    .from(wikiPages)
    .where(eq(wikiPages.campaignId, campaignId))
    .orderBy(asc(wikiPages.folder), asc(wikiPages.slug));
}

export async function getWikiPage(
  campaignId: string,
  folder: WikiFolder,
  slug: string,
) {
  const [page] = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.campaignId, campaignId),
        eq(wikiPages.folder, folder),
        eq(wikiPages.slug, slug),
      ),
    );
  return page ?? null;
}

export type WikiPageInput = {
  folder: WikiFolder;
  slug: string;
  title: string;
  description: string;
  content: string;
};

// Upsert su (campaign_id, folder, slug): le pagine si aggiornano in
// place, la storia integrale resta comunque nei messages.
export async function upsertWikiPage(campaignId: string, input: WikiPageInput) {
  const [saved] = await db
    .insert(wikiPages)
    .values({ campaignId, ...input })
    .onConflictDoUpdate({
      target: [wikiPages.campaignId, wikiPages.folder, wikiPages.slug],
      set: {
        title: input.title,
        description: input.description,
        content: input.content,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return saved;
}

export async function deleteWikiPage(
  campaignId: string,
  folder: WikiFolder,
  slug: string,
): Promise<boolean> {
  const deleted = await db
    .delete(wikiPages)
    .where(
      and(
        eq(wikiPages.campaignId, campaignId),
        eq(wikiPages.folder, folder),
        eq(wikiPages.slug, slug),
      ),
    )
    .returning({ id: wikiPages.id });
  return deleted.length > 0;
}

// Indice testuale della wiki: una riga per pagina, raggruppata per
// cartella. È generato da query a ogni uso, mai manutenuto dall'LLM
// (un indice manutenuto a mano diventa subito stale).
export function buildWikiIndex(pages: WikiPageMeta[]): string {
  const listed = pages.filter((p) => p.folder !== "core" && p.folder !== "note");
  if (listed.length === 0) {
    return "(la wiki non ha ancora pagine oltre al nucleo)";
  }
  const sections: string[] = [];
  for (const folder of WIKI_FOLDERS) {
    if (folder === "core" || folder === "note") continue;
    const inFolder = listed.filter((p) => p.folder === folder);
    if (inFolder.length === 0) continue;
    const rows = inFolder
      .map((p) => `- ${p.folder}/${p.slug} — ${p.title}: ${p.description}`)
      .join("\n");
    sections.push(`### ${WIKI_FOLDER_LABELS[folder]}\n${rows}`);
  }
  return sections.join("\n\n");
}

// Nucleo della memoria sempre in contesto: pagina core + note temporanee
// + indice del resto della wiki. Ritorna null se la wiki è vuota (il
// chiamante fa fallback al riassunto legacy del modulo f).
export async function buildMemoryBlock(campaignId: string): Promise<string | null> {
  const pages = await getWikiPages(campaignId);
  if (pages.length === 0) return null;

  const core = pages.find((p) => p.folder === "core" && p.slug === CORE_SLUG);
  const notes = pages.filter((p) => p.folder === "note");

  const parts: string[] = [];
  parts.push(
    core
      ? `## Panoramica della campagna\n\n${core.content}`
      : "## Panoramica della campagna\n\n(non ancora scritta)",
  );
  if (notes.length > 0) {
    const noteBlocks = notes
      .map((n) => `### ${n.title}\n${n.content}`)
      .join("\n\n");
    parts.push(`## Note temporanee\n\n${noteBlocks}`);
  }
  parts.push(
    `## Indice della wiki\n\nPagine consultabili con lo strumento read_wiki_page:\n\n${buildWikiIndex(pages)}`,
  );
  return parts.join("\n\n");
}

// Tool di lettura per il GM: il contenuto delle pagine entra nella
// conversazione DOPO il prefisso cacheable, quindi il costo è pieno —
// da qui il limite esplicito nella descrizione.
export const readWikiPageTool: Anthropic.Tool = {
  name: "read_wiki_page",
  description:
    "Legge una pagina della wiki della campagna (memoria a lungo termine). Scegli le pagine dall'indice nella memoria. Leggi SOLO le pagine rilevanti per la scena corrente, al massimo 2-3 per turno, e non rileggere una pagina già letta in questo turno.",
  input_schema: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        enum: WIKI_FOLDERS.filter((f) => f !== "core" && f !== "note"),
        description: "Cartella della pagina, come nell'indice",
      },
      slug: {
        type: "string",
        description: "Slug della pagina, es. 'lord-anor' per npc/lord-anor",
      },
    },
    required: ["folder", "slug"],
    additionalProperties: false,
  },
  strict: true,
};

export type ReadWikiPageInput = { folder: string; slug: string };
