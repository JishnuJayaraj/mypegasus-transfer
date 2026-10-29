import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  createWave,
  informedParticipation,
  nightly,
  pl,
  resetTestDatabase,
  reviewer,
  testDatabaseUrls,
  textDates,
} from "./testing";

// AC-16, AC-18 (plan 5.4): every write goes through the functions as transfer_app; the owner
// only reads the audit trail and sets up waves.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner, types: textDates });

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const failsWith = (code: string) => ({ code: "P0001", message: code });

async function row(id: string) {
  const { rows } = await owner.query("select * from participation where id = $1", [id]);
  return rows[0];
}

async function events(id: string) {
  const { rows } = await owner.query(
    `select event_type, actor_type, actor_staff_user_id, system_job, field, from_value, to_value,
       reason_code, effective_date, details, flagged_for_review, request_id, job_id
     from audit_event where participation_id = $1 order by seq`,
    [id],
  );
  return rows;
}

/** Informed with a wave, DSV offered on the wave's deadline and signed. */
async function signedParticipation() {
  const waveId = await createWave(owner);
  const id = await informedParticipation(app, { entryWaveId: waveId });
  await changeStatus(app, id, { field: "dsv_status", from: "not_offered", to: "dsv_offered" });
  await changeStatus(app, id, { field: "dsv_status", from: "dsv_offered", to: "dsv_signed" });
  return id;
}

describe("create_participation", () => {
  it("creates `imported` with its audit event, with a fixed id and a wave", async () => {
    const waveId = await createWave(owner);
    const fixed = "00000000-0000-4000-a000-0000000000aa";
    const id = await call(app, "create_participation", {
      projectId: seedProjectIds.werkNord,
      context: pl,
      entryWaveId: waveId,
      id: fixed,
    });
    expect(id).toBe(fixed);
    expect(await row(id)).toMatchObject({
      status: "imported",
      profiling_status: "not_started",
      dsv_status: "not_offered",
      profiling_exception_request_id: null,
      entry_wave_id: waveId,
      status_version: 0,
    });
    expect(await events(id)).toEqual([
      expect.objectContaining({
        event_type: "participation_created",
        actor_type: "user",
        actor_staff_user_id: seedStaffUserIds.projectLead,
        field: "status",
        from_value: null,
        to_value: "imported",
        details: { entryWaveId: waveId },
      }),
    ]);
  });

  it.each([
    ["the system", nightly, seedProjectIds.werkNord, undefined, "actor_not_allowed"],
    [
      "a participant",
      auditContext({ actorType: "participant", participationId: seedProjectIds.werkNord }),
      seedProjectIds.werkNord,
      undefined,
      "actor_not_allowed",
    ],
    [
      "an unknown project",
      pl,
      "00000000-0000-4000-9000-0000000000ff",
      undefined,
      "project_not_found",
    ],
    ["a wave in a ta_only project", pl, seedProjectIds.verwaltung, "wave", "not_ta_tg"],
    ["a wave of another project", pl, seedProjectIds.lagerSued, "wave", "wave_of_other_project"],
  ])("refuses %s", async (_label, context, projectId, wave, code) => {
    const entryWaveId = wave ? await createWave(owner) : undefined;
    await expect(
      call(app, "create_participation", {
        projectId,
        context,
        ...(entryWaveId && { entryWaveId }),
      }),
    ).rejects.toMatchObject(failsWith(code));
  });
});

