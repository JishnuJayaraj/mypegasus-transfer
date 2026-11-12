import { randomUUID } from "node:crypto";
import { ManualClock, MemoryFileStorage } from "@transfer/adapters";
import {
  createDb,
  erasureParticipationTables,
  retentionPeriods,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import type { RetentionPeriods } from "@transfer/domain";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedParticipations } from "../participations/seed";
import { runRetention } from "./retention";
import { jobNames, startJobs } from "./jobs";

// Synthetic non-signer (data-protection.md, retention and deletion): once due, erase the
// participation and its references, including subject and subject-record IDs in the audit trail.
const urls = testDatabaseUrls();
const retentionDb = createDb(urls.retention);
const retention = retentionDb.$client;
const appDb = createDb(urls.app);
const owner = createDb(urls.owner).$client;
afterAll(() => Promise.all([retention.end(), appDb.$client.end(), owner.end()]));
let subject: string;
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  await seedParticipations(appDb);
  const result = await owner.query(
    `select id from participation where status = 'withdrawn' and tg_entry_date is null order by id limit 1`,
  );
  subject = result.rows[0].id;
  await owner.query(
    `update participation set funded110 = 'known_no' where project_id = (select project_id from participation where id = $1)`,
    [subject],
  );
  await owner.query(
    `update project set kug_final_settlement_date = '2020-01-01', measure110_settlement_date = '2020-01-01' where id = (select project_id from participation where id = $1)`,
    [subject],
  );
});

