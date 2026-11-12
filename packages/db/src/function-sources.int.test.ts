import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb } from "./client";
import {
  applyFunctionSources,
  functionSourceMigration,
  readSourceManifest,
  sha256,
  sourcesFolder,
} from "./function-sources";
import { migrationsFolder, runMigrations } from "./migrate";
import { seed } from "./seed";
import { activateAsOwner, informedParticipation, testDatabaseUrls } from "./testing";

// ADR-0002, function sources: the sources define what the migrations defined, the runner applies
// them atomically, and no function or trigger is left without a source.
const url = testDatabaseUrls().owner;
const pool = new Pool({ connectionString: url });
const query = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];
const manifest = readSourceManifest();
/** The hash of every source as extracted from the last migration that wrote functions (0115). */
const baseline = JSON.parse(
  readFileSync(join(sourcesFolder, "extraction-baseline.json"), "utf8"),
) as Record<string, string>;
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string; when: number }[];
};

const temp = mkdtempSync(join(tmpdir(), "transfer-function-sources-"));
/** A copy of the migrations: those before `idx`, then the given extra ones. */
function migrationsCopy(name: string, before: number, extra: Record<string, string> = {}) {
  const folder = join(temp, name);
  const entries = journal.entries.filter((entry) => entry.idx < before);
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const { tag } of entries)
    cpSync(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
  for (const [tag, sql] of Object.entries(extra)) {
    writeFileSync(join(folder, `${tag}.sql`), sql);
    const last = entries.at(-1)!;
    entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag });
  }
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}
function sourcesCopy(name: string) {
  const folder = join(temp, name);
  cpSync(sourcesFolder, folder, { recursive: true });
  return folder;
}
/** Sources that define nothing: the database as the migrations alone leave it. */
const noSources = join(temp, "none");
mkdirSync(join(noSources, "functions"), { recursive: true });
mkdirSync(join(noSources, "triggers"));
writeFileSync(join(noSources, "manifest.json"), '{"migrationOwnedFunctions":[],"sources":[]}');

interface FunctionRow {
  signature: string;
  name: string;
  body: string;
  definition: string;
  owner: string;
  securityDefiner: boolean;
  configuration: string[] | null;
  privileges: string[] | null;
}
interface TriggerRow {
  table: string;
  name: string;
  definition: string;
  enabled: string;
}
const ownFunctions = `pg_proc p where p.pronamespace = 'public'::regnamespace and not exists (
  select from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`;

/** Every function and trigger of the application: definition, owner, privileges, security, configuration. */
async function definitions() {
  const functions = await query<FunctionRow>(
    `select p.oid::regprocedure::text as signature, p.proname as name, p.prosrc as body,
       pg_get_functiondef(p.oid) as definition, p.proowner::regrole::text as owner,
       p.prosecdef as "securityDefiner", p.proconfig as configuration,
       (select array_agg(a::text order by a::text) from unnest(p.proacl) a) as privileges
     from ${ownFunctions} order by 1`,
  );
  const triggers = await query<TriggerRow>(
    `select c.relname as "table", t.tgname as name, pg_get_triggerdef(t.oid) as definition,
       t.tgenabled as enabled
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and c.relnamespace = 'public'::regnamespace order by 1, 2`,
  );
  return { functions, triggers };
}

/** Table, column and schema privileges, without the table this PR adds. */
const privileges = () =>
  query(
    `select 'table' as kind, table_name as object, grantee, privilege_type as privilege
       from information_schema.table_privileges
       where table_schema = 'public' and table_name <> 'function_source'
     union all
     select 'column', table_name || '.' || column_name, grantee, privilege_type
       from information_schema.column_privileges
       where table_schema = 'public' and table_name <> 'function_source'
     union all
     select 'schema', nspname, a.grantee::regrole::text, a.privilege_type
       from pg_namespace, aclexplode(nspacl) a where nspname in ('public', 'crypto')
     order by 1, 2, 3, 4`,
  );

/** Row count and content hash of every table but `function_source`. */
async function data() {
  const tables = await query<{ name: string }>(
    `select tablename as name from pg_tables
     where schemaname = 'public' and tablename <> 'function_source' order by 1`,
  );
  const result: Record<string, unknown> = {};
  for (const { name } of tables) {
    const rows = await query(
      `select count(*)::int as rows, md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) as hash
       from public."${name}" t`,
    );
    result[name] = rows[0];
  }
  return result;
}

const recorded = () =>
  query<{ name: string; sha256: string }>(
    "select name, sha256, applied_at from function_source order by name",
  );

const content = (file: string) => readFileSync(join(sourcesFolder, file), "utf8");

