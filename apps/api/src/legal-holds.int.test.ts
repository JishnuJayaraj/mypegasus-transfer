import { createDb, seedProjectIds, seedRegionIds, seedStaffUserIds } from "@transfer/db";
import { call, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { LegalHoldsView, ReviewQueue } from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jsonRequest, login, readJson, testApp } from "./testing";

// Legal holds (data-protection.md, legal holds; Q218) and the evidence-only phase's read refusal
// against transfer_test. Expected results from the rules: the PL and back office place a hold on
// selected records or classes with a reason code and the documented basis, never on the whole
// participation; a consultant (a nearby role) and a PL who lost the membership are refused; only
// a regional operations manager of the region who didn't place it releases it, with a source;
// visibility (404) before permission (403) before state (409/422). Synthetic data only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, lagerSued } = seedProjectIds;
const { projectLead, consultant, backOffice, regionalOperationsManager, regionalAdmin } =
  seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [
    projectLead,
    consultant,
    backOffice,
    regionalOperationsManager,
    regionalAdmin,
  ]) {
    staff[id] = await login(app, id);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const participant = (projectId = werkNord) =>
  call(owner.$client, "create_participation", { projectId, context: pl }) as Promise<string>;
const scope = { classes: [], recordKinds: [], documentIds: [] };
const body = (over: object = {}) => ({
  ...scope,
  recordKinds: ["dsv_contract"],
  reason: "litigation",
  basis: "LAG Hamburg, Az. 1 Sa 1/26",
  expected: { activeHoldIds: [] },
  ...over,
});
const place = (id: string, as: string, over: object = {}) =>
  app.request(
    `/api/v1/participations/${id}/legal-holds`,
    jsonRequest("POST", body(over), staff[as]!),
  );
const release = (holdId: string, as: string, source = "Weisung DSB vom 01.10.") =>
  app.request(`/api/v1/legal-holds/${holdId}/release`, jsonRequest("POST", { source }, staff[as]!));
const codesOf = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  const b = (await res.json()) as { errors?: { code: string }[] };
  return (b.errors ?? []).map((e) => e.code);
};

