import { auditEvent, createDb, seedProjectIds, seedStaffUserIds, sql } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { HistoryPage } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { historyEntry } from "./routes/history";
import { expectProblem, login, readJson, testApp } from "./testing";

// GET /participations/{id}/history (data-protection.md, audit metadata; Q157) against
// transfer_test. Synthetic data only.
const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.werkNord;
const waveId = "00000000-0000-4000-b000-000000000001"; // the seeded W1
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const plContext = sql`row('user'::actor_type, ${projectLead}::uuid, null::uuid, null::text,
  null::uuid, 'req-test'::text, null::text)::audit_context`;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(() => resetTestDatabase({ seed: true, active: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

/** A participation the PL created and assigned to W1: two `case` events. */
async function participation() {
  const { rows } = await db.execute<{ id: string }>(
    sql`select create_participation(p_project_id => ${projectId}::uuid, p_context => ${plContext}) as id`,
  );
  const id = rows[0]!.id;
  await db.execute(
    sql`select assign_entry_wave(p_id => ${id}::uuid, p_wave_id => ${waveId}::uuid, p_context => ${plContext})`,
  );
  return id;
}

const get = (id: string, viewer: string, query = "") =>
  app.request(`/api/v1/participations/${id}/history${query}`, { headers: staff[viewer]! });

const openings = async (id: string) =>
  (
    await owner
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(
        sql`${auditEvent.participationId} = ${id} and ${auditEvent.eventType} = 'audit_history_opened'`,
      )
  ).length;

describe("GET /participations/{id}/history", () => {
  it("answers the PL's history, newest first, with the actor's name, private and no-store", async () => {
    const id = await participation();
    const res = await get(id, projectLead);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const page = await readJson(res, HistoryPage);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        occurredAt: expect.stringMatching(/Z$/),
        type: "entry_wave_assigned",
        actor: { kind: "staff", name: "Petra Projektleitung", assisted: false, job: null },
        change: null,
        reasonCode: null,
        effectiveDate: null,
        details: { waveId, previousWaveId: null },
      },
      {
        occurredAt: expect.stringMatching(/Z$/),
        type: "participation_created",
        actor: { kind: "staff", name: "Petra Projektleitung", assisted: false, job: null },
        change: { field: "status", from: null, to: "imported" },
        reasonCode: null,
        effectiveDate: null,
        details: {},
      },
    ]);
    expect(await openings(id)).toBe(1);
  });

  it("pages with an opaque cursor; only the first page is audited as an opening", async () => {
    const id = await participation();
    const first = await readJson(await get(id, projectLead, "?limit=1"), HistoryPage);
    expect(first.items.map((item) => item.type)).toEqual(["entry_wave_assigned"]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await readJson(
      await get(id, projectLead, `?limit=1&cursor=${first.nextCursor}`),
      HistoryPage,
    );
    expect(second.items.map((item) => item.type)).toEqual(["participation_created"]);
    expect(await openings(id)).toBe(1);
    const problem = await expectProblem(
      await get(id, projectLead, "?cursor=not-a-cursor"),
      400,
      "validation-error",
    );
    expect(problem.errors).toEqual([
      { parameter: "cursor", code: "invalid_cursor", detail: "Unknown cursor" },
    ]);
  });

  it("checks visibility, then permission: 404, 403 for an unassigned consultant, 401 without a session", async () => {
    const id = await participation();
    await expectProblem(
      await get("00000000-0000-4000-a000-00000000dead", projectLead),
      404,
      "not-found",
    );
    await expectProblem(await get(id, consultant), 403, "forbidden");
    await expectProblem(
      await app.request(`/api/v1/participations/${id}/history`),
      401,
      "unauthenticated",
    );
    await expectProblem(await get(id, projectLead, "?limit=101"), 400, "validation-error");
    expect(await openings(id)).toBe(0);
  });

  it("gives back office no case events", async () => {
    const id = await participation();
    const page = await readJson(await get(id, backOffice), HistoryPage);
    expect(page.items).toEqual([]);
    expect(await openings(id)).toBe(1);
  });
});

describe("historyEntry", () => {
  const row = {
    seq: "7",
    occurred_at: "2026-10-23T08:00:00.000000Z",
    event_type: "reminder_delivery",
    actor_type: "system" as const,
    actor_name: null,
    system_job: "reminders.send",
    on_behalf: false,
    field: null,
    from_value: null,
    to_value: null,
    reason_code: "nothing_open",
    effective_date: null,
    details: { outcome: "cancelled" },
  };

  it("passes what the projection shows", () => {
    expect(historyEntry(row)).toMatchObject({
      type: "reminder_delivery",
      actor: { kind: "system", job: "reminders.send" },
      reasonCode: "nothing_open",
      details: { outcome: "cancelled" },
    });
  });

  it("refuses a row with more than its projection shows: never passed on", () => {
    const more = "audit_history returned more than the projection shows";
    expect(() => historyEntry({ ...row, details: { outcome: "sent", reminderId: "x" } })).toThrow(
      more,
    );
    expect(() =>
      historyEntry({ ...row, event_type: "reminder_queued", reason_code: "nothing_open" }),
    ).toThrow(more);
    expect(() => historyEntry({ ...row, to_value: "x" })).toThrow(more);
    expect(() => historyEntry({ ...row, event_type: "document_opened" })).toThrow();
  });
});
