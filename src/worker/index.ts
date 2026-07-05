import "dotenv/config";
import { PgBoss } from "pg-boss";

import {
  PROCESS_PDF_QUEUE,
  PROCESS_PDF_QUEUE_OPTIONS,
  UPDATE_SUMMARY_QUEUE,
  UPDATE_SUMMARY_QUEUE_OPTIONS,
  type ProcessPdfJobData,
  type UpdateSummaryJobData,
} from "../lib/queue";
import { processPdf } from "./jobs/process-pdf";
import { updateSummary } from "./jobs/update-summary";

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
  await boss.createQueue(UPDATE_SUMMARY_QUEUE, UPDATE_SUMMARY_QUEUE_OPTIONS);

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

  await boss.work<UpdateSummaryJobData>(UPDATE_SUMMARY_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`update-summary: avvio campagna ${job.data.campaignId}`);
      await updateSummary(job.data.campaignId);
    }
  });

  console.log("worker pronto");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
