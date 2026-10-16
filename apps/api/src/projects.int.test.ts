import {
  auditEvent,
  createDb,
  eq,
  project,
  projectMembership,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Project, page } from "@transfer/domain";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

const ProjectPage = page(Project);

const { app, db } = testApp();
// Fixtures the runtime role may not write (projects are created only through create_project).
const owner = createDb(testDatabaseUrls().owner);
let auth: { Cookie: string };

const valid = {
  name: "Projekt Integrationstest",
  customerName: "Beispiel Maschinenbau GmbH",
  type: "ta_tg",
};

const create = (body: unknown, headers = auth) =>
  app.request("/api/v1/projects", jsonRequest("POST", body, headers));
const list = (query = "", headers = auth) => app.request(`/api/v1/projects${query}`, { headers });
const patch = (id: string, body: unknown, headers = auth) =>
  app.request(`/api/v1/projects/${id}`, jsonRequest("PATCH", body, headers));
/** A database function's refusal as Drizzle reports it. */
const refusal = (code: string) =>
  Object.assign(new Error("Failed query"), { cause: { code: "P0001", message: code } });
const ids = async (res: Response) => (await readJson(res, ProjectPage)).items.map((p) => p.id);

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  auth = await login(app, seedStaffUserIds.projectLead);
});
beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("POST /api/v1/projects (AC-1)", () => {
  it("creates a draft project (201) with the session user as creator and PL member, shown first", async () => {
    const res = await create(valid);
    expect(res.status).toBe(201);
    const created = await readJson(res, Project);
    expect(created).toMatchObject({
      ...valid,
      status: "draft",
      projectAgenturKey: null,
      activatedAt: null,
      createdBy: seedStaffUserIds.projectLead,
    });
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    const { items } = await readJson(await list(), ProjectPage);
    expect(items[0]).toEqual(created);
    const members = await owner
      .select({ staffUserId: projectMembership.staffUserId, role: projectMembership.role })
      .from(projectMembership)
      .where(eq(projectMembership.projectId, created.id));
    expect(members).toEqual([{ staffUserId: seedStaffUserIds.projectLead, role: "project_lead" }]);
    const events = await owner
      .select({ type: auditEvent.eventType, requestId: auditEvent.requestId })
      .from(auditEvent)
      .where(eq(auditEvent.projectId, created.id));
    expect(events).toEqual([{ type: "project_created", requestId: expect.any(String) }]);
  });

  it.each([
    ["consultant", seedStaffUserIds.consultant],
    ["admin", seedStaffUserIds.admin],
    ["regional operations manager", seedStaffUserIds.regionalOperationsManager],
  ])("forbids a %s to create one (403, Q106)", async (_label, staffUserId) => {
    await expectProblem(await create(valid, await login(app, staffUserId)), 403, "forbidden");
  });

  it.each([
    ["an empty name", { name: "" }, "/name"],
    ["an unknown type", { type: "tg_only" }, "/type"],
    ["no customer", { customerName: undefined }, "/customerName"],
  ])("rejects %s with a validation problem", async (_label, change, pointer) => {
    const body = await expectProblem(
      await create({ ...valid, ...change }),
      400,
      "validation-error",
    );
    expect(body.errors?.map((e) => e.pointer)).toEqual([pointer]);
  });

  it("rejects the Slice 0 date fields and other unknown fields instead of dropping them (round 23)", async () => {
    const body = await expectProblem(
      await create({ ...valid, signingDeadline: "2027-02-15", projectAgenturKey: "x" }),
      400,
      "validation-error",
    );
    expect(body.errors?.map((e) => [e.pointer, e.code])).toEqual([
      ["/signingDeadline", "unrecognized_keys"],
      ["/projectAgenturKey", "unrecognized_keys"],
    ]);
    expect((await readJson(await list(), ProjectPage)).items).toHaveLength(3);
  });

  it("never echoes the submitted values", async () => {
    const res = await create({ ...valid, name: "Zzyzx-Unverwechselbar-4711".repeat(10) });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain("Zzyzx");
  });

  it("rejects malformed JSON with a validation problem", async () => {
    const res = await app.request("/api/v1/projects", {
      ...jsonRequest("POST", {}, auth),
      body: "{not json",
    });
    await expectProblem(res, 400, "validation-error");
  });
});