describe("actors (fail closed)", () => {
  it("refuses a context without an actor type", async () => {
    const context = auditContext({ actorType: null, staffUserId: seedStaffUserIds.projectLead });
    await expect(
      call(app, "create_participation", { projectId: seedProjectIds.werkNord, context }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });

  it("creates nothing when the creation edge is missing", async () => {
    await owner.query("begin");
    try {
      await owner.query(
        "delete from lifecycle_edge where from_value is null and to_value = 'imported'",
      );
      await expect(
        call(owner, "create_participation", { projectId: seedProjectIds.werkNord, context: pl }),
      ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    } finally {
      await owner.query("rollback");
    }
  });
});

describe("change_participation_status (AC-16)", () => {
  let id: string;
  beforeEach(async () => {
    id = await call(app, "create_participation", {
      projectId: seedProjectIds.werkNord,
      context: pl,
    });
  });

  it("writes the column and exactly one audit row, and bumps the version", async () => {
    const requestId = "6f1c2b6e-1b7a-4c5e-9d1a-2f3b4c5d6e7f";
    const eventId = await changeStatus(app, id, {
      field: "status",
      from: "imported",
      to: "contacted",
      context: auditContext({
        actorType: "user",
        staffUserId: seedStaffUserIds.consultant,
        requestId,
      }),
    });
    expect(await row(id)).toMatchObject({ status: "contacted", status_version: 1 });
    const trail = await events(id);
    expect(trail).toHaveLength(2);
    expect(trail[1]).toEqual({
      event_type: "status_changed",
      actor_type: "user",
      actor_staff_user_id: seedStaffUserIds.consultant,
      system_job: null,
      field: "status",
      from_value: "imported",
      to_value: "contacted",
      reason_code: null,
      effective_date: null,
      details: {},
      flagged_for_review: false,
      request_id: requestId,
      job_id: null,
    });
    const { rows } = await owner.query("select id from audit_event order by seq desc limit 1");
    expect(rows[0].id).toBe(eventId);
  });

  it("leaves neither the change nor the audit row after a rollback", async () => {
    await app.query("begin");
    await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
    await app.query("rollback");
    expect(await row(id)).toMatchObject({ status: "imported", status_version: 0 });
    expect(await events(id)).toHaveLength(1);
  });

  it("rejects a stale expected status (compare-and-set) and writes nothing", async () => {
    await expect(
      changeStatus(app, id, { field: "status", from: "contacted", to: "informed" }),
    ).rejects.toMatchObject(failsWith("stale_status"));
    await expect(
      call(app, "lock_participation", { id: seedProjectIds.werkNord }),
    ).rejects.toMatchObject(failsWith("participation_not_found"));
    expect(await events(id)).toHaveLength(1);
  });

  it("serialises two concurrent changes: one wins, the other gets stale_status (AC-19 at the DB)", async () => {
    const second = new Client({ connectionString: urls.app });
    await second.connect();
    try {
      await app.query("begin");
      await second.query("begin");
      await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
      // Caught at once: the refusal can arrive before `commit` resolves here, and a rejection
      // without a handler fails the run as unhandled.
      const blocked = changeStatus(second, id, {
        field: "status",
        from: "imported",
        to: "contacted",
      }).then(
        () => "committed",
        (error: unknown) => error,
      );
      await app.query("commit");
      expect(await blocked).toMatchObject(failsWith("stale_status"));
      await second.query("rollback");
    } finally {
      await second.end();
    }
    expect(await events(id)).toHaveLength(2);
  });

  it.each([
    ["an edge that isn't in lifecycle_edge", { field: "status", from: "imported", to: "informed" }],
    [
      "a user edge taken by the system",
      { field: "status", from: "imported", to: "contacted", context: nightly },
    ],
    [
      "an entry kind on another edge",
      { field: "status", from: "imported", to: "contacted", entryKind: "reconciliation" },
    ],
    ["a value of another track", { field: "status", from: "imported", to: "dsv_signed" }],
  ] as const)("rejects %s (invalid_transition)", async (_label, change) => {
    await expect(changeStatus(app, id, change)).rejects.toMatchObject(
      failsWith("invalid_transition"),
    );
  });

  it("moves the tracks only while informed, DSV only in ta_tg (track_inactive)", async () => {
    await expect(
      changeStatus(app, id, {
        field: "profiling_status",
        from: "not_started",
        to: "profiling_accepted",
      }),
    ).rejects.toMatchObject(failsWith("track_inactive"));
    const taOnly = await informedParticipation(app, { projectId: seedProjectIds.verwaltung });
    await expect(
      changeStatus(app, taOnly, { field: "dsv_status", from: "not_offered", to: "dsv_offered" }),
    ).rejects.toMatchObject(failsWith("track_inactive"));
    await changeStatus(app, taOnly, {
      field: "profiling_status",
      from: "not_started",
      to: "profiling_accepted",
    });
    expect(await row(taOnly)).toMatchObject({ profiling_status: "profiling_accepted" });
  });

  it("never enters a ta_only participation into the TG", async () => {
    const taOnly = await informedParticipation(app, { projectId: seedProjectIds.verwaltung });
    await expect(
      changeStatus(app, taOnly, {
        field: "status",
        from: "informed",
        to: "active_in_tg",
        entryKind: "reconciliation",
        effectiveDate: "2027-03-01",
      }),
    ).rejects.toMatchObject(failsWith("invalid_transition"));
  });

  describe("withdrawal and exit", () => {
    const withdraw = { field: "status", from: "imported", to: "withdrawn" } as const;

    it("sets the end reason, its source, the secondary reasons and withdrawn_on", async () => {
      await changeStatus(app, id, {
        ...withdraw,
        context: nightly,
        endReason: "never_contacted",
        secondaryReasons: ["no_response"],
        effectiveDate: "2027-03-16",
      });
      expect(await row(id)).toMatchObject({
        status: "withdrawn",
        end_reason: "never_contacted",
        end_reason_source: "system",
        end_reason_secondary: "{no_response}",
        withdrawn_on: "2027-03-16",
      });
      expect((await events(id))[1]).toMatchObject({
        actor_type: "system",
        system_job: "lifecycle.evaluate-project",
        reason_code: "never_contacted",
        effective_date: "2027-03-16",
        details: { secondaryReasons: ["no_response"] },
      });
    });

    it.each([
      ["no reason", {}, "reason_required"],
      ["a TG reason", { endReason: "placed_permanent" }, "reason_wrong_phase"],
      ["no withdrawal date", { endReason: "other" }, "effective_date_required"],
      [
        "the primary reason again as secondary",
        { endReason: "other", secondaryReasons: ["other"], effectiveDate: "2027-03-16" },
        "invalid_argument",
      ],
      [
        "a duplicate secondary reason",
        {
          endReason: "other",
          secondaryReasons: ["no_response", "no_response"],
          effectiveDate: "2027-03-16",
        },
        "invalid_argument",
      ],
      [
        "the special-category reason as a secondary one (Q66)",
        {
          endReason: "other",
          secondaryReasons: ["long_term_illness_reduced_earning_capacity"],
          effectiveDate: "2027-03-16",
        },
        "reason_not_storable",
      ],
    ])("refuses %s", async (_label, args, code) => {
      await expect(changeStatus(app, id, { ...withdraw, ...args })).rejects.toMatchObject(
        failsWith(code),
      );
    });

    it("refuses an end reason on a transition that doesn't end", async () => {
      await expect(
        changeStatus(app, id, {
          field: "status",
          from: "imported",
          to: "contacted",
          endReason: "other",
        }),
      ).rejects.toMatchObject(failsWith("invalid_argument"));
    });

    it("refuses the special-category exit reason (Q66) and records a storable one", async () => {
      const signed = await signedParticipation();
      await changeStatus(app, signed, {
        field: "status",
        from: "informed",
        to: "active_in_tg",
        entryKind: "reconciliation",
        effectiveDate: "2027-03-01",
      });
      const exit = {
        field: "status",
        from: "active_in_tg",
        to: "exited",
        effectiveDate: "2027-09-30",
      } as const;
      await expect(
        changeStatus(app, signed, {
          ...exit,
          endReason: "long_term_illness_reduced_earning_capacity",
        }),
      ).rejects.toMatchObject(failsWith("reason_not_storable"));
      await changeStatus(app, signed, { ...exit, endReason: "placed_permanent" });
      expect(await row(signed)).toMatchObject({
        status: "exited",
        exit_date: "2027-09-30",
        tg_entry_date: "2027-03-01",
        end_reason: "placed_permanent",
        end_reason_source: "user",
      });
    });
  });

  describe("DSV offers (Q69, Q79)", () => {
    it("needs a wave before the first offer", async () => {
      const informed = await informedParticipation(app);
      await expect(
        changeStatus(app, informed, {
          field: "dsv_status",
          from: "not_offered",
          to: "dsv_offered",
          offerDeadline: "2027-02-01",
        }),
      ).rejects.toMatchObject(failsWith("wave_required"));
    });

    it("uses the wave's deadline first, needs an explicit one for a re-offer, never invents one", async () => {
      const waveId = await createWave(owner);
      const informed = await informedParticipation(app, { entryWaveId: waveId });
      const offer = { field: "dsv_status", from: "not_offered", to: "dsv_offered" } as const;
      await changeStatus(app, informed, offer);
      expect(await row(informed)).toMatchObject({ offer_deadline: null });
      await changeStatus(app, informed, {
        field: "dsv_status",
        from: "dsv_offered",
        to: "dsv_expired",
        context: nightly,
        effectiveDate: "2027-02-16",
      });
      const reOffer = { field: "dsv_status", from: "dsv_expired", to: "dsv_offered" } as const;
      await expect(changeStatus(app, informed, reOffer)).rejects.toMatchObject(
        failsWith("offer_deadline_required"),
      );
      await changeStatus(app, informed, { ...reOffer, offerDeadline: "2027-02-28" });
      expect(await row(informed)).toMatchObject({
        dsv_status: "dsv_offered",
        offer_deadline: "2027-02-28",
      });
      expect((await events(informed)).at(-1)).toMatchObject({
        details: { offerDeadline: "2027-02-28" },
      });

      await owner.query("update project_entry_wave set signing_deadline = null where id = $1", [
        waveId,
      ]);
      const noDeadline = await informedParticipation(app, { entryWaveId: waveId });
      await expect(changeStatus(app, noDeadline, offer)).rejects.toMatchObject(
        failsWith("offer_deadline_required"),
      );
    });

    it("refuses an offer deadline on another transition", async () => {
      await expect(
        changeStatus(app, id, {
          field: "status",
          from: "imported",
          to: "contacted",
          offerDeadline: "2027-02-28",
        }),
      ).rejects.toMatchObject(failsWith("invalid_argument"));
    });
  });

  describe("TG entry (AC-18)", () => {
    const entry = {
      field: "status",
      from: "informed",
      to: "active_in_tg",
      effectiveDate: "2027-03-01",
    } as const;

    it("records a catch-up with its entry kind and scheduled run time", async () => {
      const signed = await signedParticipation();
      await changeStatus(app, signed, {
        ...entry,
        context: nightly,
        entryKind: "scheduled_entry_catchup",
        scheduledAt: "2027-03-01T03:15:00Z",
      });
      expect(await row(signed)).toMatchObject({
        status: "active_in_tg",
        tg_entry_date: "2027-03-01",
      });
      expect((await events(signed)).at(-1)).toMatchObject({
        actor_type: "system",
        effective_date: "2027-03-01",
        details: { entryKind: "scheduled_entry_catchup", scheduledAt: "2027-03-01T03:15:00.000Z" },
        flagged_for_review: false,
      });
    });

    it("flags a reconciliation for review", async () => {
      const signed = await signedParticipation();
      await changeStatus(app, signed, { ...entry, entryKind: "reconciliation" });
      expect((await events(signed)).at(-1)).toMatchObject({
        actor_type: "user",
        details: { entryKind: "reconciliation" },
        flagged_for_review: true,
      });
    });

    it.each([
      [
        "an automatic kind without its run time",
        { context: nightly, entryKind: "scheduled_entry" },
        "invalid_argument",
      ],
      [
        "a run time on a reconciliation",
        { entryKind: "reconciliation", scheduledAt: "2027-03-01T03:15:00Z" },
        "invalid_argument",
      ],
      [
        "a run time without an entry kind",
        {
          field: "dsv_status",
          from: "dsv_signed",
          to: "dsv_offered",
          scheduledAt: "2027-03-01T03:15:00Z",
        },
        "invalid_transition",
      ],
      [
        "a reconciliation by the system",
        { context: nightly, entryKind: "reconciliation" },
        "invalid_transition",
      ],
      [
        "no entry date",
        { entryKind: "reconciliation", effectiveDate: undefined },
        "effective_date_required",
      ],
    ] as const)("refuses %s", async (_label, args, code) => {
      const signed = await signedParticipation();
      await expect(changeStatus(app, signed, { ...entry, ...args })).rejects.toMatchObject(
        failsWith(code),
      );
    });

    it("refuses an entry without a signed DSV (invariant)", async () => {
      const informed = await informedParticipation(app);
      await expect(
        changeStatus(app, informed, { ...entry, entryKind: "reconciliation" }),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });
});

const fingerprint = (c: string) => `sha256:v1:${c.repeat(64)}`;
const evidenceRecord = "00000000-0000-4000-8000-0000000000e1";

const request = (id: string, extra: { context?: string; fingerprint?: string } = {}) =>
  call(app, "request_profiling_exception", {
    id,
    reason: "agentur_scheduling_unavailable",
    requestedOn: "2027-02-01",
    evidenceRecordId: evidenceRecord,
    evidenceFingerprint: extra.fingerprint ?? fingerprint("a"),
    context: extra.context ?? pl,
  });
const decide = (requestId: string, approve: boolean, context = reviewer) =>
  call(app, "decide_profiling_exception", { requestId, approve, decidedOn: "2027-02-03", context });
const revoke = (requestId: string, context = pl) =>
  call(app, "revoke_profiling_exception", { requestId, context });

async function requests(participationId: string) {
  const { rows } = await owner.query(
    `select id, status, reason_code, requested_by, requested_on, evidence_record_id,
       evidence_fingerprint, decided_by, decided_on, decided_at, superseded_reason
     from profiling_exception_request where participation_id = $1 order by requested_at, id`,
    [participationId],
  );
  return rows;
}

describe("profiling exception requests (Q94, round 16)", () => {
  it("records a request as its own row, current on the participation, and a decision by another user", async () => {
    const id = await informedParticipation(app);
    const requestId = await request(id);
    expect(await row(id)).toMatchObject({
      profiling_exception_request_id: requestId,
      status_version: 3,
    });
    expect(await requests(id)).toEqual([
      {
        id: requestId,
        status: "requested",
        reason_code: "agentur_scheduling_unavailable",
        requested_by: seedStaffUserIds.projectLead,
        requested_on: "2027-02-01",
        evidence_record_id: evidenceRecord,
        evidence_fingerprint: fingerprint("a"),
        decided_by: null,
        decided_on: null,
        decided_at: null,
        superseded_reason: null,
      },
    ]);
    await expect(decide(requestId, true, pl)).rejects.toMatchObject(
      failsWith("same_person_approval"),
    );
    await decide(requestId, true);
    expect((await requests(id))[0]).toMatchObject({
      status: "approved",
      decided_by: seedStaffUserIds.admin,
      decided_on: "2027-02-03",
      decided_at: expect.any(Date),
    });
    expect((await row(id)).status_version).toBe(4);
    // The fingerprint stays on the request: never in audit details (round 17).
    const requestedEvent = (await events(id)).find(
      (e) => e.event_type === "profiling_exception_requested",
    );
    expect(requestedEvent.details).toEqual({
      profilingExceptionRequestId: requestId,
      evidenceRecordId: evidenceRecord,
    });
    expect((await events(id)).slice(-2)).toMatchObject([
      {
        event_type: "profiling_exception_requested",
        reason_code: "agentur_scheduling_unavailable",
        details: { profilingExceptionRequestId: requestId, evidenceRecordId: evidenceRecord },
      },
      {
        event_type: "profiling_exception_approved",
        actor_staff_user_id: seedStaffUserIds.admin,
        details: { profilingExceptionRequestId: requestId },
      },
    ]);
  });

  it("keeps every request: a new attempt is a new row with changed evidence", async () => {
    const id = await informedParticipation(app);
    const first = await request(id);
    await decide(first, false);
    await expect(decide(first, true)).rejects.toMatchObject(failsWith("not_requested"));
    await expect(revoke(first)).rejects.toMatchObject(failsWith("not_revocable"));
    // The same fingerprint is unchanged evidence, even under another evidence record (Q94).
    await expect(request(id)).rejects.toMatchObject(failsWith("evidence_unchanged"));
    const second = await request(id, { fingerprint: fingerprint("b") });
    await decide(second, true);
    await revoke(second);
    await expect(decide(first, true)).rejects.toMatchObject(failsWith("request_not_current"));
    const third = await request(id, { fingerprint: fingerprint("c") });

    expect((await requests(id)).map((r) => [r.id, r.status, r.evidence_fingerprint])).toEqual([
      [first, "rejected", fingerprint("a")],
      [second, "revoked", fingerprint("b")],
      [third, "requested", fingerprint("c")],
    ]);
    expect((await row(id)).profiling_exception_request_id).toBe(third);
    const trail = (await events(id)).filter((e) => e.event_type.startsWith("profiling_exception"));
    expect(trail.map((e) => [e.event_type, e.details.profilingExceptionRequestId])).toEqual([
      ["profiling_exception_requested", first],
      ["profiling_exception_rejected", first],
      ["profiling_exception_requested", second],
      ["profiling_exception_approved", second],
      ["profiling_exception_revoked", second],
      ["profiling_exception_requested", third],
    ]);
  });

  it.each([
    ["before informed", "imported", "not_informed"],
    ["in a ta_only project", "ta_only", "not_ta_tg"],
    ["after profiling was declined (Q74)", "declined", "profiling_closed"],
    ["while one is open", "open", "exception_open"],
    ["by the system", "system", "actor_not_allowed"],
  ])("refuses a request %s", async (_label, situation, code) => {
    const id =
      situation === "imported"
        ? await call(app, "create_participation", {
            projectId: seedProjectIds.werkNord,
            context: pl,
          })
        : await informedParticipation(app, {
            projectId:
              situation === "ta_only" ? seedProjectIds.verwaltung : seedProjectIds.werkNord,
          });
    if (situation === "declined") {
      await changeStatus(app, id, {
        field: "profiling_status",
        from: "not_started",
        to: "profiling_declined",
      });
    }
    if (situation === "open") await request(id);
    const context = situation === "system" ? nightly : pl;
    await expect(request(id, { context, fingerprint: fingerprint("f") })).rejects.toMatchObject(
      failsWith(code),
    );
  });

  it("refuses a request without evidence or with a malformed fingerprint", async () => {
    const id = await informedParticipation(app);
    const args = {
      id,
      reason: "force_majeure",
      requestedOn: "2027-02-01",
      evidenceRecordId: evidenceRecord,
      context: pl,
    };
    for (const missing of [
      { evidenceFingerprint: null },
      { evidenceRecordId: null, evidenceFingerprint: fingerprint("a") },
    ]) {
      await expect(
        call(app, "request_profiling_exception", { ...args, ...missing }),
      ).rejects.toMatchObject(failsWith("evidence_missing"));
    }
    await expect(
      // Unversioned (round 16's format) is malformed now (round 17).
      call(app, "request_profiling_exception", {
        ...args,
        evidenceFingerprint: `sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "profiling_exception_request_fingerprint",
    });
  });

  it("refuses an unknown request and a foreign participant", async () => {
    await expect(decide(evidenceRecord, true)).rejects.toMatchObject(
      failsWith("request_not_found"),
    );
    const id = await informedParticipation(app);
    const requestId = await request(id);
    const participant = auditContext({ actorType: "participant", participationId: id });
    await expect(decide(requestId, true, participant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });

  it("supersedes the pending request in the change's transaction when profiling closes (round 10)", async () => {
    const id = await informedParticipation(app);
    const requestId = await request(id);
    const requestIdOfChange = "6f1c2b6e-1b7a-4c5e-9d1a-2f3b4c5d6e7f";
    const changeId = await changeStatus(app, id, {
      field: "profiling_status",
      from: "not_started",
      to: "profiling_declined",
      context: auditContext({
        actorType: "user",
        staffUserId: seedStaffUserIds.consultant,
        requestId: requestIdOfChange,
      }),
    });
    expect((await requests(id))[0]).toMatchObject({
      status: "superseded",
      superseded_reason: "profiling_closed",
    });
    const trail = await events(id);
    expect(trail.filter((e) => e.event_type === "status_changed")).toHaveLength(3);
    expect(trail.at(-1)).toMatchObject({
      event_type: "profiling_exception_superseded",
      actor_type: "system",
      system_job: "lifecycle.supersede-stale-exception",
      reason_code: "profiling_closed",
      request_id: requestIdOfChange,
      details: { profilingExceptionRequestId: requestId, statusChangeId: changeId },
    });
    await expect(revoke(requestId)).rejects.toMatchObject(failsWith("not_revocable"));
  });

  it("supersedes it when the participation closes, but leaves an approval alone", async () => {
    const pending = await informedParticipation(app);
    await request(pending);
    await changeStatus(app, pending, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2027-02-10",
    });
    expect((await requests(pending))[0]).toMatchObject({
      superseded_reason: "participation_closed",
    });

    const approved = await informedParticipation(app);
    const approvedId = await request(approved);
    await decide(approvedId, true);
    await changeStatus(app, approved, {
      field: "profiling_status",
      from: "not_started",
      to: "profiling_declined",
    });
    expect((await requests(approved))[0]).toMatchObject({ status: "approved" });
    await expect(revoke(approvedId)).rejects.toMatchObject(failsWith("no_longer_applicable"));
  });

  it("lets profiling move forward and be declined in the TG with an approved exception (Q74)", async () => {
    const id = await signedParticipation();
    const requestId = await request(id);
    await decide(requestId, true);
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "active_in_tg",
      entryKind: "reconciliation",
      effectiveDate: "2027-03-01",
    });
    await expect(revoke(requestId)).rejects.toMatchObject(failsWith("not_informed"));
    await changeStatus(app, id, {
      field: "profiling_status",
      from: "not_started",
      to: "profiling_accepted",
    });
    await changeStatus(app, id, {
      field: "profiling_status",
      from: "profiling_accepted",
      to: "profiling_declined",
    });
    await expect(
      changeStatus(app, id, {
        field: "profiling_status",
        from: "profiling_declined",
        to: "profiling_accepted",
      }),
    ).rejects.toMatchObject(failsWith("track_inactive"));
  });
});

/** Writes as the owner, bypassing the functions, and rolls back. */
async function asOwner(sql: string, params: unknown[]) {
  await owner.query("begin");
  try {
    await owner.query(sql, params);
  } finally {
    await owner.query("rollback");
  }
}

describe("profiling_exception_request in the table itself (defence in depth)", () => {
  it("never changes a request's identity, reason or evidence", async () => {
    const id = await informedParticipation(app);
    const requestId = await request(id);
    for (const change of [
      "reason_code = 'force_majeure'",
      "evidence_record_id = gen_random_uuid()",
      `evidence_fingerprint = '${fingerprint("e")}'`,
      "requested_on = '2027-01-01'",
      "requested_at = now() - interval '1 day'",
      `requested_by = '${seedStaffUserIds.consultant}'`,
    ]) {
      await expect(
        asOwner(`update profiling_exception_request set ${change} where id = $1`, [requestId]),
      ).rejects.toMatchObject(failsWith("request_immutable"));
    }
  });

  // The exact transition matrix (round 17); every other update is request_immutable.
  const decision = `decided_by = '${seedStaffUserIds.admin}', decided_on = '2027-02-03', decided_at = now()`;
  const noDecision = "decided_by = null, decided_on = null, decided_at = null";
  const superseded = "status = 'superseded', superseded_reason = 'profiling_closed'";
  it.each([
    ["requested", `status = 'approved', ${decision}`, "allowed"],
    ["requested", `status = 'rejected', ${decision}`, "allowed"],
    [
      "requested",
      "status = 'approved', decided_by = requested_by, decided_on = '2027-02-03'",
      "request_immutable",
    ],
    ["requested", "status = 'revoked'", "allowed"],
    ["requested", `status = 'revoked', ${decision}`, "request_immutable"],
    ["requested", superseded, "allowed"],
    ["requested", `${superseded}, ${decision}`, "request_immutable"],
    ["requested", "status = 'requested'", "request_immutable"],
    ["approved", "status = 'revoked'", "allowed"],
    ["approved", "status = 'revoked', decided_on = '2027-02-04'", "request_immutable"],
    ["approved", `status = 'revoked', ${noDecision}`, "request_immutable"],
    ["approved", "status = 'rejected'", "request_immutable"],
    ["approved", "decided_at = now() + interval '1 hour'", "request_immutable"],
    ["approved", `${superseded}, ${noDecision}`, "request_immutable"],
    ["rejected", "status = 'approved'", "request_immutable"],
    ["rejected", "status = 'revoked'", "request_immutable"],
    ["revoked", `status = 'requested'`, "request_immutable"],
    ["superseded", "status = 'requested', superseded_reason = null", "request_immutable"],
  ])("from %s: set %s → %s", async (from, change, expected) => {
    const id = await informedParticipation(app);
    const requestId = await request(id);
    if (from === "approved" || from === "revoked") await decide(requestId, true);
    if (from === "rejected") await decide(requestId, false);
    if (from === "revoked") await revoke(requestId);
    if (from === "superseded") {
      await changeStatus(app, id, {
        field: "profiling_status",
        from: "not_started",
        to: "profiling_declined",
      });
    }
    const outcome = await asOwner(
      `update profiling_exception_request set ${change} where id = $1`,
      [requestId],
    ).then(
      () => "allowed",
      (error: { message: string }) => error.message,
    );
    expect(outcome).toBe(expected);
  });

  it("keeps four eyes and one open request per participation", async () => {
    const id = await informedParticipation(app);
    const requestId = await request(id);
    await expect(
      asOwner(
        "update profiling_exception_request set status = 'approved', decided_by = requested_by, decided_on = '2027-02-03', decided_at = now() where id = $1",
        [requestId],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "profiling_exception_request_four_eyes" });
    await expect(
      asOwner(
        `insert into profiling_exception_request (project_id, participation_id, reason_code, status, requested_by, requested_on, evidence_record_id, evidence_fingerprint)
         select project_id, participation_id, reason_code, 'requested', requested_by, requested_on, evidence_record_id, $2 from profiling_exception_request where id = $1`,
        [requestId, fingerprint("b")],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "profiling_exception_request_one_open_idx",
    });
  });

  it("only points a participation at one of its own requests", async () => {
    const [one, two] = [await informedParticipation(app), await informedParticipation(app)];
    const requestOfTwo = await request(two);
    await expect(
      asOwner("update participation set profiling_exception_request_id = $2 where id = $1", [
        one,
        requestOfTwo,
      ]),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "participation_current_exception_request_fk",
    });
  });
});

describe("assign_entry_wave", () => {
  it("assigns and reassigns before the first offer, within the project", async () => {
    const [w2, w3] = [
      await createWave(owner),
      await createWave(owner, seedProjectIds.werkNord, "T2"),
    ];
    const id = await informedParticipation(app);
    await call(app, "assign_entry_wave", { id, waveId: w2, context: pl });
    await call(app, "assign_entry_wave", { id, waveId: w3, context: pl });
    expect(await row(id)).toMatchObject({ entry_wave_id: w3, status_version: 4 });
    expect((await events(id)).at(-1)).toMatchObject({
      event_type: "entry_wave_assigned",
      details: { waveId: w3, previousWaveId: w2 },
    });
    // The current wave again is a no-op: refused, no version bump, no event (round 16).
    const trail = await events(id);
    await expect(
      call(app, "assign_entry_wave", { id, waveId: w3, context: pl }),
    ).rejects.toMatchObject(failsWith("wave_unchanged"));
    expect(await row(id)).toMatchObject({ entry_wave_id: w3, status_version: 4 });
    expect(await events(id)).toEqual(trail);
    await changeStatus(app, id, { field: "dsv_status", from: "not_offered", to: "dsv_offered" });
    await expect(
      call(app, "assign_entry_wave", { id, waveId: w2, context: pl }),
    ).rejects.toMatchObject(failsWith("dsv_already_offered"));
  });

  it("keeps the wave of a participation with individual dates (R33)", async () => {
    const [w2, w3] = [
      await createWave(owner),
      await createWave(owner, seedProjectIds.werkNord, "T2"),
    ];
    const id = await informedParticipation(app);
    await call(app, "assign_entry_wave", { id, waveId: w2, context: pl });
    for (const [tgStart, tgEnd] of [
      [null, "2092-01-31"],
      ["2091-03-02", null],
    ]) {
      await owner.query("update participation set tg_start = $2, tg_end = $3 where id = $1", [
        id,
        tgStart,
        tgEnd,
      ]);
      const before = await row(id);
      const trail = await events(id);
      await expect(
        call(app, "assign_entry_wave", { id, waveId: w3, context: pl }),
      ).rejects.toMatchObject(failsWith("individual_dates_set"));
      // Refused on the locked row: no version bump, no audit event.
      expect(await row(id)).toEqual(before);
      expect(await events(id)).toEqual(trail);
    }
  });

  it.each([
    ["in a ta_only project", seedProjectIds.verwaltung, false, "not_ta_tg"],
    ["of another project", seedProjectIds.lagerSued, false, "wave_of_other_project"],
    ["after withdrawal", seedProjectIds.werkNord, true, "status_not_open"],
  ])("refuses a wave %s", async (_label, projectId, closed, code) => {
    const waveId = await createWave(owner);
    const id = await call(app, "create_participation", { projectId, context: pl });
    if (closed) {
      await changeStatus(app, id, {
        field: "status",
        from: "imported",
        to: "withdrawn",
        endReason: "other",
        effectiveDate: "2027-02-01",
      });
    }
    await expect(call(app, "assign_entry_wave", { id, waveId, context: pl })).rejects.toMatchObject(
      failsWith(code),
    );
  });
});

async function withdrawn(context: string, endReason: string) {
  const id = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
  });
  await changeStatus(app, id, {
    field: "status",
    from: "imported",
    to: "withdrawn",
    context,
    endReason,
    ...(endReason === "never_contacted" && { secondaryReasons: ["no_response"] }),
    effectiveDate: "2027-03-16",
  });
  return id;
}
const correct = (id: string, newReason: string, previousStillApplies?: boolean) =>
  call(app, "correct_end_reason", {
    id,
    newReason,
    context: pl,
    ...(previousStillApplies !== undefined && { previousStillApplies }),
  });

describe("correct_end_reason (Q72, round 10)", () => {
  it("moves a system-derived reason to the secondary list, without reopening", async () => {
    const id = await withdrawn(nightly, "never_contacted");
    await correct(id, "placed_direct");
    expect(await row(id)).toMatchObject({
      status: "withdrawn",
      end_reason: "placed_direct",
      end_reason_source: "user",
      end_reason_secondary: "{never_contacted,no_response}",
    });
    expect((await events(id)).at(-1)).toMatchObject({
      event_type: "end_reason_corrected",
      from_value: "never_contacted",
      to_value: "placed_direct",
      reason_code: "placed_direct",
      details: { previousSource: "system", secondaryReasons: ["never_contacted", "no_response"] },
    });
  });

  it("keeps a previous staff reason only when the PL confirms it still applies", async () => {
    const dropped = await withdrawn(pl, "retirement");
    await correct(dropped, "placed_direct");
    expect(await row(dropped)).toMatchObject({ end_reason_secondary: "{}" });
    const kept = await withdrawn(pl, "retirement");
    await correct(kept, "placed_direct", true);
    expect(await row(kept)).toMatchObject({ end_reason_secondary: "{retirement}" });
  });

  it.each([
    ["the same reason", "other", "reason_unchanged"],
    ["a reason of the other phase", "placed_permanent", "reason_wrong_phase"],
  ])("refuses %s", async (_label, reason, code) => {
    const id = await withdrawn(pl, "other");
    await expect(correct(id, reason)).rejects.toMatchObject(failsWith(code));
  });

  it("refuses the special-category reason (Q66) and participations without an end reason", async () => {
    const id = await signedParticipation();
    await expect(correct(id, "other")).rejects.toMatchObject(failsWith("no_end_reason"));
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "active_in_tg",
      entryKind: "reconciliation",
      effectiveDate: "2027-03-01",
    });
    await changeStatus(app, id, {
      field: "status",
      from: "active_in_tg",
      to: "exited",
      endReason: "other",
      effectiveDate: "2027-09-30",
    });
    await expect(correct(id, "long_term_illness_reduced_earning_capacity")).rejects.toMatchObject(
      failsWith("reason_not_storable"),
    );
  });
});

describe("record_audit_event", () => {
  it("records a later-slice event at project or participation level", async () => {
    const id = await informedParticipation(app);
    await call(app, "record_audit_event", {
      projectId: seedProjectIds.werkNord,
      participationId: id,
      eventType: "sensitive_read",
      context: pl,
      details: { key: "healthRestrictions" },
    });
    await call(app, "record_audit_event", {
      projectId: seedProjectIds.werkNord,
      participationId: null,
      eventType: "warning_confirmed",
      context: nightly,
      reasonCode: "monthly_report",
    });
    const { rows } = await owner.query(
      "select event_type, participation_id, details from audit_event where event_type in ('sensitive_read', 'warning_confirmed') order by seq",
    );
    expect(rows).toEqual([
      {
        event_type: "sensitive_read",
        participation_id: id,
        details: { key: "healthRestrictions" },
      },
      { event_type: "warning_confirmed", participation_id: null, details: {} },
    ]);
  });

  it("refuses a participation of another project, an unknown project and a foreign participant", async () => {
    const id = await informedParticipation(app);
    const record = (projectId: string, context = pl) =>
      call(app, "record_audit_event", {
        projectId,
        participationId: id,
        eventType: "sensitive_read",
        context,
        details: { key: "x" },
      });
    await expect(record(seedProjectIds.lagerSued)).rejects.toMatchObject(
      failsWith("participation_not_found"),
    );
    await expect(record("00000000-0000-4000-9000-0000000000ff")).rejects.toMatchObject(
      failsWith("project_not_found"),
    );
    const other = auditContext({
      actorType: "participant",
      participationId: seedProjectIds.werkNord,
    });
    await expect(record(seedProjectIds.werkNord, other)).rejects.toMatchObject(
      failsWith("invalid_actor"),
    );
    const assisted = auditContext({
      actorType: "user",
      staffUserId: seedStaffUserIds.projectLead,
      onBehalfOf: seedProjectIds.werkNord,
    });
    await expect(record(seedProjectIds.werkNord, assisted)).rejects.toMatchObject(
      failsWith("invalid_actor"),
    );
    const own = auditContext({ actorType: "participant", participationId: id });
    await record(seedProjectIds.werkNord, own);
  });
});

describe("effective dates in the function (round 18)", () => {
  it("requires one for DSV expiry and refuses one where it means nothing", async () => {
    const waveId = await createWave(owner);
    const id = await informedParticipation(app, { entryWaveId: waveId });
    await expect(
      changeStatus(app, id, {
        field: "status",
        from: "informed",
        to: "unreachable",
        effectiveDate: "2027-02-01",
      }),
    ).rejects.toMatchObject(failsWith("invalid_transition"));
    await expect(
      changeStatus(app, id, {
        field: "dsv_status",
        from: "not_offered",
        to: "dsv_offered",
        effectiveDate: "2027-02-01",
      }),
    ).rejects.toMatchObject(failsWith("effective_date_not_allowed"));
    await changeStatus(app, id, { field: "dsv_status", from: "not_offered", to: "dsv_offered" });
    await expect(
      changeStatus(app, id, {
        field: "dsv_status",
        from: "dsv_offered",
        to: "dsv_expired",
        context: nightly,
      }),
    ).rejects.toMatchObject(failsWith("effective_date_required"));
  });

  it("never records an exit before the TG entry", async () => {
    const id = await signedParticipation();
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "active_in_tg",
      entryKind: "reconciliation",
      effectiveDate: "2027-03-01",
    });
    await expect(
      changeStatus(app, id, {
        field: "status",
        from: "active_in_tg",
        to: "exited",
        endReason: "other",
        effectiveDate: "2027-02-28",
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "participation_exit_after_entry" });
  });
});
