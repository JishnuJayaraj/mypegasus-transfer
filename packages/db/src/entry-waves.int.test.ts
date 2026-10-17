import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds, seedWaves } from "./seed";
import { auditContext, call, pl, resetTestDatabase, testDatabaseUrls, textDates } from "./testing";

// Slice 2 plan 5.3 and 5.6 (PR 2b): waves are written only through create_entry_wave and
// update_entry_wave, each with exactly one audit event (AC-6), under the exclusive project lock
// taken first (D3, round 23, AC-7).
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner, types: textDates });
const app = new Client({ connectionString: urls.app });
const other = new Client({ connectionString: urls.app });

beforeAll(() => Promise.all([owner.connect(), app.connect(), other.connect()]));
afterAll(() => Promise.all([owner.end(), app.end(), other.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const werkNord = seedProjectIds.werkNord;
const [w1] = seedWaves;
const dates = {
  signingDeadline: "2091-08-14",
  defaultTgStart: "2091-09-01",
  defaultTgEnd: "2092-08-31",
  latestEntryDate: "2091-09-15",
};

const createWave = (args: Record<string, unknown> = {}) =>
  call(app, "create_entry_wave", {
    projectId: werkNord,
    code: "W3",
    name: "Welle 3",
    context: pl,
    ...dates,
    ...args,
  });

/** update_entry_wave with W1's current values, changed by `args`. */
const updateW1 = (args: Record<string, unknown> = {}) =>
  call(app, "update_entry_wave", {
    projectId: werkNord,
    id: w1.id,
    code: w1.code,
    name: w1.name,
    signingDeadline: w1.signingDeadline,
    defaultTgStart: w1.defaultTgStart,
    defaultTgEnd: w1.defaultTgEnd,
    latestEntryDate: w1.latestEntryDate,
    context: pl,
    ...args,
  });

const waveEvents = async () =>
  (
    await owner.query(
      `select event_type, participation_id, request_id, details from audit_event
       where event_type in ('entry_wave_created', 'entry_wave_changed') order by seq offset 2`,
    )
  ).rows;

describe("create_entry_wave (AC-6)", () => {
  it("creates the wave and one audit event with its dates, never code or name", async () => {
    const id = await createWave({
      context: auditContext({
        actorType: "user",
        staffUserId: seedStaffUserIds.projectLead,
        requestId: "req-1",
      }),
    });
    const { rows } = await owner.query(
      `select project_id, code, name, signing_deadline, default_tg_start, default_tg_end,
         latest_entry_date, updated_at = created_at as fresh from project_entry_wave where id = $1`,
      [id],
    );
    expect(rows).toEqual([
      {
        project_id: werkNord,
        code: "W3",
        name: "Welle 3",
        signing_deadline: dates.signingDeadline,
        default_tg_start: dates.defaultTgStart,
        default_tg_end: dates.defaultTgEnd,
        latest_entry_date: dates.latestEntryDate,
        fresh: true,
      },
    ]);
    expect(await waveEvents()).toEqual([
      {
        event_type: "entry_wave_created",
        participation_id: null,
        request_id: "req-1",
        details: { waveId: id, ...dates },
      },
    ]);
  });

  it("creates a wave without dates", async () => {
    const id = await createWave({
      signingDeadline: null,
      defaultTgStart: null,
      defaultTgEnd: null,
      latestEntryDate: null,
    });
    expect((await waveEvents()).map((e) => e.details)).toEqual([{ waveId: id }]);
  });

  it.each([
    ["in a ta_only project", { projectId: seedProjectIds.verwaltung }, "not_ta_tg"],
    [
      "in an unknown project",
      { projectId: "00000000-0000-4000-9000-0000000000ff" },
      "project_not_found",
    ],
    ["with an invalid code", { code: "W 3" }, "invalid_argument"],
    ["without a code", { code: null }, "invalid_argument"],
    ["with an untrimmed name", { name: "Welle 3 " }, "invalid_argument"],
    ["with a 101-character name", { name: "x".repeat(101) }, "invalid_argument"],
    ["with a control character in the name", { name: "Welle\t3" }, "invalid_argument"],
    ["with a taken code", { code: "W1" }, "23505"],
    ["with the signing deadline after the start", { signingDeadline: "2091-09-02" }, "23514"],
    [
      "with the signing deadline after the latest entry",
      { defaultTgStart: null, signingDeadline: "2091-09-16" },
      "23514",
    ],
    ["with the start after the latest entry", { defaultTgStart: "2091-09-16" }, "23514"],
    ["with the end before the start", { defaultTgEnd: "2091-08-31" }, "23514"],
    [
      "by the system",
      { context: auditContext({ actorType: "system", systemJob: "seed" }) },
      "actor_not_allowed",
    ],
    [
      "in assisted mode",
      {
        context: auditContext({
          actorType: "user",
          staffUserId: seedStaffUserIds.projectLead,
          onBehalfOf: "00000000-0000-4000-a000-000000000001",
        }),
      },
      "invalid_actor",
    ],
  ])("refuses a wave %s, without writing", async (_label, args, code) => {
    expect(await refusal(createWave(args))).toBe(code);
    expect((await owner.query("select count(*)::int as n from project_entry_wave")).rows).toEqual([
      { n: seedWaves.length },
    ]);
    expect(await waveEvents()).toEqual([]);
  });
});

describe("update_entry_wave (AC-6)", () => {
  it("changes the wave and lists the changed keys with old and new dates, never the name", async () => {
    await updateW1({ name: "Welle eins", latestEntryDate: "2091-03-20", defaultTgEnd: null });
    const { rows } = await owner.query(
      "select name, default_tg_end, latest_entry_date, updated_at > created_at as touched from project_entry_wave where id = $1",
      [w1.id],
    );
    expect(rows).toEqual([
      { name: "Welle eins", default_tg_end: null, latest_entry_date: "2091-03-20", touched: true },
    ]);
    expect(await waveEvents()).toEqual([
      {
        event_type: "entry_wave_changed",
        participation_id: null,
        request_id: null,
        details: {
          waveId: w1.id,
          fields: ["name", "defaultTgEnd", "latestEntryDate"],
          dates: {
            defaultTgEnd: { from: w1.defaultTgEnd, to: null },
            latestEntryDate: { from: w1.latestEntryDate, to: "2091-03-20" },
          },
        },
      },
    ]);
  });

  it("lists a code change without dates", async () => {
    await updateW1({ code: "W1a" });
    expect((await waveEvents()).map((e) => e.details)).toEqual([
      { waveId: w1.id, fields: ["code"] },
    ]);
  });

  it.each([
    ["to its current values", {}, "wave_unchanged"],
    ["of another project", { projectId: seedProjectIds.lagerSued }, "wave_not_found"],
    [
      "of an unknown project",
      { projectId: "00000000-0000-4000-9000-0000000000ff" },
      "project_not_found",
    ],
    ["with an empty name", { name: "" }, "invalid_argument"],
    ["to a taken code", { code: "W2" }, "23505"],
    ["to a start after the latest entry", { defaultTgStart: "2091-03-16" }, "23514"],
    [
      "by the system",
      { context: auditContext({ actorType: "system", systemJob: "seed" }) },
      "actor_not_allowed",
    ],
  ])("refuses a change %s, without writing", async (_label, args, code) => {
    expect(await refusal(updateW1(args))).toBe(code);
    expect(await waveEvents()).toEqual([]);
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

const createSql = `select create_entry_wave(p_project_id => $1, p_code => 'W3', p_name => 'Welle 3',
  p_context => $2::audit_context)`;
const updateSql = `select update_entry_wave(p_project_id => $1, p_id => $2, p_code => 'W1',
  p_name => 'Welle 1', p_signing_deadline => null, p_default_tg_start => null,
  p_default_tg_end => null, p_latest_entry_date => null, p_context => $3::audit_context)`;

describe("the wave functions take the exclusive project lock first (AC-7)", () => {
  it("wait while a participation of the project is locked, and a status change waits for them", async () => {
    const participationId = await call(app, "create_participation", {
      projectId: werkNord,
      context: pl,
      entryWaveId: w1.id,
    });
    await app.query("begin");
    try {
      await app.query("select 1 from lock_participation($1)", [participationId]);
      expect(await tryWithin(other, createSql, [werkNord, pl])).toBe("55P03");
      expect(await tryWithin(other, updateSql, [werkNord, w1.id, pl])).toBe("55P03");
      // Even a refused call waits for the lock first.
      const system = auditContext({ actorType: "system", systemJob: "seed" });
      expect(await tryWithin(other, createSql, [werkNord, system])).toBe("55P03");
    } finally {
      await app.query("rollback");
    }

    await app.query("begin");
    try {
      await app.query(updateSql, [werkNord, w1.id, pl]);
      expect(
        await tryWithin(other, "select 1 from lock_participation($1)", [participationId]),
      ).toBe("55P03");
      expect(
        await tryWithin(
          other,
          `select change_participation_status(p_id => $1, p_expected_from => 'imported',
             p_field => 'status', p_to => 'contacted', p_context => $2::audit_context)`,
          [participationId, pl],
        ),
      ).toBe("55P03");
      // Another project's setup is not affected.
      expect(await tryWithin(other, createSql, [seedProjectIds.lagerSued, pl])).toBe("ok");
    } finally {
      await app.query("rollback");
    }
  });
});
