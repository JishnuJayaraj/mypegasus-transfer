import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies all pending migrations. Must run as transfer_owner (DATABASE_MIGRATION_URL). */
export async function runMigrations(connectionString: string): Promise<void> {
  const db = createDb(connectionString);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.$client.end();
  }
}
