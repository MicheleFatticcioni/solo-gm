import "dotenv/config";
import { inArray } from "drizzle-orm";

import { db } from "../src/db";
import { documents, users } from "../src/db/schema";

async function main() {
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  const inserted = await db
    .insert(documents)
    .values([
      {
        userId: user.id,
        title: "[TEST-DELETE] doc",
        storagePath: "/dev/null",
        description: "x",
        docType: "altro",
        status: "ready",
      },
    ])
    .returning({ id: documents.id });
  console.log("inseriti:", inserted);

  const deleted = await db
    .delete(documents)
    .where(inArray(documents.id, inserted.map((d) => d.id)))
    .returning({ id: documents.id });
  console.log("cancellati:", deleted);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
