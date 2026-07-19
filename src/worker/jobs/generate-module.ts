import { eq } from "drizzle-orm";

import { db } from "../../db";
import { campaigns } from "../../db/schema";
import {
  EmptyCampaignError,
  generateModuleMarkdown,
} from "../../lib/module";
import { AiConfigError, getAiSettings } from "../../lib/settings";

// Genera il modulo d'avventura di una campagna conclusa e lo salva in
// campaigns.module_markdown. L'esito (ready/error) va sempre sul DB:
// è l'unico canale con cui la UI, che fa polling sullo stato, capisce
// com'è finita. Niente rethrow: il retry pg-boss ripeterebbe una
// chiamata LLM a pagamento, si riprova esplicitamente dalla UI.
export async function generateModule(campaignId: string): Promise<void> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));

  if (!campaign) {
    console.warn(`generate-module: campagna ${campaignId} non trovata`);
    return;
  }
  if (!campaign.concludedAt) {
    // Riaperta tra l'enqueue e l'esecuzione: il modulo non va generato.
    await db
      .update(campaigns)
      .set({
        moduleStatus: "error",
        moduleError: "La campagna è stata riaperta: concludila per generare il modulo.",
      })
      .where(eq(campaigns.id, campaignId));
    return;
  }

  try {
    // Single-tenant: senza userId si usa l'unica riga di impostazioni.
    const settings = await getAiSettings();
    const markdown = await generateModuleMarkdown(campaign, settings);

    await db
      .update(campaigns)
      .set({
        moduleMarkdown: markdown,
        moduleGeneratedAt: new Date(),
        moduleStatus: "ready",
        moduleError: null,
      })
      .where(eq(campaigns.id, campaignId));
    console.log(`generate-module: completato per campagna ${campaignId}`);
  } catch (error) {
    console.error(`generate-module: fallito per campagna ${campaignId}:`, error);
    const message =
      error instanceof AiConfigError || error instanceof EmptyCampaignError
        ? error.message
        : "La generazione del modulo non è riuscita, riprova tra poco.";
    await db
      .update(campaigns)
      .set({ moduleStatus: "error", moduleError: message })
      .where(eq(campaigns.id, campaignId));
  }
}