async function erase(id: string, dryRun = false) {
  const client = await retention.connect();
  try {
    await client.query("begin");
    const opened = await client.query(`select retention_open_run('2026-01-01', $1) as id`, [
      dryRun,
    ]);
    const result = await client.query(`select retention_erase_participation($1, $2) as erased`, [
      opened.rows[0].id,
      id,
    ]);
    await client.query(`select retention_close_run($1, '{}'::jsonb)`, [opened.rows[0].id]);
    await client.query("commit");
    return result.rows[0].erased.completed as boolean;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const periods: RetentionPeriods = {
  ...retentionPeriods,
  participation_record: {
    days: { non_signer_withdrawn: 90 },
    yearEnds: { closed_without_tg: 3, exited: 3 },
  },
  personnel_file: {
    days: { non_signer_withdrawn: 90 },
    yearEnds: { closed_without_tg: 3, exited: 3 },
  },
  health_record: {
    days: { non_signer_withdrawn: 90 },
    months: { closed_without_tg: 3, exited: 3 },
  },
  evidence_set: { yearEnds: { settled: 4 } },
};
async function runJob(today: string, storage: MemoryFileStorage | undefined, dryRun = false) {
  return runRetention(
    {
      db: retentionDb,
      storage,
      clock: new ManualClock(new Date(`${today}T11:00:00Z`)),
      logger: pino({ level: "silent" }),
    },
    {
      periods,
      prerequisites: {
        periods_confirmed: true,
        hold_administration_confirmed: true,
        evidence_only_access_built: true,
        maintenance_rules_complete: true,
      },
      dryRun,
      today,
    },
  );
}

describe("stage-two erasure", () => {
  it("reports a due erasure in a dry run without removing rows or objects", async () => {
    const file = randomUUID();
    await owner.query(`update participation set withdrawn_on = '2026-03-01' where id = $1`, [
      subject,
    ]);
    await owner.query(
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at)
      select $2, project_id, id, 'participant_upload', 10, 'personnel_file', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now() from participation where id = $1`,
      [subject, file, seedStaffUserIds.backOffice],
    );
    const storage = new MemoryFileStorage(() => new Date("2026-01-01T00:00:00Z"));
    await storage.put(`documents/${file}`, new Uint8Array([1]));
    const result = await runJob("2026-05-31", storage, true);
    expect(result.dryRun).toBe(true);
    expect(result.classes.participation_record.due).toBeGreaterThan(0);
    expect(result.classes.participation_record.deleted).toBe(0);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    expect(storage.keys()).toContain(`documents/${file}`);
  });
  it("waits for required project settlements and the end of the evidence period", async () => {
    const exited = (
      await owner.query(
        `select id from participation where project_id = (select project_id from participation where id = $1) and status = 'exited' order by id limit 1`,
        [subject],
      )
    ).rows[0].id;
    await owner.query(
      `update participation set funded110 = 'known_yes', offer_deadline = '2019-12-01', tg_start = '2020-01-01', tg_entry_date = '2020-01-01', tg_end = '2020-12-31', exit_date = '2020-06-30' where id = $1`,
      [exited],
    );
    await owner.query(
      `update project set kug_final_settlement_date = '2021-01-01', measure110_settlement_date = null where id = (select project_id from participation where id = $1)`,
      [exited],
    );
    const storage = new MemoryFileStorage(() => new Date("2020-01-01T00:00:00Z"));
    await runJob("2026-01-01", storage);
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [exited])).rows,
    ).toHaveLength(1);
    await owner.query(
      `update project set measure110_settlement_date = '2021-06-01' where id = (select project_id from participation where id = $1)`,
      [exited],
    );
    await runJob("2025-12-31", storage);
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [exited])).rows,
    ).toHaveLength(1);
    await runJob("2026-01-01", storage);
    expect((await owner.query(`select 1 from participation where id = $1`, [exited])).rows).toEqual(
      [],
    );
  });

  it("blocks stage two for missing required settlements and unknown project funding", async () => {
    const exited = (
      await owner.query(
        `select id from participation where project_id = (select project_id from participation where id = $1) and status = 'exited' order by id limit 1`,
        [subject],
      )
    ).rows[0].id;
    await owner.query(`update participation set funded110 = 'known_yes' where id = $1`, [exited]);
    await owner.query(`update participation set withdrawn_on = '2026-03-01' where id = $1`, [
      subject,
    ]);
    await owner.query(
      `update project set kug_final_settlement_date = null, measure110_settlement_date = null where id = (select project_id from participation where id = $1)`,
      [subject],
    );
    const storage = new MemoryFileStorage(() => new Date("2026-01-01T00:00:00Z"));
    await runJob("2026-05-31", storage);
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    await owner.query(
      `update project set kug_final_settlement_date = '2020-01-01' where id = (select project_id from participation where id = $1)`,
      [subject],
    );
    await runJob("2026-06-01", storage);
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    await owner.query(
      `update project set measure110_settlement_date = '2020-01-01' where id = (select project_id from participation where id = $1)`,
      [subject],
    );
    await owner.query(`update participation set funded110 = 'unknown' where id = $1`, [exited]);
    await runJob("2026-06-02", storage);
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    await owner.query(`update participation set funded110 = 'known_yes' where id = $1`, [exited]);
    await runJob("2026-06-03", storage);
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
    ).toEqual([]);
  });

  it("leaves the participation and document rows recoverable if object deletion fails", async () => {
    const file = randomUUID();
    await owner.query(`update participation set withdrawn_on = '2026-03-01' where id = $1`, [
      subject,
    ]);
    await owner.query(
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at)
      select $2, project_id, id, 'participant_upload', 10, 'personnel_file', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now() from participation where id = $1`,
      [subject, file, seedStaffUserIds.backOffice],
    );
    const storage = new MemoryFileStorage(() => new Date("2026-01-01T00:00:00Z"));
    await storage.put(`documents/${file}`, new Uint8Array([1]));
    const original = storage.delete.bind(storage);
    storage.delete = async () => {
      throw new Error("synthetic storage failure");
    };
    await expect(runJob("2026-05-31", storage)).rejects.toThrow("synthetic storage failure");
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    expect(
      (await owner.query(`select 1 from document where id = $1 and deleted_at is null`, [file]))
        .rows,
    ).toHaveLength(1);
    storage.delete = original;
    await runJob("2026-05-31", storage);
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
    ).toEqual([]);
  });

  it("rolls stage-two erasure back when an evidence object cannot be deleted", async () => {
    const exited = (
      await owner.query(
        `select id from participation where project_id = (select project_id from participation where id = $1) and status = 'exited' order by id limit 1`,
        [subject],
      )
    ).rows[0].id;
    await owner.query(
      `update participation set funded110 = 'known_yes', offer_deadline = '2019-12-01', tg_start = '2020-01-01', tg_entry_date = '2020-01-01', tg_end = '2020-12-31', exit_date = '2020-06-30' where id = $1`,
      [exited],
    );
    const file = randomUUID();
    await owner.query(
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at, scan_origin)
      select $2, project_id, id, 'tl407_signed_scan', 10, 'evidence_set', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now(), 'external_paper' from participation where id = $1`,
      [exited, file, seedStaffUserIds.backOffice],
    );
    const storage = new MemoryFileStorage(() => new Date("2020-01-01T00:00:00Z"));
    await storage.put(`documents/${file}`, new Uint8Array([1]));
    const original = storage.delete.bind(storage);
    storage.delete = async (key) => {
      if (key === `documents/${file}`) throw new Error("synthetic evidence failure");
      return original(key);
    };
    await expect(runJob("2026-01-01", storage)).rejects.toThrow("synthetic evidence failure");
    expect(
      (await owner.query(`select 1 from participation where id = $1`, [exited])).rows,
    ).toHaveLength(1);
    expect(
      (await owner.query(`select 1 from document where id = $1 and deleted_at is null`, [file]))
        .rows,
    ).toHaveLength(1);
    storage.delete = original;
    await runJob("2026-01-01", storage);
    expect((await owner.query(`select 1 from participation where id = $1`, [exited])).rows).toEqual(
      [],
    );
    expect(storage.keys()).not.toContain(`documents/${file}`);
  });

  it("retains a held evidence document but erases its unheld neighbour", async () => {
    const exited = (
      await owner.query(
        `select id from participation where project_id = (select project_id from participation where id = $1) and status = 'exited' order by id limit 1`,
        [subject],
      )
    ).rows[0].id;
    await owner.query(
      `update participation set funded110 = 'known_yes', offer_deadline = '2019-12-01', tg_start = '2020-01-01', tg_entry_date = '2020-01-01', tg_end = '2020-12-31', exit_date = '2020-06-30' where id = $1`,
      [exited],
    );
    const held = randomUUID(),
      neighbour = randomUUID();
    const storage = new MemoryFileStorage(() => new Date("2020-01-01T00:00:00Z"));
    for (const id of [held, neighbour]) {
      await owner.query(
        `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at, scan_origin)
        select $2, project_id, id, 'tl407_signed_scan', 10, 'evidence_set', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now(), 'external_paper' from participation where id = $1`,
        [exited, id, seedStaffUserIds.backOffice],
      );
      await storage.put(`documents/${id}`, new Uint8Array([1]));
    }
    await owner.query(
      `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{}', '{}', ARRAY[$2::uuid], 'litigation', 'Synthetic reference', $3 from participation where id = $1`,
      [exited, held, seedStaffUserIds.projectLead],
    );
    await runJob("2026-01-01", storage);
    expect(
      (await owner.query(`select id from participation where id = $1`, [exited])).rows,
    ).toHaveLength(1);
    expect(storage.keys()).toContain(`documents/${held}`);
    expect(storage.keys()).not.toContain(`documents/${neighbour}`);
    await owner.query(
      `update legal_hold set released_at = now(), released_by = $2, release_source = 'Synthetic instruction' where participation_id = $1`,
      [exited, seedStaffUserIds.regionalOperationsManager],
    );
    await runJob("2026-01-02", storage);
    expect(
      (await owner.query(`select id from participation where id = $1`, [exited])).rows,
    ).toEqual([]);
    expect(storage.keys()).not.toContain(`documents/${held}`);
  });

  it("keeps the held document and erases its unheld neighbour, then finishes after release", async () => {
    await owner.query(`update participation set withdrawn_on = '2026-03-01' where id = $1`, [
      subject,
    ]);
    const held = randomUUID(),
      neighbour = randomUUID();
    const storage = new MemoryFileStorage(() => new Date("2026-01-01T00:00:00Z"));
    for (const id of [held, neighbour]) {
      await owner.query(
        `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at)
        select $2, project_id, id, 'participant_upload', 10, 'personnel_file', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now() from participation where id = $1`,
        [subject, id, seedStaffUserIds.backOffice],
      );
      await storage.put(`documents/${id}`, new Uint8Array([1]));
    }
    await owner.query(
      `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{}', '{}', ARRAY[$2::uuid], 'litigation', 'Synthetic reference', $3 from participation where id = $1`,
      [subject, held, seedStaffUserIds.projectLead],
    );
    await runJob("2026-05-31", storage);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    const anchor = (await owner.query(`select * from participation where id = $1`, [subject]))
      .rows[0];
    expect(anchor).toMatchObject({
      erasure_trigger: "non_signer_withdrawn",
      erasure_trigger_on: expect.any(Date),
      erasure_entered_tg: false,
      withdrawn_on: null,
      end_reason: null,
      end_reason_source: null,
      entry_wave_id: null,
      profiling_exception_request_id: null,
      funded110_source: null,
      evidence_set_since: null,
    });
    expect(anchor.erasure_pending_at).not.toBeNull();
    expect(storage.keys()).toContain(`documents/${held}`);
    expect(storage.keys()).not.toContain(`documents/${neighbour}`);
    await owner.query(
      `update legal_hold set released_at = now(), released_by = $2, release_source = 'Synthetic instruction' where participation_id = $1`,
      [subject, seedStaffUserIds.regionalOperationsManager],
    );
    await runJob("2026-06-01", storage);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toEqual([]);
    expect(storage.keys()).not.toContain(`documents/${held}`);
  });
  it("the job erases a due unfunded non-signer and purges its object", async () => {
    const file = randomUUID();
    await owner.query(
      `update participation set funded110 = 'known_no' where project_id = (select project_id from participation where id = $1)`,
      [subject],
    );
    await owner.query(`update participation set withdrawn_on = '2026-03-01' where id = $1`, [
      subject,
    ]);
    await owner.query(
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at)
      select $2, project_id, id, 'participant_upload', 10, 'personnel_file', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now() from participation where id = $1`,
      [subject, file, seedStaffUserIds.backOffice],
    );
    const storage = new MemoryFileStorage(() => new Date("2026-01-01T00:00:00Z"));
    await storage.put(`documents/${file}`, new Uint8Array([1]));
    await runJob("2026-05-31", storage);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toEqual([]);
    expect(storage.keys()).not.toContain(`documents/${file}`);
    expect(
      (
        await owner.query(
          `select 1 from audit_event where participation_id = $1 or actor_participation_id = $1 or on_behalf_of_participation_id = $1 limit 1`,
          [subject],
        )
      ).rows,
    ).toEqual([]);
    const session = "d".repeat(64);
    await owner.query(
      `insert into staff_session (token_hash, staff_user_id, created_at, expires_at)
      values ($1, $2, now(), now() + interval '8 hours')`,
      [session, seedStaffUserIds.projectLead],
    );
    await expect(
      appDb.$client.query(`select * from audit_history($1, $2::uuid, null, 20, 'synthetic')`, [
        session,
        subject,
      ]),
    ).rejects.toThrow("participation_not_found");
  });
  it("removes a non-signer and pseudonymises subject and record identifiers in its audit", async () => {
    const channel = randomUUID();
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_participation_id, request_id, job_id, details)
      select project_id, id, 'participant_login', 'participant', id,
        $1::text, $2::text, jsonb_build_object('method', 'one_time_code', 'channelId', $2::text) from participation where id = $1::uuid`,
      [subject, channel],
    );
    await owner.query(
      `insert into staff_audit_event (event_type, actor_staff_user_id, subject_staff_user_id, request_id, details)
      values ('staff_login', $1, $1, $2::text, jsonb_build_object('recordId', $3::text))`,
      [seedStaffUserIds.projectLead, subject, channel],
    );
    expect(await erase(subject)).toBe(true);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toEqual([]);
    const leaked = await owner.query(
      `select seq from audit_event where participation_id = $1::uuid
      or actor_participation_id = $1::uuid or on_behalf_of_participation_id = $1::uuid
      or row_to_json(audit_event)::text like '%' || $1 || '%' or row_to_json(audit_event)::text like '%' || $2 || '%'`,
      [subject, channel],
    );
    expect(leaked.rows).toEqual([]);
    const beforeRepeat = Number(
      (await owner.query(`select count(*) as n from audit_event`)).rows[0].n,
    );
    expect(await erase(subject)).toBe(false);
    expect(Number((await owner.query(`select count(*) as n from audit_event`)).rows[0].n)).toBe(
      beforeRepeat,
    );
    const applied = await owner.query(
      `select details from audit_event where event_type = 'retention_applied' and details->>'retentionClass' = 'participation_record' order by seq desc limit 1`,
    );
    expect(applied.rows[0].details.deleted).toBeGreaterThan(0);
    expect(applied.rows[0].details.kept).toBe(0);
    expect(
      (
        await owner.query(
          `select 1 from staff_audit_event where row_to_json(staff_audit_event)::text like '%' || $1 || '%' or row_to_json(staff_audit_event)::text like '%' || $2 || '%'`,
          [subject, channel],
        )
      ).rows,
    ).toEqual([]);
  });

  it("uses one pseudonym per record while retaining unrelated reference IDs", async () => {
    const booking = randomUUID(),
      appointment = randomUUID();
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_participation_id, details)
      select project_id, id, 'appointment_booked', 'participant', id,
        jsonb_build_object('bookingId', $2::text, 'appointmentId', $3::text, 'appointmentKind', 'info_event', 'startsAt', '2026-01-01T10:00:00Z', 'origin', 'participant') from participation where id = $1::uuid`,
      [subject, booking, appointment],
    );
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_participation_id, details)
      select project_id, id, 'appointment_booking_cancelled', 'participant', id,
        jsonb_build_object('bookingId', $2::text, 'appointmentId', $3::text, 'appointmentKind', 'info_event', 'startsAt', '2026-01-01T10:00:00Z') from participation where id = $1::uuid`,
      [subject, booking, appointment],
    );
    expect(await erase(subject)).toBe(true);
    const events = await owner.query(
      `select details from audit_event where details->>'appointmentId' = $1 order by seq`,
      [appointment],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0].details.bookingId).not.toBe(booking);
    expect(events.rows[1].details.bookingId).toBe(events.rows[0].details.bookingId);
    expect(events.rows[0].details.appointmentId).toBe(appointment);
  });

  it("purges queued jobs containing a subject record ID without deleting a neighbour", async () => {
    const record = randomUUID(),
      unrelated = randomUUID();
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_participation_id, details)
      select project_id, id, 'participant_login', 'participant', id,
        jsonb_build_object('method', 'one_time_code', 'channelId', $2::text) from participation where id = $1::uuid`,
      [subject, record],
    );
    const jobs = await startJobs({
      connectionString: urls.app,
      lifecycleTime: "04:15",
      logger: pino({ level: "silent" }),
    });
    try {
      await jobs.boss.deleteAllJobs(jobNames.activationNotice);
      const queued = await jobs.boss.send(
        jobNames.activationNotice,
        { channelId: record },
        { singletonKey: record },
      );
      const neighbour = await jobs.boss.send(
        jobNames.activationNotice,
        { channelId: unrelated },
        { singletonKey: unrelated },
      );
      expect(await erase(subject)).toBe(true);
      expect((await owner.query(`select id from pgboss.job where id = $1`, [queued])).rows).toEqual(
        [],
      );
      expect(
        (await owner.query(`select id from pgboss.job where id = $1`, [neighbour])).rows,
      ).toHaveLength(1);
    } finally {
      await jobs.stop();
    }
  });

  it("revokes an export link containing a subject document without revoking an unrelated link", async () => {
    const file = randomUUID(),
      unrelated = randomUUID();
    await owner.query(
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at, scan_origin)
      select $2, project_id, id, 'kug200b_signed_scan', 10, 'evidence_set', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now(), 'external_paper' from participation where id = $1`,
      [subject, file, seedStaffUserIds.backOffice],
    );
    for (const [hash, id] of [
      ["a", file],
      ["b", unrelated],
    ]) {
      await owner.query(
        `insert into export_link (token_hash, project_id, kind, document_ids, staff_user_id, session_hash, expires_at)
        select repeat($2,64), project_id, 'kug200b_print', ARRAY[$3::uuid], $4, repeat('c',64), now() + interval '1 hour' from participation where id = $1`,
        [subject, hash, id, seedStaffUserIds.projectLead],
      );
    }
    const batch = randomUUID();
    await owner.query(
      `insert into kug200b_batch (id, project_id, agentur_key, channel, artifact, member_count, created_by)
      select $2, project_id, 'synthetic', 'scan_email', 'accepted_alternative', 1, $3 from participation where id = $1`,
      [subject, batch, seedStaffUserIds.projectLead],
    );
    await owner.query(
      `insert into kug200b_batch_member (batch_id, project_id, participation_id, document_id, form_version, placement_agentur_key)
      select $2, project_id, id, $3, '01-2026', 'synthetic' from participation where id = $1`,
      [subject, batch, file],
    );
    await owner.query(
      `insert into export_link (token_hash, project_id, kind, document_ids, batch_id, staff_user_id, session_hash, expires_at)
      select repeat('d',64), project_id, 'kug200b_batch_scans', '{}', $2, $3, repeat('c',64), now() + interval '1 hour' from participation where id = $1`,
      [subject, batch, seedStaffUserIds.projectLead],
    );
    expect(await erase(subject)).toBe(true);
    expect(
      (await owner.query(`select token_hash from export_link where token_hash = repeat('a',64)`))
        .rows,
    ).toEqual([]);
    expect(
      (await owner.query(`select token_hash from export_link where token_hash = repeat('b',64)`))
        .rows,
    ).toHaveLength(1);
    expect(
      (await owner.query(`select token_hash from export_link where token_hash = repeat('d',64)`))
        .rows,
    ).toEqual([]);
    expect(
      (await owner.query(`select id from kug200b_batch where id = $1`, [batch])).rows,
    ).toHaveLength(1);
  });

  it("waits while a subject's job is active, then erases after it settles", async () => {
    const record = randomUUID();
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_participation_id, details)
      select project_id, id, 'participant_login', 'participant', id,
        jsonb_build_object('method', 'one_time_code', 'channelId', $2::text) from participation where id = $1::uuid`,
      [subject, record],
    );
    const jobs = await startJobs({
      connectionString: urls.app,
      lifecycleTime: "04:15",
      logger: pino({ level: "silent" }),
    });
    try {
      await jobs.boss.deleteAllJobs(jobNames.activationNotice);
      const queued = await jobs.boss.send(
        jobNames.activationNotice,
        { channelId: record },
        { singletonKey: record },
      );
      const active = await jobs.boss.fetch(jobNames.activationNotice);
      expect(active[0]?.id).toBe(queued);
      expect(await erase(subject)).toBe(false);
      expect(
        (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
      ).toHaveLength(1);
      await jobs.boss.complete(jobNames.activationNotice, queued!);
      expect(await erase(subject)).toBe(true);
    } finally {
      await jobs.stop();
    }
  });

  it("prevents a queued subject job from being claimed while erasure is uncommitted", async () => {
    const record = randomUUID();
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_participation_id, details)
      select project_id, id, 'participant_login', 'participant', id,
        jsonb_build_object('method', 'one_time_code', 'channelId', $2::text) from participation where id = $1::uuid`,
      [subject, record],
    );
    const jobs = await startJobs({
      connectionString: urls.app,
      lifecycleTime: "04:15",
      logger: pino({ level: "silent" }),
    });
    const client = await retention.connect();
    try {
      await jobs.boss.deleteAllJobs(jobNames.activationNotice);
      await jobs.boss.send(
        jobNames.activationNotice,
        { channelId: record },
        { singletonKey: record },
      );
      await client.query("begin");
      const run = (await client.query(`select retention_open_run('2026-01-01', false) as id`))
        .rows[0].id;
      const result = await client.query(`select retention_erase_participation($1, $2) as result`, [
        run,
        subject,
      ]);
      expect(result.rows[0].result.completed).toBe(true);
      expect(await jobs.boss.fetch(jobNames.activationNotice)).toEqual([]);
      await client.query(`select retention_close_run($1, '{}'::jsonb)`, [run]);
      await client.query("commit");
      expect(await jobs.boss.fetch(jobNames.activationNotice)).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
      await jobs.stop();
    }
  });

  it("does not orphan a dependent job when removing a subject job", async () => {
    const record = randomUUID();
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_participation_id, details)
      select project_id, id, 'participant_login', 'participant', id,
        jsonb_build_object('method', 'one_time_code', 'channelId', $2::text) from participation where id = $1::uuid`,
      [subject, record],
    );
    const jobs = await startJobs({
      connectionString: urls.app,
      lifecycleTime: "04:15",
      logger: pino({ level: "silent" }),
    });
    try {
      await jobs.boss.deleteAllJobs(jobNames.activationNotice);
      const parent = await jobs.boss.send(
        jobNames.activationNotice,
        { channelId: record },
        { singletonKey: record },
      );
      const child = await jobs.boss.send(jobNames.activationNotice, { channelId: randomUUID() });
      await owner.query(
        `insert into pgboss.job_dependency (child_name, child_id, parent_name, parent_id) values ($1, $2, $1, $3)`,
        [jobNames.activationNotice, child, parent],
      );
      expect(await erase(subject)).toBe(false);
      expect(
        (await owner.query(`select 1 from participation where id = $1`, [subject])).rows,
      ).toHaveLength(1);
      await owner.query(`delete from pgboss.job_dependency where parent_id = $1`, [parent]);
      expect(await erase(subject)).toBe(true);
      expect(
        (await owner.query(`select id from pgboss.job where id = $1`, [child])).rows,
      ).toHaveLength(1);
    } finally {
      await jobs.stop();
    }
  });

  it("removes references across every participant table and leaves another participation intact", async () => {
    const result = await owner.query(
      `select id from participation where status = 'exited' order by id limit 1`,
    );
    const exited = result.rows[0].id;
    await owner.query(`update participation set funded110 = 'known_yes' where id = $1`, [exited]);
    expect(await erase(exited)).toBe(true);
    for (const table of erasureParticipationTables.filter((name) => name !== "audit_event")) {
      const rows = await owner.query(
        `select 1 from "${table}" where participation_id = $1 limit 1`,
        [exited],
      );
      expect({ table, rows: rows.rows }).toEqual({ table, rows: [] });
    }
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
  });

  it("counts in a dry run without deleting or pseudonymising", async () => {
    expect(await erase(subject, true)).toBe(true);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    expect(
      (
        await owner.query(`select 1 from audit_event where participation_id = $1 limit 1`, [
          subject,
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it("keeps only a held record and its required references until release", async () => {
    await owner.query(
      `insert into participant_details (participation_id, project_id, phone)
      select id, project_id, '+49 40 0000000' from participation where id = $1
      on conflict (participation_id) do update set phone = excluded.phone`,
      [subject],
    );
    await owner.query(
      `insert into participant_identity (participation_id, project_id, personnel_number, first_name, last_name)
      select id, project_id, 'SYN-001', 'Synthetic', 'Person' from participation where id = $1
      on conflict (participation_id) do nothing`,
      [subject],
    );
    await owner.query(
      `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{}', '{participant_details}', '{}', 'litigation', 'Synthetic reference', $2 from participation where id = $1`,
      [subject, seedStaffUserIds.projectLead],
    );
    expect(await erase(subject)).toBe(false);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toHaveLength(1);
    expect(
      (
        await owner.query(`select 1 from participant_details where participation_id = $1`, [
          subject,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await owner.query(`select 1 from participant_identity where participation_id = $1`, [
          subject,
        ])
      ).rows,
    ).toEqual([]);
    await owner.query(
      `update legal_hold set released_at = now(), released_by = $2, release_source = 'Synthetic instruction' where participation_id = $1`,
      [subject, seedStaffUserIds.regionalOperationsManager],
    );
    expect(await erase(subject)).toBe(true);
    expect(
      (await owner.query(`select id from participation where id = $1`, [subject])).rows,
    ).toEqual([]);
  });

  it("keeps a held signature's document dependency while deleting unrelated data", async () => {
    const exited = (
      await owner.query(
        `select id from participation where project_id = (select project_id from participation where id = $1) and status = 'exited' order by id limit 1`,
        [subject],
      )
    ).rows[0].id;
    await owner.query(`update participation set funded110 = 'known_yes' where id = $1`, [exited]);
    const signature = (
      await owner.query(
        `select id, document_id from dsv_scan_signature where participation_id = $1 limit 1`,
        [exited],
      )
    ).rows[0];
    await owner.query(
      `insert into participant_identity (participation_id, project_id, personnel_number, first_name, last_name)
      select id, project_id, 'SYN-002', 'Synthetic', 'Person' from participation where id = $1 on conflict (participation_id) do nothing`,
      [exited],
    );
    await owner.query(
      `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{}', '{dsv_scan_signature}', '{}', 'litigation', 'Synthetic reference', $2 from participation where id = $1`,
      [exited, seedStaffUserIds.projectLead],
    );
    expect(await erase(exited)).toBe(false);
    expect(
      (await owner.query(`select 1 from dsv_scan_signature where id = $1`, [signature.id])).rows,
    ).toHaveLength(1);
    expect(
      (await owner.query(`select 1 from document where id = $1`, [signature.document_id])).rows,
    ).toHaveLength(1);
    expect(
      (
        await owner.query(`select 1 from participant_identity where participation_id = $1`, [
          exited,
        ])
      ).rows,
    ).toEqual([]);
    await owner.query(
      `update legal_hold set released_at = now(), released_by = $2, release_source = 'Synthetic instruction' where participation_id = $1`,
      [exited, seedStaffUserIds.regionalOperationsManager],
    );
    expect(await erase(exited)).toBe(true);
  });

  it("keeps the audit event referenced by a retained DSV offer", async () => {
    const exited = (
      await owner.query(
        `select id from participation where project_id = (select project_id from participation where id = $1) and status = 'exited' order by id limit 1`,
        [subject],
      )
    ).rows[0].id;
    await owner.query(`update participation set funded110 = 'known_yes' where id = $1`, [exited]);
    const offer = (
      await owner.query(
        `select id, status_event_id from dsv_offer where participation_id = $1 and status_event_id is not null limit 1`,
        [exited],
      )
    ).rows[0];
    const audit = randomUUID();
    await owner.query(
      `insert into audit_event (id, project_id, participation_id, event_type, actor_type, actor_staff_user_id, reason_code, details)
      select $2, project_id, id, 'profiling_exception_superseded', 'user', $3, 'participation_closed',
        jsonb_build_object('profilingExceptionRequestId', $4::text, 'statusChangeId', $5::text) from participation where id = $1::uuid`,
      [exited, audit, seedStaffUserIds.projectLead, randomUUID(), offer.status_event_id],
    );
    await owner.query(
      `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{}', '{dsv_offer}', '{}', 'litigation', 'Synthetic reference', $2 from participation where id = $1`,
      [exited, seedStaffUserIds.projectLead],
    );
    expect(await erase(exited)).toBe(false);
    expect(
      (await owner.query(`select id from audit_event where id = $1`, [offer.status_event_id])).rows,
    ).toHaveLength(1);
    expect(
      (await owner.query(`select status_event_id from dsv_offer where id = $1`, [offer.id])).rows,
    ).toEqual([{ status_event_id: offer.status_event_id }]);
    expect(
      (
        await owner.query(
          `select details->>'statusChangeId' as id from audit_event where id = $1`,
          [audit],
        )
      ).rows,
    ).toEqual([{ id: offer.status_event_id }]);
  });

  it("removes an unheld profiling request and its evidence from the minimal anchor", async () => {
    const document = randomUUID(),
      evidence = randomUUID(),
      request = randomUUID();
    await owner.query(
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by, added_by_staff_user_id, added_on_behalf, added_at)
      select $2, project_id, id, 'profiling_exception_evidence', 10, 'participation_record', 'application/pdf', 100, repeat('a',64), 'synthetic.pdf', repeat('b',16), decode(repeat('00',60),'hex'), 'user', $3, false, now() from participation where id = $1`,
      [subject, document, seedStaffUserIds.projectLead],
    );
    await owner.query(
      `insert into profiling_exception_evidence_record (id, project_id, participation_id, kind, document_ids, fingerprint, created_by, created_on)
      select $2, project_id, id, 'documents', ARRAY[$3::uuid], 'sha256:v1:' || repeat('a',64), $4, '2026-01-01' from participation where id = $1`,
      [subject, evidence, document, seedStaffUserIds.projectLead],
    );
    await owner.query(
      `insert into profiling_exception_request (id, project_id, participation_id, reason_code, status, requested_by, requested_on, evidence_record_id, evidence_fingerprint)
      select $2, project_id, id, 'participant_prevented_documented', 'requested', $4, '2026-01-01', $3, 'sha256:v1:' || repeat('a',64) from participation where id = $1`,
      [subject, request, evidence, seedStaffUserIds.projectLead],
    );
    await owner.query(
      `update participation set profiling_exception_request_id = $2 where id = $1`,
      [subject, request],
    );
    await owner.query(
      `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{}', '{participant_details}', '{}', 'litigation', 'Synthetic reference', $2 from participation where id = $1`,
      [subject, seedStaffUserIds.projectLead],
    );
    expect(await erase(subject)).toBe(false);
    expect(
      (
        await owner.query(`select id from profiling_exception_evidence_record where id = $1`, [
          evidence,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (await owner.query(`select id from document where id = $1`, [document])).rows,
    ).toHaveLength(0);
  });

  it.each([false, true])(
    "retains the channel referenced by a held consent (channel held: %s)",
    async (channelHeld) => {
      const consent = randomUUID(),
        channel = randomUUID();
      await owner.query(
        `insert into consent_record (id, project_id, participation_id, purpose, source, channel_id, text_version, language, actor_type)
      select $2, project_id, id, 'portal_contact', 'portal', $3, 'consent:v1', 'de', 'participant' from participation where id = $1`,
        [subject, consent, channel],
      );
      await owner.query(
        `insert into participant_channel (id, project_id, participation_id, kind, address, verified_by, consent_id)
      select $2, project_id, id, 'email', 'synthetic@example.org', 'one_time_code', $3 from participation where id = $1`,
        [subject, channel, consent],
      );
      await owner.query(
        `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{}', $3::text[], '{}', 'litigation', 'Synthetic reference', $2 from participation where id = $1`,
        [
          subject,
          seedStaffUserIds.projectLead,
          channelHeld ? ["consent_record", "participant_channel"] : ["consent_record"],
        ],
      );
      expect(await erase(subject)).toBe(false);
      expect(
        (await owner.query(`select id from consent_record where id = $1`, [consent])).rows,
      ).toHaveLength(1);
      expect(
        (await owner.query(`select id from participant_channel where id = $1`, [channel])).rows,
      ).toHaveLength(1);
      expect(
        (
          await owner.query(
            `select address, removed_reason from participant_channel where id = $1`,
            [channel],
          )
        ).rows,
      ).toEqual([
        channelHeld
          ? { address: "synthetic@example.org", removed_reason: null }
          : { address: null, removed_reason: "retention_erasure" },
      ]);
    },
  );

  it("does not leave a usable activation secret when a held notice references it", async () => {
    const code = randomUUID();
    await owner.query(
      `insert into activation_code (id, project_id, participation_id, code_hash, channel, notice_language, printed_at, issued_by, issued_at, expires_at)
      select $2, project_id, id, repeat('a', 64), 'letter', 'de', now(), $3, now(), now() + interval '30 days' from participation where id = $1`,
      [subject, code, seedStaffUserIds.backOffice],
    );
    await owner.query(
      `insert into privacy_notice_delivery (id, project_id, participation_id, notice_version, language, method, activation_code_id, provided_by)
      select $2, project_id, id, 'notice:v1', 'de', 'letter', $3, $4 from participation where id = $1`,
      [subject, randomUUID(), code, seedStaffUserIds.backOffice],
    );
    await owner.query(
      `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids, reason, basis, placed_by)
      select project_id, id, '{personnel_file}', '{}', '{}', 'litigation', 'Synthetic reference', $2 from participation where id = $1`,
      [subject, seedStaffUserIds.projectLead],
    );
    expect(await erase(subject)).toBe(false);
    const result = await owner.query(
      `select code_hash, revoked_at from activation_code where id = $1`,
      [code],
    );
    expect(result.rows[0].code_hash).not.toBe("a".repeat(64));
    expect(result.rows[0].revoked_at).not.toBeNull();
  });
});
