import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TemplateManifest } from "@transfer/config";
import {
  baseDefaultsDir,
  loadManifest,
  organisationFile,
  templatesDir,
} from "@transfer/config/load";
import { createDb, projectMembership, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { page } from "@transfer/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { expectProblem, login, readJson, testApp } from "./testing";

const CatalogPage = page(TemplateManifest.shape.templates.element);
const { templates } = loadManifest();

const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const auth: Record<string, { Cookie: string }> = {};
const get = (query = "", user = "projectLead") =>
  app.request(`/api/v1/config/templates${query}`, { headers: auth[user] });

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  for (const user of Object.keys(seedStaffUserIds) as (keyof typeof seedStaffUserIds)[]) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("GET /api/v1/config/templates (plan 5.8, 5.12)", () => {
  it("lists the catalog from the manifest in key and version order", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await readJson(res, CatalogPage);
    expect(body).toEqual({ items: templates, nextCursor: null });
    expect(body.items.map((t) => `${t.agenturKey}@${t.version}`)).toEqual([
      "beispielstadt-nord@1",
      "beispielstadt-nord@2",
      "beispielstadt-sued@1",
    ]);
  });

  it("pages by (agenturKey, version) with an opaque cursor", async () => {
    const first = await readJson(await get("?limit=2"), CatalogPage);
    expect(first.items).toEqual(templates.slice(0, 2));
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await readJson(await get(`?limit=2&cursor=${first.nextCursor}`), CatalogPage);
    expect(second).toEqual({ items: templates.slice(2), nextCursor: null });
    const exact = await readJson(await get("?limit=3"), CatalogPage);
    expect(exact.nextCursor).toBeNull();
  });

  it("refuses unknown parameters, a bad limit and a malformed cursor", async () => {
    const unknown = await expectProblem(
      await get("?agenturKey=x&limit=1"),
      400,
      "validation-error",
    );
    expect(unknown.errors).toEqual([
      { parameter: "agenturKey", code: "unrecognized_keys", detail: "Unknown field" },
    ]);
    await expectProblem(await get("?limit=0"), 400, "validation-error");
    const schemaInvalid = Buffer.from(JSON.stringify({ agenturKey: "x", version: 0 })).toString(
      "base64url",
    );
    for (const cursor of ["not-base64!", schemaInvalid]) {
      const body = await expectProblem(await get(`?cursor=${cursor}`), 400, "validation-error");
      expect(body.errors).toEqual([
        { parameter: "cursor", code: "invalid_cursor", detail: "Malformed cursor" },
      ]);
    }
  });

  it("needs a session", async () => {
    await expectProblem(await app.request("/api/v1/config/templates"), 401, "unauthenticated");
  });

  // Q108 (confirmed in round 25): who chooses or pins templates, and global org roles.
  it.each(["projectLead", "admin", "regionalAdmin", "regionalOperationsManager"])(
    "is readable by %s",
    async (user) => {
      expect((await get("", user)).status).toBe(200);
    },
  );

  it.each(["consultant", "backOffice"])(
    "is forbidden to %s without a PL role in a project",
    async (user) => {
      await expectProblem(await get("", user), 403, "forbidden");
    },
  );

  it("is readable by the PL of a project whatever the flat role", async () => {
    await owner.insert(projectMembership).values({
      projectId: seedProjectIds.werkNord,
      staffUserId: seedStaffUserIds.consultant,
      role: "project_lead",
    });
    expect((await get("", "consultant")).status).toBe(200);
  });
});

/** A CONFIG_DIR as the build writes it, optionally with another manifest. */
function configDir(manifest?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "config-dir-"));
  cpSync(fileURLToPath(templatesDir), join(dir, "templates"), { recursive: true });
  cpSync(
    fileURLToPath(new URL("base-defaults.json", baseDefaultsDir)),
    join(dir, "base-defaults.json"),
  );
  cpSync(fileURLToPath(organisationFile), join(dir, "organisation.json"));
  if (manifest) writeFileSync(join(dir, "templates/manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("CONFIG_DIR (S2)", () => {
  it("serves the catalog of the configured directory", async () => {
    const only = { templates: [templates[2]] };
    const other = testApp({ db, env: { configDir: configDir(only) } }).app;
    const res = await other.request("/api/v1/config/templates", { headers: auth.projectLead });
    expect(await readJson(res, CatalogPage)).toEqual({ items: only.templates, nextCursor: null });
  });

  it("fails the start, not a request, without a valid catalog", () => {
    expect(() => testApp({ db, env: { configDir: join(tmpdir(), "no-such-config") } })).toThrow(
      /ENOENT/,
    );
    expect(() => testApp({ db, env: { configDir: configDir({ templates: "x" }) } })).toThrow(
      ZodError,
    );
  });

  it.each([
    ["duplicate", [templates[0], templates[1], templates[1]]],
    ["out-of-order", [templates[1], templates[0], templates[2]]],
  ])("refuses to start with %s catalog entries", (_, entries) => {
    const dir = configDir({ templates: entries });
    expect(() => testApp({ db, env: { configDir: dir } })).toThrow(/manifest_not_strictly_ordered/);
  });
});
