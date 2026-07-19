import "dotenv/config";
import { PgBoss } from "pg-boss";

import {
  GENERATE_MODULE_QUEUE,
  GENERATE_MODULE_QUEUE_OPTIONS,
  PROCESS_PDF_QUEUE,
  PROCESS_PDF_QUEUE_OPTIONS,
  UPDATE_WIKI_QUEUE,
  UPDATE_WIKI_QUEUE_OPTIONS,
  type GenerateModuleJobData,
  type ProcessPdfJobData,
  type UpdateWikiJobData,
} from "../lib/queue";
import { generateModule } from "./jobs/generate-module";
import { processPdf } from "./jobs/process-pdf";
import { updateWiki } from "./jobs/update-wiki";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL non impostata");
  }

  const boss = new PgBoss(process.env.DATABASE_URL);
  boss.on("error", (error) => {
    console.error("pg-boss error:", error);
  });

  await boss.start();
  await boss.createQueue(PROCESS_PDF_QUEUE, PROCESS_PDF_QUEUE_OPTIONS);
  await boss.createQueue(UPDATE_WIKI_QUEUE, UPDATE_WIKI_QUEUE_OPTIONS);
  await boss.createQueue(GENERATE_MODULE_QUEUE, GENERATE_MODULE_QUEUE_OPTIONS);

  await boss.work<ProcessPdfJobData>(
    PROCESS_PDF_QUEUE,
    { localConcurrency: 2 },
    async (jobs) => {
      for (const job of jobs) {
        console.log(`process-pdf: avvio documento ${job.data.documentId}`);
        await processPdf(job.data.documentId);
      }
    },
  );

  await boss.work<UpdateWikiJobData>(UPDATE_WIKI_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`update-wiki: avvio campagna ${job.data.campaignId}`);
      await updateWiki(job.data.campaignId);
    }
  });

  await boss.work<GenerateModuleJobData>(GENERATE_MODULE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`generate-module: avvio campagna ${job.data.campaignId}`);
      await generateModule(job.data.campaignId);
    }
  });

  console.log("worker pronto");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
