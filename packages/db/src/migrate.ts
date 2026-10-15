import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies all pending migrations. Must run as transfer_owner (DATABASE_MIGRATION_URL). The API
 * bundle passes the folder it ships next to it (`dist/migrations`).
 */
export async function runMigrations(connectionString: string, folder = migrationsFolder) {
  const db = createDb(connectionString);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await db.$client.end();
  }
}