/** Functions and triggers no source defines (the allowlist excepted), and sources defining nothing. */
function withoutSource(db: Awaited<ReturnType<typeof definitions>>) {
  const files = new Map(manifest.sources.map((file) => [file.split("/").at(-1)!, file]));
  const defined = new Set<string>();
  const orphans: string[] = [];
  for (const f of db.functions) {
    if (manifest.migrationOwnedFunctions.includes(f.name)) continue;
    const file = files.get(`${f.name}.sql`);
    if (file?.startsWith("functions/") && content(file).includes(f.body)) defined.add(file);
    else orphans.push(f.signature);
  }
  for (const t of db.triggers) {
    const file = `triggers/${t.table}.sql`;
    if (
      manifest.sources.includes(file) &&
      content(file).includes(`CREATE OR REPLACE TRIGGER ${t.name} `)
    ) {
      defined.add(file);
    } else orphans.push(`${t.table}.${t.name}`);
  }
  return { orphans, idle: manifest.sources.filter((file) => !defined.has(file)) };
}

/**
 * The rows whose source is as extracted. A source changed since no longer equals its migration:
 * the diff of its file is the review of that change.
 */
function extracted<T extends { name: string; table?: string }>(rows: T[]): T[] {
  const files = new Map(manifest.sources.map((file) => [file.split("/").at(-1)!, file]));
  return rows.filter((row) => {
    const file = row.table ? `triggers/${row.table}.sql` : files.get(`${row.name}.sql`);
    return file !== undefined && baseline[file] === sha256(readFileSync(join(sourcesFolder, file)));
  });
}

let migrationsAlone: Awaited<ReturnType<typeof definitions>>;
let withSources: Awaited<ReturnType<typeof definitions>>;
let firstApply: string[];

beforeAll(async () => {
  await pool.query("drop owned by transfer_owner");
  await runMigrations(url, migrationsFolder, noSources);
  migrationsAlone = await definitions();
  await pool.query("drop owned by transfer_owner");
  firstApply = await runMigrations(url);
  withSources = await definitions();
}, 120_000);

afterAll(async () => {
  rmSync(temp, { recursive: true, force: true });
  await pool.query("drop owned by transfer_owner");
  await runMigrations(url);
  await pool.end();
});

it("builds from the sources what the migrations alone build", () => {
  expect(firstApply).toEqual(manifest.sources);
  expect(migrationsAlone.functions.length).toBeGreaterThan(300);
  expect(extracted(withSources.functions)).toEqual(extracted(migrationsAlone.functions));
  expect(extracted(withSources.triggers)).toEqual(extracted(migrationsAlone.triggers));
  // Nothing the migrations define is missing with the sources.
  const signatures = new Set(withSources.functions.map((f) => f.signature));
  expect(migrationsAlone.functions.filter((f) => !signatures.has(f.signature))).toEqual([]);
  // Every function runs with the fixed search path and is closed to PUBLIC (ADR-0002).
  const open = withSources.functions.filter(
    (f) =>
      f.configuration?.join() !== "search_path=pg_catalog, public, pg_temp" ||
      f.privileges?.some((acl) => acl.startsWith("=")) !== false ||
      f.owner !== "transfer_owner",
  );
  expect(open).toEqual([]);
});

it("applies nothing the second time", async () => {
  const before = await recorded();
  expect(before.map((row) => row.name).toSorted()).toEqual(manifest.sources.toSorted());
  expect(await runMigrations(url)).toEqual([]);
  expect(await recorded()).toEqual(before);
  expect(await definitions()).toEqual(withSources);
});

it("leaves no function or trigger without a source, and no source without an object", async () => {
  expect(withoutSource(withSources)).toEqual({ orphans: [], idle: [] });
  // The allowlist is exactly what a constraint, a default or an index expression depends on.
  const depended = await query<{ name: string }>(
    `select distinct p.proname as name from pg_depend d join ${ownFunctions.replace("where", "on")}
       and d.refclassid = 'pg_proc'::regclass and d.refobjid = p.oid
     where d.classid in ('pg_constraint'::regclass, 'pg_attrdef'::regclass, 'pg_class'::regclass)
     order by 1`,
  );
  expect(manifest.migrationOwnedFunctions.toSorted()).toEqual(depended.map((row) => row.name));

  await pool.query(
    `create function public.orphan_probe() returns int language sql set search_path = pg_catalog as 'select 1';
     create trigger orphan_probe before insert on public.job_run for each row execute function public.audit_append_only()`,
  );
  try {
    expect(withoutSource(await definitions()).orphans).toEqual([
      "orphan_probe()",
      "job_run.orphan_probe",
    ]);
  } finally {
    await pool.query(
      "drop trigger orphan_probe on public.job_run; drop function public.orphan_probe()",
    );
  }
});

it("refuses a manifest that doesn't list exactly the source files", () => {
  const sources = sourcesCopy("unlisted");
  writeFileSync(join(sources, "functions/audit/unlisted.sql"), "select 1;");
  expect(() => readSourceManifest(sources)).toThrow(/unlisted: functions\/audit\/unlisted\.sql/);
});

