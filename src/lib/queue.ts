import { PgBoss, type Queue, type QueueOptions } from "pg-boss";

export const PROCESS_PDF_QUEUE = "process-pdf";
export const UPDATE_WIKI_QUEUE = "update-wiki";
export const GENERATE_MODULE_QUEUE = "generate-module";

export type ProcessPdfJobData = { documentId: string };
export type UpdateWikiJobData = { campaignId: string };
export type GenerateModuleJobData = { campaignId: string };

// Opzioni condivise tra app e worker: createQueue è un upsert,
// quindi entrambi possono chiamarla senza coordinarsi.
export const PROCESS_PDF_QUEUE_OPTIONS: QueueOptions = {
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  // un manuale da 100+ pagine con rate limit sugli embeddings
  // può superare il default di 15 minuti
  expireInSeconds: 3600,
};

export const UPDATE_WIKI_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  // stately + singletonKey=campaignId: al più un job accodato e uno
  // attivo per campagna — niente run concorrenti né duplicati in coda.
  policy: "stately",
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
};

export const GENERATE_MODULE_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  // stately + singletonKey=campaignId: una generazione alla volta per
  // campagna. Niente retry automatici: ogni tentativo è una chiamata
  // LLM a pagamento, il job marca module_status=error e si riprova
  // esplicitamente dalla UI. Con le continuazioni la generazione può
  // superare abbondantemente i 15 minuti di default.
  policy: "stately",
  retryLimit: 0,
  expireInSeconds: 3600,
};

// Singleton lato Next: solo enqueue, niente supervisione né cron
// (quelle girano nel worker). Stesso pattern anti hot-reload di src/db.
const globalForQueue = globalThis as unknown as { pgBoss?: Promise<PgBoss> };

async function createBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
    supervise: false,
    schedule: false,
  });
  boss.on("error", (error) => {
    console.error("pg-boss error:", error);
  });
  await boss.start();
  await boss.createQueue(PROCESS_PDF_QUEUE, PROCESS_PDF_QUEUE_OPTIONS);
  await boss.createQueue(UPDATE_WIKI_QUEUE, UPDATE_WIKI_QUEUE_OPTIONS);
  await boss.createQueue(GENERATE_MODULE_QUEUE, GENERATE_MODULE_QUEUE_OPTIONS);
  return boss;
}

function getBoss(): Promise<PgBoss> {
  return (globalForQueue.pgBoss ??= createBoss());
}

export async function enqueueProcessPdf(documentId: string): Promise<void> {
  const boss = await getBoss();
  const data: ProcessPdfJobData = { documentId };
  await boss.send(PROCESS_PDF_QUEUE, data);
}

export async function enqueueUpdateWiki(campaignId: string): Promise<void> {
  const boss = await getBoss();
  const data: UpdateWikiJobData = { campaignId };
  await boss.send(UPDATE_WIKI_QUEUE, data, { singletonKey: campaignId });
}

export async function enqueueGenerateModule(campaignId: string): Promise<void> {
  const boss = await getBoss();
  const data: GenerateModuleJobData = { campaignId };
  await boss.send(GENERATE_MODULE_QUEUE, data, { singletonKey: campaignId });
}
