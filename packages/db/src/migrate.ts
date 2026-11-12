import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";
import { applyFunctionSources, sourcesFolder } from "./function-sources";
import { installJobsSchema } from "./jobs-schema";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies all pending migrations, then the function and trigger sources that changed (ADR-0002,
 * function sources), then installs or upgrades pg-boss's schema and re-applies its grants
 * (ADR-0011). A failed migration throws before any source is applied. Must run as transfer_owner
 * (DATABASE_MIGRATION_URL). The API bundle passes the folders it ships next to it
 * (`dist/migrations`, `dist/sql`). Returns the sources applied.
 */
export async function runMigrations(
  connectionString: string,
  folder = migrationsFolder,
  sources = sourcesFolder,
): Promise<string[]> {
  const db = createDb(connectionString);
  try {
    await migrate(db, { migrationsFolder: folder });
    const client = await db.$client.connect();
    try {
      const applied = await applyFunctionSources(client, folder, sources);
      await installJobsSchema(client);
      return applied;
    } finally {
      client.release();
    }
  } finally {
    await db.$client.end();
  }
}
