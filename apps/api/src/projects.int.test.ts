import { project, seedStaffUserIds } from "@transfer/db";
import { resetTestDatabase } from "@transfer/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Project, page } from "@transfer/domain";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

const ProjectPage = page(Project);

const { app, db } = testApp();
let auth: { Cookie: string };

const valid = {
  name: "Projekt Integrationstest",
  customerName: "Beispiel Maschinenbau GmbH",
  type: "ta_tg",
  defaultTgStart: "2027-03-01",
  defaultTgEnd: "2028-02-29",
};

const create = (body: unknown) => app.request("/api/v1/projects", jsonRequest("POST", body, auth));
const list = (query = "") => app.request(`/api/v1/projects${query}`, { headers: auth });

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  auth = await login(app, seedStaffUserIds.projectLead);
});
beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => db.$client.end());

describe("POST /api/v1/projects", () => {
  it("creates a project (201) created by the session user, shown first in the list", async () => {
    const res = await create(valid);
    expect(res.status).toBe(201);
    const created = await readJson(res, Project);
    expect(created).toMatchObject({ ...valid, signingDeadline: null });
    expect(created.createdBy).toBe(seedStaffUserIds.projectLead);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    const { items } = await readJson(await list(), ProjectPage);
    expect(items[0]).toEqual(created);
  });

  it("records the other user after switching dev users", async () => {
    const otherAuth = await login(app, seedStaffUserIds.consultant);
    const res = await app.request("/api/v1/projects", jsonRequest("POST", valid, otherAuth));
    expect((await readJson(res, Project)).createdBy).toBe(seedStaffUserIds.consultant);
  });

  it.each([
    ["an empty name", { name: "" }, "/name"],
    ["an impossible date", { defaultTgStart: "2027-02-31" }, "/defaultTgStart"],
    ["a TG end before the TG start", { defaultTgEnd: "2027-02-28" }, "/defaultTgEnd"],
    [
      "TG dates on a ta_only project",
      { type: "ta_only", defaultTgEnd: undefined },
      "/defaultTgStart",
    ],
    [
      "a signing deadline on a ta_only project",
      {
        type: "ta_only",
        defaultTgStart: undefined,
        defaultTgEnd: undefined,
        signingDeadline: "2027-02-01",
      },
      "/signingDeadline",
    ],
  ])("rejects %s with a validation problem", async (_label, change, pointer) => {
    const body = await expectProblem(
      await create({ ...valid, ...change }),
      400,
      "validation-error",
    );
    expect(body.errors?.map((e) => e.pointer)).toEqual([pointer]);
  });

  it("never echoes the submitted values", async () => {
    const res = await create({
      ...valid,
      name: "Zzyzx-Unverwechselbar-4711".repeat(10),
      defaultTgEnd: "2027-02-31",
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain("Zzyzx");
    expect(text).not.toContain("2027-02-31");
  });

  it("rejects malformed JSON with a validation problem", async () => {
    const res = await app.request("/api/v1/projects", {
      ...jsonRequest("POST", {}, auth),
      body: "{not json",
    });
    await expectProblem(res, 400, "validation-error");
  });
});

describe("GET /api/v1/projects", () => {
  it("pages 120 projects as 50, 50 and 20 in a stable order without duplicates or gaps", async () => {
    // 3 seeded + 117 inserted in one statement, so most share one created_at (id breaks ties).
    const rows = Array.from({ length: 117 }, (_, i) => ({
      name: `Projekt ${i}`,
      customerName: "Beispiel GmbH",
      type: "ta_only" as const,
      createdBy: seedStaffUserIds.projectLead,
    }));
    await db.insert(project).values(rows);

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

  it("gives a 404 problem for an unknown project", async () => {
    const res = await app.request("/api/v1/projects/00000000-0000-4000-a000-000000000000", {
      headers: auth,
    });
    await expectProblem(res, 404, "not-found");
  });

  it("gives a validation problem for a malformed id", async () => {
    const res = await app.request("/api/v1/projects/42", { headers: auth });
    const body = await expectProblem(res, 400, "validation-error");
    expect(body.errors).toEqual([expect.objectContaining({ parameter: "projectId" })]);
  });
});
