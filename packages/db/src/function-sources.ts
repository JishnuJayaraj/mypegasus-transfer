import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";

/** `packages/db/sql`: `manifest.json`, `functions/<area>/<name>.sql`, `triggers/<table>.sql`. */
export const sourcesFolder = fileURLToPath(new URL("../sql", import.meta.url));

/** The migration that creates `function_source`; a journal without it predates the sources. */
export const functionSourceMigration = "0116_function_source";

export interface SourceManifest {
  /**
   * Functions without a source: a table's constraint, default or index expression depends on
   * them, so a change needs a migration that revalidates or rebuilds (ADR-0002, function sources).
   */
  migrationOwnedFunctions: string[];
  /** Every source file, relative to the folder, in the order they are applied. */
  sources: string[];
}

const sourceFiles = (folder: string, kind: string): string[] =>
  readdirSync(join(folder, kind), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"));

/** The manifest; refuses a source file it doesn't list, a listed one that is missing, a duplicate. */
export function readSourceManifest(folder = sourcesFolder): SourceManifest {
  const manifest = JSON.parse(
    readFileSync(join(folder, "manifest.json"), "utf8"),
  ) as SourceManifest;
  const present = [...sourceFiles(folder, "functions"), ...sourceFiles(folder, "triggers")];
  const listed = new Set(manifest.sources);
  const unlisted = present.filter((file) => !listed.has(file));
  const missing = manifest.sources.filter((file) => !present.includes(file));
  if (unlisted.length > 0 || missing.length > 0 || listed.size !== manifest.sources.length) {
    throw new Error(
      `function sources: manifest.json and the files differ (unlisted: ${unlisted.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}; duplicates: ${manifest.sources.length - listed.size})`,
    );
  }
  return manifest;
}

export const sha256 = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

/**
 * Applies every source whose SHA-256 differs from the one recorded in `function_source`, in the
 * manifest's order, and records it; all in one transaction or none (ADR-0002, function sources).
 * Runs as transfer_owner after the migrations have committed. Refuses when the database doesn't
 * stand at the last migration of `migrations`. A journal from before the sources applies nothing.
 * Returns the names applied.
 */
export async function applyFunctionSources(
  client: PoolClient,
  migrations: string,
  sources = sourcesFolder,
): Promise<string[]> {
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  if (!journal.entries.some((entry) => entry.tag === functionSourceMigration)) return [];
  const manifest = readSourceManifest(sources);
  const applied: string[] = [];
  await client.query("begin");
  try {
    const { rows: head } = await client.query<{ complete: boolean }>(
      "select coalesce(max(created_at) = $1, false) as complete from drizzle.__drizzle_migrations",
      [journal.entries.at(-1)!.when],
    );
    if (!head[0]!.complete) {
      throw new Error(
        "function sources: the database is not at the last migration; nothing applied",
      );
    }
    // Two migration runs at once apply one after the other.
    await client.query("lock table public.function_source in exclusive mode");
    const { rows } = await client.query<{ name: string; sha256: string }>(
      "select name, sha256 from public.function_source",
    );
    const recorded = new Map(rows.map((row) => [row.name, row.sha256]));
    for (const name of manifest.sources) {
      const content = readFileSync(join(sources, name), "utf8");
      const hash = sha256(content);
      if (recorded.get(name) === hash) continue;
      try {
        await client.query(content);
      } catch (error) {
        throw new Error(`function sources: ${name} failed; nothing applied`, { cause: error });
      }
      await client.query(
        `insert into public.function_source (name, sha256) values ($1, $2)
         on conflict (name) do update set sha256 = excluded.sha256, applied_at = now()`,
        [name, hash],
      );
      applied.push(name);
    }
    // A removed source: its function or trigger is dropped by a migration.
    await client.query("delete from public.function_source where name <> all($1::text[])", [
      manifest.sources,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  return applied;
}
