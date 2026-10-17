import { ManualClock } from "@transfer/adapters";
import {
  auditEvent,
  createDb,
  eq,
  seedProjectIds,
  seedStaffUserIds,
  seedWaves,
} from "@transfer/db";
import { call, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { EntryWaveRecord, page, Project } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Slice 2 plan 5.4, 5.6 and 5.12 (PR 2b): the wave routes. Today is 2091-01-10 in Berlin, before
// the seeded waves' dates.
const WavePage = page(EntryWaveRecord);
const { app, db } = testApp({ clock: new ManualClock(new Date("2091-01-10T10:00:00Z")) });
const owner = createDb(testDatabaseUrls().owner);
let auth: { Cookie: string };

const werkNord = seedProjectIds.werkNord;
const [w1, w2] = seedWaves;
const path = (projectId: string, waveId?: string) =>
  `/api/v1/projects/${projectId}/entry-waves${waveId ? `/${waveId}` : ""}`;
const list = (projectId: string = werkNord, headers = auth, query = "") =>
  app.request(`${path(projectId)}${query}`, { headers });
const create = (body: unknown, projectId: string = werkNord, headers = auth) =>
  app.request(path(projectId), jsonRequest("POST", body, headers));
const patch = (waveId: string, body: unknown, projectId: string = werkNord, headers = auth) =>
  app.request(path(projectId, waveId), jsonRequest("PATCH", body, headers));
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));

/** A database function's refusal as Drizzle reports it. */
const refusal = (code: string) =>
  Object.assign(new Error("Failed query"), { cause: { code: "P0001", message: code } });

const w3 = {
  code: "W3",
  name: "Welle 3",
  signingDeadline: "2091-08-14",
  defaultTgStart: "2091-09-01",
  defaultTgEnd: "2092-08-31",
  latestEntryDate: "2091-09-15",
};

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  auth = await login(app, seedStaffUserIds.projectLead);
});
beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("GET /api/v1/projects/{projectId}/entry-waves", () => {
  it("lists the waves in creation order with their participations", async () => {
    await call(owner.$client, "create_participation", {
      projectId: werkNord,
      context: pl,
      entryWaveId: w2.id,
    });
    const { items, nextCursor } = await readJson(await list(), WavePage);
    expect(items.map(({ code, participations }) => ({ code, participations }))).toEqual([
      { code: "W1", participations: 0 },
      { code: "W2", participations: 1 },
    ]);
    expect(items[0]).toMatchObject({ ...w1, projectId: werkNord });
    expect(nextCursor).toBeNull();
  });

  it("pages by creation", async () => {
    const first = await readJson(await list(werkNord, auth, "?limit=1"), WavePage);
    expect(first.items.map((w) => w.code)).toEqual(["W1"]);
    const second = await readJson(
      await list(werkNord, auth, `?limit=1&cursor=${first.nextCursor}`),
      WavePage,
    );
    expect(second.items.map((w) => w.code)).toEqual(["W2"]);
    await codes(await list(werkNord, auth, "?cursor=x"), 400, "validation-error");
  });

  it("shows waves to members and global org roles, and hides the project from others (404)", async () => {
    for (const staffUserId of [seedStaffUserIds.consultant, seedStaffUserIds.admin]) {
      const res = await list(werkNord, await login(app, staffUserId));
      expect((await readJson(res, WavePage)).items).toHaveLength(2);
    }
    const created = await app.request(
      "/api/v1/projects",
      jsonRequest("POST", { name: "Neu", customerName: "Beispiel AG", type: "ta_tg" }, auth),
    );
    const { id } = await readJson(created, Project);
    await expectProblem(
      await list(id, await login(app, seedStaffUserIds.consultant)),
      404,
      "not-found",
    );
  });
});

