import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedRegionIds, seedStaffUserIds } from "./seed";
import { auditContext, call, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// Slice 2 plan 5.3 (PR 2a): project creation and editing through their functions (AC-1, AC-4) and
// the project lock acquired inside the functions (D3, round 22, AC-4a).
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner });
const app = new Client({ connectionString: urls.app });
const other = new Client({ connectionString: urls.app });

beforeAll(() => Promise.all([owner.connect(), app.connect(), other.connect()]));
afterAll(() => Promise.all([owner.end(), app.end(), other.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

const asUser = (staffUserId: string) => auditContext({ actorType: "user", staffUserId });
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const createProject = (args: Record<string, unknown> = {}) =>
  call(app, "create_project", {
    name: "Neues Projekt",
    customerName: "Beispiel GmbH",
    type: "ta_tg",
    regionId: seedRegionIds.nord,
    context: pl,
    ...args,
  });

const auditOf = async (projectId: string) =>
  (
    await owner.query(
      `select event_type, actor_staff_user_id, participation_id, details from audit_event
       where project_id = $1 order by seq`,
      [projectId],
    )
  ).rows;

describe("create_project (AC-1)", () => {
  it("creates a draft project with the creator as its PL member and one audit event without free text", async () => {
    const id = await createProject();
    const { rows } = await owner.query(
      "select name, customer_name, type, status, project_agentur_key, created_by, region_id from project where id = $1",
      [id],
    );
    expect(rows).toEqual([
      {
        name: "Neues Projekt",
        customer_name: "Beispiel GmbH",
        type: "ta_tg",
        status: "draft",
        project_agentur_key: null,
        created_by: seedStaffUserIds.projectLead,
        region_id: seedRegionIds.nord,
      },
    ]);
    const members = await owner.query(
      "select staff_user_id, role from project_membership where project_id = $1",
      [id],
    );
    expect(members.rows).toEqual([
      { staff_user_id: seedStaffUserIds.projectLead, role: "project_lead" },
    ]);
    expect(await auditOf(id)).toEqual([
      {
        event_type: "project_created",
        actor_staff_user_id: seedStaffUserIds.projectLead,
        participation_id: null,
        details: { type: "ta_tg" },
      },
    ]);
  });

  it.each([
    ["a consultant", { context: asUser(seedStaffUserIds.consultant) }, "actor_not_allowed"],
    ["an admin", { context: asUser(seedStaffUserIds.admin) }, "actor_not_allowed"],
    [
      "the system",
      { context: auditContext({ actorType: "system", systemJob: "seed" }) },
      "actor_not_allowed",
    ],
    ["an empty name", { name: "" }, "invalid_argument"],
    ["an untrimmed name", { name: " Projekt" }, "invalid_argument"],
    ["a 201-character customer", { customerName: "x".repeat(201) }, "invalid_argument"],
    // Q126: the creator chooses an existing region
    ["no region", { regionId: null }, "region_required"],
    ["an unknown region", { regionId: seedProjectIds.werkNord }, "region_not_found"],
  ])("refuses %s", async (_label, args, code) => {
    expect(await refusal(createProject(args))).toBe(code);
    expect((await owner.query("select count(*)::int as n from project")).rows).toEqual([{ n: 3 }]);
  });
});

describe("update_project (AC-4)", () => {
  it("changes name and customer and lists the changed keys, never the values", async () => {
    const id = await createProject();
    await call(app, "update_project", { id, context: pl, name: "Umbenannt", customerName: null });
    const { rows } = await owner.query("select name from project where id = $1", [id]);
    expect(rows).toEqual([{ name: "Umbenannt" }]);
    expect((await auditOf(id)).at(-1)).toMatchObject({
      event_type: "project_changed",
      details: { fields: ["name"] },
    });
  });

  it("changes the type of a draft project without participations or waves", async () => {
    const id = await createProject();
    await call(app, "update_project", { id, context: pl, type: "ta_only" });
    expect((await auditOf(id)).at(-1)).toMatchObject({
      details: { fields: ["type"], type: "ta_only" },
    });
  });

  it("refuses a change to the current values without writing", async () => {
    const id = await createProject();
    expect(
      await refusal(
        call(app, "update_project", { id, context: pl, name: "Neues Projekt", type: "ta_tg" }),
      ),
    ).toBe("project_unchanged");
    expect(await auditOf(id)).toHaveLength(1);
  });

  it("refuses a type change once the project has waves, participations or is active (Q98)", async () => {
    // Werk Nord has waves; the ta_only project gets a participation.
    expect(
      await refusal(
        call(app, "update_project", { id: seedProjectIds.werkNord, context: pl, type: "ta_only" }),
      ),
    ).toBe("project_has_waves");
    await call(app, "create_participation", { projectId: seedProjectIds.verwaltung, context: pl });
    expect(
      await refusal(
        call(app, "update_project", { id: seedProjectIds.verwaltung, context: pl, type: "ta_tg" }),
      ),
    ).toBe("project_has_participations");
    await owner.query(
      "update project set status = 'active', activated_at = now(), activated_by = $2 where id = $1",
      [seedProjectIds.lagerSued, seedStaffUserIds.projectLead],
    );
    expect(
      await refusal(
        call(app, "update_project", { id: seedProjectIds.lagerSued, context: pl, type: "ta_only" }),
      ),
    ).toBe("project_not_draft");
  });

  it.each([
    ["an unknown project", { id: "00000000-0000-4000-9000-0000000000ff" }, "project_not_found"],
    ["an invalid name", { name: "" }, "invalid_argument"],
    [
      "the system",
      { context: auditContext({ actorType: "system", systemJob: "seed" }) },
      "actor_not_allowed",
    ],
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
    expect(
      await refusal(
        call(app, "update_project", {
          id: seedProjectIds.lagerSued,
          context: pl,
          name: "X",
          ...args,
        }),
      ),
    ).toBe(code);
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

describe("the project lock lives in the functions (D3, round 22, AC-4a)", () => {
  let participationId: string;
  const projectId = seedProjectIds.werkNord;
  beforeEach(async () => {
    participationId = await call(app, "create_participation", { projectId, context: pl });
  });

  it("blocks a setup mutation while a participation of the project is locked, and vice versa", async () => {
    await app.query("begin");
    try {
      await app.query("select 1 from lock_participation($1)", [participationId]);
      expect(
        await tryWithin(
          other,
          "select update_project(p_id => $1, p_context => $2::audit_context, p_name => 'X')",
          [projectId, pl],
        ),
      ).toBe("55P03");
    } finally {
      await app.query("rollback");
    }

    await app.query("begin");
    try {
      await app.query("select lock_project_setup($1)", [projectId]);
      expect(
        await tryWithin(other, "select 1 from lock_participation($1)", [participationId]),
      ).toBe("55P03");
      expect(
        await tryWithin(
          other,
          "select create_participation(p_project_id => $1, p_context => $2::audit_context)",
          [projectId, pl],
        ),
      ).toBe("55P03");
      // Another project is not affected.
      expect(
        await tryWithin(
          other,
          "select update_project(p_id => $1, p_context => $2::audit_context, p_name => 'Y')",
          [seedProjectIds.lagerSued, pl],
        ),
      ).toBe("ok");
    } finally {
      await app.query("rollback");
    }
  });

  it("lets participation locks of one project share, and is re-entrant within a transaction", async () => {
    const second = await call(app, "create_participation", { projectId, context: pl });
    await app.query("begin");
    try {
      await app.query("select 1 from lock_participation($1)", [participationId]);
      expect(await tryWithin(other, "select 1 from lock_participation($1)", [second])).toBe("ok");
    } finally {
      await app.query("rollback");
    }

    await app.query("begin");
    try {
      await app.query("select lock_project_setup($1)", [projectId]);
      await app.query(
        "select create_participation(p_project_id => $1, p_context => $2::audit_context)",
        [projectId, pl],
      );
      await app.query("select 1 from lock_participation($1)", [participationId]);
      await app.query(
        "select update_project(p_id => $1, p_context => $2::audit_context, p_name => 'Z')",
        [projectId, pl],
      );
    } finally {
      await app.query("rollback");
    }
  });

  it("refuses to lock an unknown project", async () => {
    expect(
      await refusal(
        app.query("select lock_project_setup($1)", ["00000000-0000-4000-9000-0000000000ff"]),
      ),
    ).toBe("project_not_found");
  });

  it("takes the new project's exclusive lock in create_project and first in update_project", async () => {
    const newId = "00000000-0000-4000-9000-0000000000aa";
    await app.query("begin");
    try {
      // Held by another transaction (here, on the id a creation is about to use).
      await app.query("select pg_advisory_xact_lock(hashtextextended('project:' || $1, 0))", [
        newId,
      ]);
      expect(
        await tryWithin(
          other,
          `select create_project(p_name => 'X', p_customer_name => 'Y', p_type => 'ta_only',
             p_context => $1::audit_context, p_id => $2)`,
          [pl, newId],
        ),
      ).toBe("55P03");
      await app.query("select lock_project_setup($1)", [seedProjectIds.lagerSued]);
      // Even an invalid actor waits for the lock before it is refused.
      expect(
        await tryWithin(
          other,
          "select update_project(p_id => $1, p_context => $2::audit_context, p_name => 'X')",
          [seedProjectIds.lagerSued, auditContext({ actorType: "system", systemJob: "seed" })],
        ),
      ).toBe("55P03");
    } finally {
      await app.query("rollback");
    }
  });
});