describe("placing a hold", () => {
  it("is the PL's or back office's, on selected records, audited without the basis", async () => {
    const id = await participant();
    const res = await place(id, projectLead);
    expect(res.status).toBe(201);
    const view = await readJson(res, LegalHoldsView);
    expect(view.holds).toEqual([
      expect.objectContaining({
        recordKinds: ["dsv_contract"],
        classes: [],
        reason: "litigation",
        basis: "LAG Hamburg, Az. 1 Sa 1/26",
        releasedOn: null,
        capabilities: { release: false },
      }),
    ]);
    const second = await place(id, backOffice, {
      classes: ["health_record"],
      recordKinds: [],
      expected: { activeHoldIds: [view.holds[0]!.id] },
    });
    expect(second.status).toBe(201);
    const events = await sql(
      "select actor_staff_user_id, details from audit_event where event_type = 'legal_hold_placed' order by occurred_at",
    );
    expect(events.rows[0]).toEqual({
      actor_staff_user_id: projectLead,
      details: {
        holdId: view.holds[0]!.id,
        reason: "litigation",
        classes: [],
        recordKinds: ["dsv_contract"],
        documentCount: 0,
      },
    });
    expect(JSON.stringify(events.rows)).not.toContain("LAG Hamburg");
    expect(logs.join("\n")).not.toContain("LAG Hamburg");
    // The security stream: never in the participant's history.
    const history = await app.request(`/api/v1/participations/${id}/history`, {
      headers: staff[projectLead]!,
    });
    expect(JSON.stringify(await history.json())).not.toContain("legal_hold");
  });

  it("refuses an empty scope and the whole participation", async () => {
    const id = await participant();
    expect(await codesOf(await place(id, projectLead, { recordKinds: [] }), 422)).toEqual([
      "hold_scope_empty",
    ]);
    expect(
      await codesOf(
        await place(id, projectLead, {
          classes: ["personnel_file", "health_record", "form_working_copy", "evidence_set"],
        }),
        422,
      ),
    ).toEqual(["hold_scope_too_broad"]);
    // No scope naming the participation itself exists in the schema.
    expect((await place(id, projectLead, { classes: ["participation_record"] })).status).toBe(400);
    expect((await place(id, projectLead, { basis: "" })).status).toBe(400);
    expect((await place(id, projectLead, { reason: undefined })).status).toBe(400);
    expect(Number((await sql("select count(*) from legal_hold")).rows[0].count)).toBe(0);
  });

  it("is refused for a nearby role and after losing the membership; 404 before 403 before 409", async () => {
    const id = await participant();
    const hidden = await participant(lagerSued);
    // Hidden from the manager's region and from the PL's projects alike: 404 first.
    expect((await place(randomUUID(), projectLead)).status).toBe(404);
    expect((await place(hidden, regionalOperationsManager)).status).toBe(404);
    expect((await place(id, consultant)).status).toBe(403);
    expect((await place(id, regionalOperationsManager)).status).toBe(403);
    // A forbidden role with a stale read is still 403, a permitted one 409.
    const stale = { expected: { activeHoldIds: [randomUUID()] } };
    expect((await place(id, consultant, stale)).status).toBe(403);
    expect(await codesOf(await place(id, backOffice, stale), 409)).toEqual(["stale_holds"]);
    // A document of another participation is hidden: 404.
    const other = await participant();
    const document = randomUUID();
    await sql(
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class,
         media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by,
         added_by_staff_user_id, added_on_behalf, added_at)
       values ($1, $2, $3, 'participant_upload', 10, 'personnel_file', 'application/pdf', 100,
         repeat('a', 64), 'x.pdf', repeat('b', 16), decode(repeat('00', 60), 'hex'), 'user', $4,
         false, now())`,
      [document, werkNord, other, backOffice],
    );
    expect((await place(id, projectLead, { documentIds: [document] })).status).toBe(404);
    expect((await place(other, projectLead, { documentIds: [document] })).status).toBe(201);
    await sql("delete from project_membership where project_id = $1 and staff_user_id = $2", [
      werkNord,
      backOffice,
    ]);
    expect((await place(id, backOffice)).status).toBe(404);
  });
});

describe("releasing a hold", () => {
  it("only by another regional manager of the region, with a source, once", async () => {
    const id = await participant();
    const placed = await readJson(await place(id, projectLead), LegalHoldsView);
    const holdId = placed.holds[0]!.id;
    // In the manager's "Freigaben", without the participant.
    const queue = await readJson(
      await app.request("/api/v1/reviews", { headers: staff[regionalOperationsManager]! }),
      ReviewQueue,
    );
    expect(queue.legalHolds).toEqual([
      expect.objectContaining({ id: holdId, documentCount: 0, capabilities: { release: true } }),
    ]);
    expect(JSON.stringify(queue.legalHolds)).not.toContain(id);
    expect(JSON.stringify(queue.legalHolds)).not.toContain("LAG Hamburg");

    expect((await release(randomUUID(), regionalOperationsManager)).status).toBe(404);
    expect((await release(holdId, projectLead)).status).toBe(403);
    expect((await release(holdId, backOffice)).status).toBe(403);
    expect((await release(holdId, regionalOperationsManager, "")).status).toBe(400);
    expect((await release(holdId, regionalOperationsManager)).status).toBe(204);
    expect(await codesOf(await release(holdId, regionalOperationsManager), 409)).toEqual([
      "hold_released",
    ]);
    const { rows } = await sql("select released_by, release_source from legal_hold");
    expect(rows).toEqual([
      { released_by: regionalOperationsManager, release_source: "Weisung DSB vom 01.10." },
    ]);
    const events = await sql(
      "select details from audit_event where event_type = 'legal_hold_released'",
    );
    expect(events.rows).toEqual([{ details: { holdId } }]);
  });

  it("never by the manager who placed it", async () => {
    // A PL who is also the region's manager: four-eyes refuses the release.
    await sql(
      `insert into staff_org_role (staff_user_id, role, region_id, granted_by)
       values ($1, 'regional_operations_manager', $2, $3)`,
      [projectLead, seedRegionIds.nord, seedStaffUserIds.admin],
    );
    const id = await participant();
    const placed = await readJson(await place(id, projectLead), LegalHoldsView);
    expect(placed.holds[0]!.capabilities.release).toBe(false);
    expect((await release(placed.holds[0]!.id, projectLead)).status).toBe(403);
    expect((await release(placed.holds[0]!.id, regionalOperationsManager)).status).toBe(204);
  });

  it("is refused outside the manager's region", async () => {
    const id = await participant(lagerSued);
    await sql(
      `insert into project_membership (project_id, staff_user_id, role) values ($1, $2, 'project_lead')
       on conflict do nothing`,
      [lagerSued, projectLead],
    );
    const placed = await place(id, projectLead);
    expect(placed.status).toBe(201);
    const holdId = (await readJson(placed, LegalHoldsView)).holds[0]!.id;
    expect((await release(holdId, regionalOperationsManager)).status).toBe(404);
  });
});

describe("the evidence-only phase (Q64)", () => {
  it("refuses ordinary reads and keeps the participation out of the list", async () => {
    const id = await participant();
    const before = await app.request(`/api/v1/participations/${id}`, {
      headers: staff[projectLead]!,
    });
    expect(before.status).toBe(200);
    await sql("update participation set evidence_set_since = now() where id = $1", [id]);
    for (const path of ["", "/history", "/funding", "/dsv"]) {
      const res = await app.request(`/api/v1/participations/${id}${path}`, {
        headers: staff[projectLead]!,
      });
      expect(await codesOf(res, 403)).toEqual(["evidence_set_phase"]);
    }
    // Hidden stays hidden: 404, not 403.
    const hidden = await participant(lagerSued);
    await sql("update participation set evidence_set_since = now() where id = $1", [hidden]);
    expect(
      (await app.request(`/api/v1/participations/${hidden}`, { headers: staff[regionalAdmin]! }))
        .status,
    ).toBe(404);
    const list = await app.request(`/api/v1/projects/${werkNord}/participations`, {
      headers: staff[projectLead]!,
    });
    expect(JSON.stringify(await list.json())).not.toContain(id);
    // Its holds stay readable.
    const holds = await app.request(`/api/v1/participations/${id}/legal-holds`, {
      headers: staff[projectLead]!,
    });
    expect((await readJson(holds, LegalHoldsView)).evidenceSetSince).not.toBeNull();
    // Unauthenticated stays 401.
    expect((await app.request(`/api/v1/participations/${id}`)).status).toBe(401);
  });
});