describe("GET /api/v1/projects (AC-2)", () => {
  it("pages 120 projects as 50, 50 and 20 in a stable order without duplicates or gaps", async () => {
    // 3 seeded + 117 inserted in one statement, so most share one created_at (id breaks ties).
    const rows = Array.from({ length: 117 }, (_, i) => ({
      name: `Projekt ${i}`,
      customerName: "Beispiel GmbH",
      type: "ta_only" as const,
      createdBy: seedStaffUserIds.projectLead,
    }));
    const inserted = await owner.insert(project).values(rows).returning({ id: project.id });
    await owner.insert(projectMembership).values(
      inserted.map(({ id }) => ({
        projectId: id,
        staffUserId: seedStaffUserIds.projectLead,
        role: "project_lead" as const,
      })),
    );

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(`?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      const body = await readJson(res, ProjectPage);
      sizes.push(body.items.length);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
    } while (cursor);

    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
  });

  it("lists only the projects the user is a member of; global org roles see all (Q106)", async () => {
    const created = await readJson(await create(valid), Project);
    const seeded = Object.values(seedProjectIds).toSorted();
    // The consultant holds a role in the seeded projects only.
    const consultant = await login(app, seedStaffUserIds.consultant);
    expect((await ids(await list("", consultant))).toSorted()).toEqual(seeded);
    for (const staffUserId of [
      seedStaffUserIds.admin,
      seedStaffUserIds.regionalOperationsManager,
    ]) {
      const all = await ids(await list("", await login(app, staffUserId)));
      expect(all.toSorted()).toEqual([...seeded, created.id].toSorted());
    }
    // A PL without any membership sees nothing.
    await owner
      .delete(projectMembership)
      .where(eq(projectMembership.staffUserId, seedStaffUserIds.backOffice));
    expect(await ids(await list("", await login(app, seedStaffUserIds.backOffice)))).toEqual([]);
  });

  it("lists the newest first", async () => {
    const created = await readJson(await create(valid), Project);
    const { items, nextCursor } = await readJson(await list(), ProjectPage);
    expect(items).toHaveLength(4);
    expect(items[0]?.id).toBe(created.id);
    expect(nextCursor).toBeNull();
  });

  it.each(["not-base64!", Buffer.from('{"createdAt":"x","id":"y"}').toString("base64url")])(
    "rejects the malformed cursor %s",
    async (cursor) => {
      const body = await expectProblem(await list(`?cursor=${cursor}`), 400, "validation-error");
      expect(body.errors).toEqual([expect.objectContaining({ parameter: "cursor" })]);
    },
  );

  it("rejects a limit above 100", async () => {
    const body = await expectProblem(await list("?limit=101"), 400, "validation-error");
    expect(body.errors).toEqual([expect.objectContaining({ parameter: "limit" })]);
  });
});

describe("GET /api/v1/projects/{projectId}", () => {
  it("returns one project", async () => {
    const created = await readJson(await create(valid), Project);
    const res = await app.request(`/api/v1/projects/${created.id}`, { headers: auth });
    expect(await readJson(res, Project)).toEqual(created);
  });

  it("gives a 404 problem for an unknown project and for one the user can't see", async () => {
    const res = await app.request("/api/v1/projects/00000000-0000-4000-a000-000000000000", {
      headers: auth,
    });
    await expectProblem(res, 404, "not-found");
    const created = await readJson(await create(valid), Project);
    const consultant = await login(app, seedStaffUserIds.consultant);
    await expectProblem(
      await app.request(`/api/v1/projects/${created.id}`, { headers: consultant }),
      404,
      "not-found",
    );
  });

  it("gives a validation problem for a malformed id", async () => {
    const res = await app.request("/api/v1/projects/42", { headers: auth });
    const body = await expectProblem(res, 400, "validation-error");
    expect(body.errors).toEqual([expect.objectContaining({ parameter: "projectId" })]);
  });
});

describe("PATCH /api/v1/projects/{projectId} (AC-4)", () => {
  it("changes name and customer and records the changed keys", async () => {
    const res = await patch(seedProjectIds.werkNord, { name: "Werk Nord neu" });
    expect(await readJson(res, Project)).toMatchObject({ name: "Werk Nord neu", type: "ta_tg" });
    // After the seed's project_created (round 23).
    const events = await owner
      .select({ type: auditEvent.eventType, details: auditEvent.details })
      .from(auditEvent)
      .where(eq(auditEvent.projectId, seedProjectIds.werkNord))
      .orderBy(auditEvent.seq);
    expect(events).toEqual([
      { type: "project_created", details: { type: "ta_tg" } },
      { type: "project_changed", details: { fields: ["name"] } },
    ]);
  });

  it("changes the type of an unused draft project", async () => {
    const created = await readJson(await create(valid), Project);
    expect(await readJson(await patch(created.id, { type: "ta_only" }), Project)).toMatchObject({
      type: "ta_only",
    });
  });

  it.each([
    [
      "the type of a project with waves",
      seedProjectIds.werkNord,
      { type: "ta_only" },
      "project_has_waves",
    ],
    [
      "nothing",
      seedProjectIds.lagerSued,
      { name: "Standortschließung Lager Süd" },
      "project_unchanged",
    ],
  ])("refuses to change %s (422)", async (_label, id, body, code) => {
    const problemBody = await expectProblem(await patch(id, body), 422, "domain-error");
    expect(problemBody.errors?.map((e) => e.code)).toEqual([code]);
  });

  it("refuses non-PL members (403) and non-members (404)", async () => {
    const consultant = await login(app, seedStaffUserIds.consultant);
    await expectProblem(
      await patch(seedProjectIds.werkNord, { name: "X" }, consultant),
      403,
      "forbidden",
    );
    const admin = await login(app, seedStaffUserIds.admin);
    await expectProblem(
      await patch(seedProjectIds.werkNord, { name: "X" }, admin),
      403,
      "forbidden",
    );
    const created = await readJson(await create(valid), Project);
    await expectProblem(await patch(created.id, { name: "X" }, consultant), 404, "not-found");
  });

  it("rejects an empty change with a validation problem", async () => {
    const body = await expectProblem(
      await patch(seedProjectIds.werkNord, {}),
      400,
      "validation-error",
    );
    expect(body.errors?.map((e) => e.code)).toEqual(["nothing_to_change"]);
  });

  it("rejects a premature projectAgenturKey (set with its pin, PR 2c-2)", async () => {
    const body = await expectProblem(
      await patch(seedProjectIds.werkNord, { name: "X", projectAgenturKey: "beispielstadt-nord" }),
      400,
      "validation-error",
    );
    expect(body.errors?.map((e) => e.pointer)).toEqual(["/projectAgenturKey"]);
  });

  it("maps project_not_found to 404 and lets an unexpected function refusal propagate (500)", async () => {
    const transaction = vi.spyOn(db, "transaction");
    try {
      transaction.mockRejectedValueOnce(refusal("project_not_found"));
      await expectProblem(await patch(seedProjectIds.werkNord, { name: "X" }), 404, "not-found");
      transaction.mockRejectedValueOnce(refusal("invalid_argument"));
      await expectProblem(
        await patch(seedProjectIds.werkNord, { name: "X" }),
        500,
        "internal-error",
      );
    } finally {
      transaction.mockRestore();
    }
  });
});
