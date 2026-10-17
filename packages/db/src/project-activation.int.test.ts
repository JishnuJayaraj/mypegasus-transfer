import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  createWave,
  nightly,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// Slice 2 plan 5.3 and 5.5 (PR 2e-1): activate_project re-checks the activation blockers under
// the project lock (AC-17), and change_participation_status refuses every transition of a project
// that isn't active (the draft gate, D9, AC-18).
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner });
const app = new Client({ connectionString: urls.app });
const other = new Client({ connectionString: urls.app });

beforeAll(() => Promise.all([owner.connect(), app.connect(), other.connect()]));
afterAll(() => Promise.all([owner.end(), app.end(), other.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

const { werkNord, lagerSued, verwaltung } = seedProjectIds;
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

/** Pins a synthetic template (the service validates real ones) and makes it the Project Agentur. */
async function choose(projectId: string, agenturKey = "test-agentur", version = 1) {
  await call(app, "pin_agentur_template", {
    projectId,
    agenturKey,
    version,
    content: { kind: "regional_template", agenturKey, version },
    sha256: String(version).repeat(64),
    baseDefaultsVersion: 1,
    context: pl,
  });
  await call(app, "update_project", { id: projectId, context: pl, projectAgenturKey: agenturKey });
}

const activate = (projectId: string, args: Record<string, unknown> = {}) =>
  call(app, "activate_project", { id: projectId, baseDefaultsVersion: 3, context: pl, ...args });

const projectRow = async (projectId: string) =>
  (
    await owner.query(
      `select status, activated_by, activated_at between now() - interval '1 minute' and now() as recent
       from project where id = $1`,
      [projectId],
    )
  ).rows[0];

const activations = async (projectId: string) =>
  (
    await owner.query(
      `select actor_staff_user_id, participation_id, details from audit_event
       where project_id = $1 and event_type = 'project_activated'`,
      [projectId],
    )
  ).rows;

describe("activate_project (AC-17)", () => {
  it("activates a draft with its Project Agentur and a wave with a latest entry date, by database time, audited with the snapshot and base-defaults versions (R26, AC-45)", async () => {
    await choose(werkNord, "test-agentur", 1);
    await choose(werkNord, "test-agentur-b", 2);
    await activate(werkNord);
    expect(await projectRow(werkNord)).toEqual({
      status: "active",
      activated_by: seedStaffUserIds.projectLead,
      recent: true,
    });
    expect(await activations(werkNord)).toEqual([
      {
        actor_staff_user_id: seedStaffUserIds.projectLead,
        participation_id: null,
        details: {
          projectAgenturKey: "test-agentur-b",
          projectAgenturVersion: 2,
          baseDefaultsVersion: 3,
        },
      },
    ]);
  });

  it("needs no wave in a ta_only project (Q77)", async () => {
    await choose(verwaltung);
    await activate(verwaltung);
    expect((await projectRow(verwaltung)).status).toBe("active");
  });

  it("refuses without a Project Agentur, even with pinned templates (Q76, Q90)", async () => {
    await call(app, "pin_agentur_template", {
      projectId: werkNord,
      agenturKey: "test-agentur",
      version: 1,
      content: { kind: "regional_template", agenturKey: "test-agentur", version: 1 },
      sha256: "1".repeat(64),
      baseDefaultsVersion: 1,
      context: pl,
    });
    expect(await refusal(activate(werkNord))).toBe("project_activation_blocked");
    expect(await refusal(activate(verwaltung))).toBe("project_activation_blocked");
    expect((await projectRow(werkNord)).status).toBe("draft");
    expect(await activations(werkNord)).toEqual([]);
  });

  it("refuses a ta_tg project whose waves have no latest entry date (Q77)", async () => {
    await choose(lagerSued);
    expect(await refusal(activate(lagerSued))).toBe("no_entry_wave_with_latest_entry_date");
    await owner.query(
      "insert into project_entry_wave (project_id, code, name) values ($1, 'E1', 'Entwurf')",
      [lagerSued],
    );
    expect(await refusal(activate(lagerSued))).toBe("no_entry_wave_with_latest_entry_date");
    await createWave(owner, lagerSued);
    expect(await refusal(activate(lagerSued))).toBe("ok");
  });

  it("is one-way: an active project is refused", async () => {
    await choose(verwaltung);
    await activate(verwaltung);
    expect(await refusal(activate(verwaltung))).toBe("project_not_draft");
    expect(await activations(verwaltung)).toHaveLength(1);
  });

  it.each([
    ["an unknown project", { id: "00000000-0000-4000-9000-0000000000ff" }, "project_not_found"],
    ["no base-defaults version", { baseDefaultsVersion: null }, "invalid_argument"],
    ["base-defaults version 0", { baseDefaultsVersion: 0 }, "invalid_argument"],
    ["the system", { context: nightly }, "actor_not_allowed"],
    [
      "assisted mode",
      {
        context: auditContext({
          actorType: "user",
          staffUserId: seedStaffUserIds.projectLead,
          onBehalfOf: "00000000-0000-4000-a000-000000000001",
        }),
      },
      "invalid_actor",
    ],
  ])("refuses %s", async (_label, args, code) => {
    await choose(verwaltung);
    expect(await refusal(activate(verwaltung, args))).toBe(code);
    expect((await projectRow(verwaltung)).status).toBe("draft");
  });
});

describe("the draft gate in change_participation_status (D9, AC-18)", () => {
  it("refuses every transition of a draft project and writes nothing; creation and wave assignment work", async () => {
    const waveId = await createWave(owner, lagerSued);
    const id = await call(app, "create_participation", { projectId: lagerSued, context: pl });
    await call(app, "assign_entry_wave", { id, waveId, context: pl });
    expect(
      await refusal(changeStatus(app, id, { field: "status", from: "imported", to: "contacted" })),
    ).toBe("project_not_active");
    // Before the stale check: the project's state is refused first (round 28's order).
    expect(
      await refusal(changeStatus(app, id, { field: "status", from: "informed", to: "withdrawn" })),
    ).toBe("project_not_active");
    const { rows } = await owner.query(
      "select status, entry_wave_id from participation where id = $1",
      [id],
    );
    expect(rows).toEqual([{ status: "imported", entry_wave_id: waveId }]);
    const events = await owner.query(
      "select event_type from audit_event where participation_id = $1 order by seq",
      [id],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      "participation_created",
      "entry_wave_assigned",
    ]);
  });

  it("lets the participations move once the project is active", async () => {
    const id = await call(app, "create_participation", { projectId: verwaltung, context: pl });
    await choose(verwaltung);
    await activate(verwaltung);
    expect(
      await refusal(changeStatus(app, id, { field: "status", from: "imported", to: "contacted" })),
    ).toBe("ok");
  });
});

/** Runs `sql` on `client` with a short lock timeout; resolves to `ok` or the error code. */
async function tryWithin(client: Client, sql: string, params: unknown[] = []) {
  await client.query("begin");
  await client.query("set local lock_timeout = '300ms'");
  try {
    return await refusal(client.query(sql, params));
  } finally {
    await client.query("rollback");
  }
}

describe("activation and the project lock (D3)", () => {
  it("waits for a locked participation of the project, and a status change waits for the activation", async () => {
    const id = await call(app, "create_participation", { projectId: verwaltung, context: pl });
    await choose(verwaltung);
    const activation = `select activate_project(p_id => $1, p_base_defaults_version => 1,
      p_context => $2::audit_context)`;
    await app.query("begin");
    try {
      await app.query("select 1 from lock_participation($1)", [id]);
      expect(await tryWithin(other, activation, [verwaltung, pl])).toBe("55P03");
    } finally {
      await app.query("rollback");
    }

    await app.query("begin");
    try {
      await app.query(activation, [verwaltung, pl]);
      expect(
        await tryWithin(
          other,
          `select change_participation_status(p_id => $1, p_field => 'status',
             p_expected_from => 'imported', p_to => 'contacted', p_context => $2::audit_context)`,
          [id, pl],
        ),
      ).toBe("55P03");
    } finally {
      await app.query("commit");
    }
    // Once the activation committed, the change that waited goes through.
    expect(
      await refusal(changeStatus(app, id, { field: "status", from: "imported", to: "contacted" })),
    ).toBe("ok");
  });
});
