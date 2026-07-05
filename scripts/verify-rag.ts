// Script di verifica temporaneo per il modulo (d) — motore RAG.
// Inserisce documenti/campagne di test con embeddings reali, esegue i
// criteri di accettazione e ripulisce tutto. Eseguire con:
//   npx tsx scripts/verify-rag.ts
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db";
import {
  campaignDocuments,
  campaigns,
  chunks,
  documents,
  users,
} from "../src/db/schema";
import { buildGmContext } from "../src/lib/context";
import { embed } from "../src/lib/embeddings";
import { retrieve } from "../src/lib/rag";

const TEST_PREFIX = "[TEST-RAG]";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  if (!user) throw new Error("Nessun utente nel DB: esegui prima il seed");

  // --- Setup dati di test -------------------------------------------------
  const [bestiario, regolamento] = await db
    .insert(documents)
    .values([
      {
        userId: user.id,
        title: `${TEST_PREFIX} Bestiario di Prova`,
        storagePath: "/dev/null",
        description: "Bestiario con mostri delle terre selvagge",
        docType: "bestiario",
        status: "ready",
      },
      {
        userId: user.id,
        title: `${TEST_PREFIX} Regolamento di Prova`,
        storagePath: "/dev/null",
        description: "Regole base: combattimento, recupero, avventura",
        docType: "regolamento",
        status: "ready",
      },
    ])
    .returning({ id: documents.id });

  const chunkContents = [
    "Grifone Cinereo. Creatura leggendaria delle vette montane. Punti Ferita 42, Armatura 5. Attacchi: artigli (2d6 danni), becco (1d10 danni). Il Grifone Cinereo nidifica sulle cime più alte e piomba sulle prede in picchiata; se colpito alle ali è costretto ad atterrare.",
    "Idra di Palude. Serpente a cinque teste che infesta gli acquitrini. Punti Ferita 60, Armatura 3. Ogni testa mozzata ricresce doppia al turno successivo, a meno che il moncherino non venga cauterizzato con il fuoco.",
    "Recupero delle forze. Quando gli avventurieri si accampano in un luogo sicuro e dormono per almeno otto ore, al risveglio recuperano tutti i punti ferita e metà dei dadi vita spesi. Un sonno interrotto da un combattimento o da una veglia forzata non concede alcun beneficio.",
    "Ordine di iniziativa. All'inizio del combattimento ogni partecipante tira 1d20 e somma il proprio modificatore di Destrezza; si agisce in ordine decrescente. In caso di parità agisce per primo il personaggio con la Destrezza più alta.",
  ];
  const embeddings = await embed(chunkContents, "document");

  await db.insert(chunks).values([
    { documentId: bestiario.id, chunkIndex: 0, pageStart: 45, pageEnd: 46, content: chunkContents[0], embedding: embeddings[0] },
    { documentId: bestiario.id, chunkIndex: 5, pageStart: 52, pageEnd: 53, content: chunkContents[1], embedding: embeddings[1] },
    { documentId: regolamento.id, chunkIndex: 0, pageStart: 12, pageEnd: 13, content: chunkContents[2], embedding: embeddings[2] },
    { documentId: regolamento.id, chunkIndex: 5, pageStart: 30, pageEnd: 31, content: chunkContents[3], embedding: embeddings[3] },
  ]);

  const [campA, campB] = await db
    .insert(campaigns)
    .values([
      { userId: user.id, name: `${TEST_PREFIX} Campagna A`, gameSystem: "D&D 5e" },
      { userId: user.id, name: `${TEST_PREFIX} Campagna B`, gameSystem: "D&D 5e" },
    ])
    .returning({ id: campaigns.id });

  // A → entrambi i documenti; B → solo il regolamento (per l'isolamento).
  await db.insert(campaignDocuments).values([
    { campaignId: campA.id, documentId: bestiario.id },
    { campaignId: campA.id, documentId: regolamento.id },
    { campaignId: campB.id, documentId: regolamento.id },
  ]);

  try {
    // --- Criterio 1: termine esatto ---------------------------------------
    const exact = await retrieve(campA.id, "Grifone Cinereo");
    check(
      "C1 — termine esatto trova il chunk giusto",
      exact.length > 0 &&
        exact[0].content.includes("Grifone Cinereo") &&
        exact[0].documentTitle.includes("Bestiario") &&
        exact[0].pageStart === 45 &&
        exact[0].pageEnd === 46,
      exact[0] && `top: "${exact[0].documentTitle}" pagg. ${exact[0].pageStart}-${exact[0].pageEnd}, score ${exact[0].score.toFixed(4)}`,
    );

    // --- Criterio 2: linguaggio naturale senza match lessicale ------------
    // Il chunk parla di "recupero delle forze"/"dormono otto ore", mai di
    // "riposo lungo": deve funzionare il ramo semantico.
    const natural = await retrieve(campA.id, "come funziona il riposo lungo?");
    const naturalHit = natural.findIndex((c) => c.content.includes("Recupero delle forze"));
    check(
      "C2 — query naturale trova il chunk semanticamente",
      naturalHit >= 0 && naturalHit < 3,
      `chunk del recupero in posizione ${naturalHit + 1} su ${natural.length}`,
    );

    // --- Criterio 3: isolamento per campagna ------------------------------
    const isolated = await retrieve(campB.id, "Grifone Cinereo");
    const leaked = isolated.some((c) => c.documentId === bestiario.id);
    check(
      "C3 — la campagna B non vede il bestiario",
      !leaked,
      `${isolated.length} chunk restituiti, tutti dal regolamento: ${isolated.every((c) => c.documentId === regolamento.id)}`,
    );

    // --- Criterio 4: struttura buildGmContext ------------------------------
    const ctx = await buildGmContext(campA.id, "Attacco il grifone con la spada!");
    const allCached = ctx.system.every(
      (b) => b.cache_control?.type === "ephemeral",
    );
    const lastMessage = ctx.messages[ctx.messages.length - 1];
    const lastContent = typeof lastMessage.content === "string" ? lastMessage.content : "";
    check(
      "C4 — system: 3 blocchi con cache_control ephemeral",
      ctx.system.length === 3 && allCached,
    );
    check(
      "C4 — system[0..2] = istruzioni GM / catalogo / riassunto",
      ctx.system[0].text.includes("Game Master") &&
        ctx.system[0].text.includes("D&D 5e") &&
        ctx.system[1].text.includes("Bestiario di Prova") &&
        ctx.system[2].text.includes("Nuova campagna"),
    );
    check(
      "C4 — turno user con <estratti_manuali> e messaggio giocatore",
      lastMessage.role === "user" &&
        lastContent.includes("<estratti_manuali>") &&
        lastContent.includes('pagine="45-46"') &&
        lastContent.trimEnd().endsWith("Attacco il grifone con la spada!"),
    );
    check(
      "C4 — retrieved popolato per i metadata",
      ctx.retrieved.length > 0,
      `${ctx.retrieved.length} chunk`,
    );
  } finally {
    // --- Cleanup (cascade su chunks e campaign_documents) ------------------
    await db.delete(campaigns).where(inArray(campaigns.id, [campA.id, campB.id]));
    await db.delete(documents).where(inArray(documents.id, [bestiario.id, regolamento.id]));
    const [leftover] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.userId, user.id));
    console.log(`\nCleanup completato (documenti residui dell'utente: ${leftover ? "presenti" : "nessuno"}).`);
  }

  if (failures > 0) {
    console.error(`\n${failures} verifiche fallite.`);
    process.exit(1);
  }
  console.log("\nTutte le verifiche superate.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