describe("POST /api/v1/projects/{projectId}/entry-waves (AC-6)", () => {
  it("creates a wave (201) with one audit event carrying the request id", async () => {
    const res = await create({ ...w3, code: " W3 " });
    expect(res.status).toBe(201);
    const created = await readJson(res, EntryWaveRecord);
    expect(created).toMatchObject({ ...w3, projectId: werkNord, participations: 0 });
    const events = await owner
      .select({ requestId: auditEvent.requestId, details: auditEvent.details })
      .from(auditEvent)
      .where(eq(auditEvent.eventType, "entry_wave_created"));
    expect(events.at(-1)).toEqual({
      requestId: expect.any(String),
      details: { waveId: created.id, ...w3, code: undefined, name: undefined },
    });
  });

  it("shows each refused rule at its field (422)", async () => {
    expect(await codes(await create({ ...w3, code: "W1", signingDeadline: "2091-09-02" }))).toEqual(
      [
        { code: "code_taken", pointer: "/code" },
        { code: "signing_after_start", pointer: "/signingDeadline" },
      ],
    );
    expect(await codes(await create({ ...w3, latestEntryDate: "2091-01-09" }))).toContainEqual({
      code: "latest_entry_in_past",
      pointer: "/latestEntryDate",
    });
  });

  it("refuses waves in a ta_only project (422)", async () => {
    expect(await codes(await create(w3, seedProjectIds.verwaltung))).toEqual([
      { code: "not_ta_tg", pointer: "" },
    ]);
  });

  it("only lets the project's PL create a wave (403), and rejects unknown fields (400)", async () => {
    const consultant = await login(app, seedStaffUserIds.consultant);
    await expectProblem(await create(w3, werkNord, consultant), 403, "forbidden");
    await expectProblem(
      await create(w3, werkNord, await login(app, seedStaffUserIds.admin)),
      403,
      "forbidden",
    );
    expect(
      await codes(await create({ ...w3, projectId: werkNord }), 400, "validation-error"),
    ).toEqual([{ code: "unrecognized_keys", pointer: "/projectId" }]);
  });
});

describe("PATCH /api/v1/projects/{projectId}/entry-waves/{waveId} (AC-6)", () => {
  it("changes the given fields only and records the changed keys", async () => {
    const res = await patch(w1.id, { name: "Welle eins", latestEntryDate: "2091-03-20" });
    expect(await readJson(res, EntryWaveRecord)).toMatchObject({
      ...w1,
      name: "Welle eins",
      latestEntryDate: "2091-03-20",
    });
    const [event] = await owner
      .select({ details: auditEvent.details })
      .from(auditEvent)
      .where(eq(auditEvent.eventType, "entry_wave_changed"));
    expect(event?.details).toEqual({
      waveId: w1.id,
      fields: ["name", "latestEntryDate"],
      dates: { latestEntryDate: { from: w1.latestEntryDate, to: "2091-03-20" } },
    });
  });

  it("applies the usage rules read under the lock (422)", async () => {
    await call(owner.$client, "create_participation", {
      projectId: werkNord,
      context: pl,
      entryWaveId: w1.id,
    });
    expect(await codes(await patch(w1.id, { defaultTgEnd: null }))).toEqual([
      { code: "date_in_use", pointer: "/defaultTgEnd" },
    ]);
  });

  it.each([
    ["nothing", { name: w1.name }, "wave_unchanged"],
    ["a date into the wrong order", { defaultTgStart: "2091-03-16" }, "start_after_latest_entry"],
  ])("refuses to change %s (422)", async (_label, body, code) => {
    expect((await codes(await patch(w1.id, body)))?.map((e) => e.code)).toEqual([code]);
  });

  it("gives 404 for an unknown wave and for a wave of another project", async () => {
    await expectProblem(
      await patch(w1.id, { name: "X" }, seedProjectIds.lagerSued),
      404,
      "not-found",
    );
    await expectProblem(
      await patch("00000000-0000-4000-b000-0000000000ff", { name: "X" }),
      404,
      "not-found",
    );
  });

  it("rejects an empty change (400)", async () => {
    expect((await codes(await patch(w1.id, {}), 400, "validation-error"))?.[0]?.code).toBe(
      "nothing_to_change",
    );
  });

  it("maps project_not_found to 404 and lets an unexpected function refusal propagate (500)", async () => {
    const transaction = vi.spyOn(db, "transaction");
    try {
      transaction.mockRejectedValueOnce(refusal("project_not_found"));
      await expectProblem(await patch(w1.id, { name: "X" }), 404, "not-found");
      transaction.mockRejectedValueOnce(refusal("invalid_argument"));
      await expectProblem(await patch(w1.id, { name: "X" }), 500, "internal-error");
    } finally {
      transaction.mockRestore();
    }
  });
});
