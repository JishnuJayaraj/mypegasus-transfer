import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  auditEvent,
  createDb,
  eq,
  importColumnMapping,
  participantDetails,
  participantIdentity,
  participation,
  projectEntryWave,
  seedProjectIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { ImportPreview } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { seedTemplatePins } from "../projects/seed";
import { loadRelease } from "../projects/template-pins";
import { expectProblem, jsonRequest, login, readJson, testApp } from "../testing";

// Shared by the import tests (Slice 2 plan 5.11, 5.12; PR 2g-1): the app, the fixtures, the
// requests and the database reset.
vi.setConfig({ testTimeout: 30_000 });
export const { app, db, logs } = testApp();
export const owner = createDb(testDatabaseUrls().owner);
export const auth: Record<string, { Cookie: string }> = {};
export const { werkNord, verwaltung } = seedProjectIds;

export const bytesOf = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/imports/${name}`, import.meta.url)));
export const fixture = (name: string) => bytesOf(name).toString("base64");
export const firstFiveColumns = (line: string) => line.split(";").slice(0, 5).join(";");
export const rowsOf = (n: number) => [
  "Personalnummer",
  ...Array.from({ length: n }, (_, i) => `P${i}`),
];
export const b64 = (text: string) => Buffer.from(text).toString("base64");
export const suggestionOfFirstColumn = (shown: ImportPreview) =>
  shown.suggestedMapping.find((s) => s.column === 0);
export const noDecisions = { confirmWarnings: false, possibleDuplicates: {} };

export const post = (path: string, body: unknown, user = "projectLead") =>
  app.request(`/api/v1/projects/${path}`, jsonRequest("POST", body, auth[user]));
export const preview = (projectId: string, body: object, user?: string) =>
  post(`${projectId}/imports/preview`, body, user);
export const confirm = (projectId: string, body: object, user?: string) =>
  post(`${projectId}/imports`, body, user);
export const previewOf = async (projectId: string, body: object) =>
  readJson(await preview(projectId, body), ImportPreview);

/** The suggested mapping of a file, as the PL would confirm it. */
export async function suggested(projectId: string, body: object) {
  const first = await previewOf(projectId, body);
  return first.suggestedMapping.map(({ column, target }) => ({ column, target }));
}

/** Previews with the suggested mapping and confirms with the token; returns the confirm response. */
export async function importFile(
  file: string,
  options: { projectId?: string; decisions?: object; extra?: object } = {},
) {
  const projectId = options.projectId ?? werkNord;
  const base = { file, ...options.extra };
  const mapping = await suggested(projectId, base);
  const shown = await previewOf(projectId, { ...base, mapping });
  return confirm(projectId, {
    ...base,
    mapping,
    decisions: options.decisions ?? noDecisions,
    previewToken: shown.previewToken,
  });
}

export async function counts() {
  const rows = await Promise.all(
    [participation, participantIdentity, participantDetails, auditEvent, importColumnMapping].map(
      async (table) => (await owner.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n,
    ),
  );
  return rows;
}

export const codes = async (res: Response, status = 422) =>
  (await expectProblem(res, status, status === 409 ? "conflict" : "domain-error")).errors?.map(
    ({ code }) => code,
  );
/** The id of a project's first wave. */
export async function waveOf(projectId: string) {
  const [wave] = await owner
    .select({ id: projectEntryWave.id })
    .from(projectEntryWave)
    .where(eq(projectEntryWave.projectId, projectId))
    .limit(1);
  return wave!.id;
}
export const identities = () =>
  owner.select().from(participantIdentity).orderBy(participantIdentity.personnelNumber);

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  for (const user of Object.keys(seedStaffUserIds) as (keyof typeof seedStaffUserIds)[]) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true });
  await seedTemplatePins(db, loadRelease(undefined));
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));
