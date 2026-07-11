import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  campaignDocuments,
  campaigns,
  campaignSummaries,
  documents,
  users,
} from "@/db/schema";

// La registrazione è consentita solo per creare il primo (e unico) utente.
export async function hasAnyUser() {
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  return !!existing;
}

// Lista campagne con conteggio documenti e data ultimo messaggio.
export async function listCampaigns(userId: string) {
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      gameSystem: campaigns.gameSystem,
      createdAt: campaigns.createdAt,
      lastPlayedAt: campaigns.lastPlayedAt,
      documentCount: sql<number>`count(distinct ${campaignDocuments.documentId})::int`,
      lastMessageAt: sql<Date | null>`(
        select max(m.created_at) from messages m where m.campaign_id = ${campaigns.id}
      )`,
    })
    .from(campaigns)
    .leftJoin(campaignDocuments, eq(campaignDocuments.campaignId, campaigns.id))
    .where(eq(campaigns.userId, userId))
    .groupBy(campaigns.id)
    .orderBy(desc(campaigns.createdAt));
}

export async function getCampaign(userId: string, campaignId: string) {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)));
  return campaign ?? null;
}

// Riassunto attivo di una campagna: la riga più recente (append-only).
export async function getActiveSummary(campaignId: string) {
  const [summary] = await db
    .select()
    .from(campaignSummaries)
    .where(eq(campaignSummaries.campaignId, campaignId))
    .orderBy(desc(campaignSummaries.createdAt))
    .limit(1);
  return summary ?? null;
}

// Documenti associati a una campagna.
export async function listCampaignDocuments(campaignId: string) {
  return db
    .select({
      id: documents.id,
      title: documents.title,
      description: documents.description,
      docType: documents.docType,
      status: documents.status,
      errorMessage: documents.errorMessage,
    })
    .from(campaignDocuments)
    .innerJoin(documents, eq(documents.id, campaignDocuments.documentId))
    .where(eq(campaignDocuments.campaignId, campaignId))
    .orderBy(documents.title);
}

// Libreria dell'utente con le campagne che usano ogni documento.
export async function listLibrary(userId: string) {
  const docs = await db
    .select()
    .from(documents)
    .where(eq(documents.userId, userId))
    .orderBy(desc(documents.createdAt));

  const usage =
    docs.length === 0
      ? []
      : await db
          .select({
            documentId: campaignDocuments.documentId,
            campaignId: campaigns.id,
            campaignName: campaigns.name,
          })
          .from(campaignDocuments)
          .innerJoin(campaigns, eq(campaigns.id, campaignDocuments.campaignId))
          .where(
            inArray(
              campaignDocuments.documentId,
              docs.map((d) => d.id),
            ),
          );

  return docs.map((doc) => ({
    ...doc,
    usedBy: usage
      .filter((u) => u.documentId === doc.id)
      .map((u) => ({ id: u.campaignId, name: u.campaignName })),
  }));
}

// Verifica che tutti i documenti esistano e appartengano all'utente.
export async function ownsAllDocuments(userId: string, documentIds: string[]) {
  if (documentIds.length === 0) return true;
  const owned = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), inArray(documents.id, documentIds)));
  return owned.length === documentIds.length;
}

// Sostituisce l'insieme dei documenti associati a una campagna.
export async function replaceCampaignDocuments(
  campaignId: string,
  documentIds: string[],
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(campaignDocuments)
      .where(eq(campaignDocuments.campaignId, campaignId));
    if (documentIds.length > 0) {
      await tx
        .insert(campaignDocuments)
        .values(documentIds.map((documentId) => ({ campaignId, documentId })));
    }
  });
}