it("applies no source after a failed migration, nor on a database behind its migrations", async () => {
  const before = { definitions: await definitions(), recorded: await recorded() };
  const sources = sourcesCopy("after-failed-migration");
  appendFileSync(join(sources, manifest.sources[0]!), "\n-- changed\n");
  const broken = migrationsCopy("broken", Infinity, {
    "9999_broken": "select no_such_function();",
  });
  // 42883: the migration's undefined function.
  await expect(runMigrations(url, broken, sources)).rejects.toMatchObject({
    cause: { code: "42883" },
  });
  // The runner itself: the journal's last migration isn't applied.
  const client = await pool.connect();
  try {
    await expect(applyFunctionSources(client, broken, sources)).rejects.toThrow(
      "function sources: the database is not at the last migration; nothing applied",
    );
  } finally {
    client.release();
  }
  expect({ definitions: await definitions(), recorded: await recorded() }).toEqual(before);
});

it("applies all changed sources or none, and then only the changed ones", async () => {
  const before = { definitions: await definitions(), recorded: await recorded() };
  const changed = "functions/audit/audit_append_only.sql";
  const failing = manifest.sources.at(-1)!;
  const sources = sourcesCopy("failing");
  const path = join(sources, changed);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("RAISE EXCEPTION 'audit_append_only';", (line) => {
      return `-- changed\n  ${line}`;
    }),
  );
  appendFileSync(join(sources, failing), "\nselect no_such_function();\n");
  await expect(runMigrations(url, migrationsFolder, sources)).rejects.toThrow(
    `function sources: ${failing} failed; nothing applied`,
  );
  expect({ definitions: await definitions(), recorded: await recorded() }).toEqual(before);

  writeFileSync(join(sources, failing), readFileSync(join(sourcesFolder, failing)));
  expect(await runMigrations(url, migrationsFolder, sources)).toEqual([changed]);
  const after = await definitions();
  const differing = after.functions.filter(
    (f, i) => f.definition !== before.definitions.functions[i]!.definition,
  );
  expect(differing.map((f) => f.signature)).toEqual(["audit_append_only()"]);
  expect(differing[0]!.body).toContain("-- changed\n");
  expect({ ...differing[0]!, body: "", definition: "" }).toEqual({
    ...before.definitions.functions.find((f) => f.name === "audit_append_only")!,
    body: "",
    definition: "",
  });
  expect(after.triggers).toEqual(before.definitions.triggers);
  const rows = await recorded();
  expect(rows.filter((row, i) => row.sha256 !== before.recorded[i]!.sha256)).toEqual([
    expect.objectContaining({ name: changed, sha256: sha256(readFileSync(path)) }),
  ]);
});

it("upgrades a database at the last migration before the sources, with its rows", async () => {
  // The state `db:migrate` left before this change: every migration up to 0115, no sources.
  const last = journal.entries.find((entry) => entry.tag === functionSourceMigration)!.idx;
  await pool.query("drop owned by transfer_owner");
  expect(await runMigrations(url, migrationsCopy("before", last))).toEqual([]);
  const db = createDb(url);
  try {
    await seed(db);
  } finally {
    await db.$client.end();
  }
  await activateAsOwner(pool);
  await informedParticipation(pool);
  const before = {
    definitions: await definitions(),
    privileges: await privileges(),
    data: await data(),
  };
  expect(before.data).toMatchObject({
    participation: { rows: expect.any(Number) },
    audit_event: { rows: expect.any(Number) },
  });
  expect((before.data.audit_event as { rows: number }).rows).toBeGreaterThan(2);

  expect(await runMigrations(url)).toEqual(manifest.sources);
  const after = {
    definitions: await definitions(),
    privileges: await privileges(),
    data: await data(),
  };
  // The first apply changes no definition, privilege or row, and ends where a fresh build ends.
  expect(extracted(after.definitions.functions)).toEqual(extracted(before.definitions.functions));
  expect(extracted(after.definitions.triggers)).toEqual(extracted(before.definitions.triggers));
  expect(after.privileges).toEqual(before.privileges);
  expect(after.data).toEqual(before.data);
  expect(after.definitions).toEqual(withSources);
  expect(await runMigrations(url)).toEqual([]);

  // The functions and triggers still work on the existing rows.
  const events = (before.data.audit_event as { rows: number }).rows;
  await informedParticipation(pool);
  expect(await query("select count(*)::int as rows from audit_event")).toEqual([
    { rows: events + 3 },
  ]);
  await expect(pool.query("delete from audit_event")).rejects.toThrow("audit_append_only");
  expect(
    await query("select has_table_privilege('transfer_app', 'function_source', 'select') as app"),
  ).toEqual([{ app: false }]);
}, 120_000);
