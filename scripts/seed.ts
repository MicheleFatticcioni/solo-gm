import "dotenv/config";
import { hash } from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";

import * as schema from "../src/db/schema";

async function main() {
  const firstName = process.env.APP_USER_FIRST_NAME;
  const lastName = process.env.APP_USER_LAST_NAME;
  const email = process.env.APP_USER_EMAIL;
  const password = process.env.APP_USER_PASSWORD;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL non impostata");
  if (!firstName || !lastName || !email || !password) {
    throw new Error(
      "APP_USER_FIRST_NAME, APP_USER_LAST_NAME, APP_USER_EMAIL e APP_USER_PASSWORD sono richieste per il seed",
    );
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  const existing = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
  });

  if (existing) {
    console.log(`Utente ${email} già presente, nessuna modifica.`);
  } else {
    await db.insert(schema.users).values({
      firstName,
      lastName,
      email,
      passwordHash: await hash(password, 12),
    });
    console.log(`Utente ${email} creato.`);
  }

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
