import { randomUUID } from "node:crypto";
import { ManualClock, MemoryFileStorage } from "@transfer/adapters";
import {
  createDb,
  retentionPeriods,
  retentionPrerequisites,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import type { RetentionPeriods } from "@transfer/domain";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { objectKey } from "../documents/files";
import { seedParticipations } from "../participations/seed";
import { runRetention, type RetentionOptions } from "./retention";

// Stage one per class (data-protection.md, retention per class, legal holds, the evidence-only
// phase, the retained DSV facts). Expected results from the rules, not the code: each class of a
// participation goes at its own trigger and period and only that class; a non-signer's personnel
// file on day 91, not 90; an unknown funding keeps the participation record; a hold keeps exactly
// the rows it names; the DSV facts survive the scans; the evidence-only phase only where it
// applies, then writes refused. The periods are synthetic and the activation a test one.
const urls = testDatabaseUrls();
const db = createDb(urls.retention);
const appDb = createDb(urls.app);
const app = appDb.$client;
const owner = createDb(urls.owner).$client;
afterAll(() => Promise.all([db.$client.end(), app.end(), owner.end()]));
const logger = pino({ level: "silent" });

const synthetic: RetentionPeriods = {
  ...retentionPeriods,
  personnel_file: {
    days: { non_signer_withdrawn: 90, exited: 30 },
    yearEnds: { closed_without_tg: 3 },
  },
  health_record: {
    days: { non_signer_withdrawn: 90 },
    months: { closed_without_tg: 3, exited: 3 },
  },
  participation_record: {
    days: { non_signer_withdrawn: 90 },
    yearEnds: { closed_without_tg: 3, exited: 3 },
  },
};
/** The personnel file kept to the end of the 3rd year after exit: only the health record is due. */
const healthOnly: RetentionPeriods = {
  ...synthetic,
  personnel_file: {
    days: { non_signer_withdrawn: 90 },
    yearEnds: { closed_without_tg: 3, exited: 3 },
  },
};
const testActivation = {
  periods_confirmed: true,
  hold_administration_confirmed: true,
  evidence_only_access_built: true,
  maintenance_rules_complete: true,
};

const storage = new MemoryFileStorage(() => new Date("2026-01-01T00:00:00Z"));
const run = (today: string, options: Partial<RetentionOptions> = {}) =>
  runRetention(
    { db, storage, clock: new ManualClock(new Date(`${today}T11:00:00Z`)), logger },
    { periods: synthetic, prerequisites: testActivation, dryRun: false, today, ...options },
  );
const count = async (table: string, participation: string, extra = "") =>
  Number(
    (
      await owner.query(`select count(*) as n from ${table} where participation_id = $1 ${extra}`, [
        participation,
      ])
    ).rows[0].n,
  );

let nonSigner: string;
let exited: string;
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  await seedParticipations(appDb);
  for (const key of storage.keys()) await storage.delete(key);
  const { rows } = await owner.query(
    `select p.id, p.status::text as status from participation p
     where p.status::text = 'exited' or p.status::text = 'withdrawn' and p.tg_entry_date is null
       and not exists (select from dsv_contract c where c.participation_id = p.id
         and c.fully_executed_on is not null)
     order by p.id`,
  );
  nonSigner = rows.find((r) => r.status === "withdrawn")!.id;
  exited = rows.find((r) => r.status === "exited")!.id;
  // Synthetic trigger days the run can reach (database time decides the run's day).
  await owner.query(`update participation set withdrawn_on = '2026-03-01' where id = $1`, [
    nonSigner,
  ]);
  await owner.query(`update participation set funded110 = 'known_no' where id = $1`, [nonSigner]);
  await owner.query(
    `update participation set offer_deadline = least(offer_deadline, '2026-02-15'), tg_start = '2026-03-01', tg_entry_date = '2026-03-01', tg_end = '2027-02-28', exit_date = '2026-06-30' where id = $1`,
    [exited],
  );
  for (const id of [nonSigner, exited]) {
    await health(id);
    await owner.query(
      `insert into participant_details (participation_id, project_id, phone)
       select id, project_id, '+49 40 0000000' from participation where id = $1 on conflict do nothing`,
      [id],
    );
    await owner.query(
      `insert into participant_identity (participation_id, project_id, personnel_number, last_name,
         first_name) select id, project_id, 'P-' || right(id::text, 8), 'Beispiel', 'Erika'
       from participation where id = $1 on conflict do nothing`,
      [id],
    );
  }
});

async function health(participation: string) {
  await owner.query(
    `insert into participant_health_data (participation_id, project_id, key_id)
     select id, project_id, '0123456789abcdef' from participation where id = $1`,
    [participation],
  );
}

/** A personnel-file upload of the participation, its object in the store. */
async function upload(participation: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into document (id, project_id, participation_id, type, catalog_version, retention_class,
       media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by,
       added_by_staff_user_id, added_on_behalf, added_at)
     select $1, project_id, id, 'participant_upload', 10, 'personnel_file', 'application/pdf', 100,
       repeat('a', 64), 'zeugnis.pdf', repeat('b', 16), decode(repeat('00', 60), 'hex'), 'user', $3,
       false, now() from participation where id = $2`,
    [id, participation, seedStaffUserIds.backOffice],
  );
  await storage.put(objectKey(id), new Uint8Array([1]));
  return id;
}

async function hold(
  participation: string,
  scope: { classes?: string[]; recordKinds?: string[]; documentIds?: string[] },
) {
  await owner.query(
    `insert into legal_hold (project_id, participation_id, classes, record_kinds, document_ids,
       reason, basis, placed_by)
     select project_id, id, $2, $3, $4, 'litigation', 'Az. 1 Ca 1/26', $5 from participation
     where id = $1`,
    [
      participation,
      scope.classes ?? [],
      scope.recordKinds ?? [],
      scope.documentIds ?? [],
      seedStaffUserIds.projectLead,
    ],
  );
}

describe("each class at its own trigger and period", () => {
  it.each(["known_no", "unknown", "known_yes"] as const)(
    "applies both non-signer classes according to funding %s",
    async (funding) => {
      await owner.query(`update participation set funded110 = $2 where id = $1`, [
        nonSigner,
        funding,
      ]);
      await run("2026-05-30");
      expect(await count("participant_details", nonSigner)).toBe(1);
      expect(await count("participant_health_data", nonSigner)).toBe(1);
      const summary = await run("2026-05-31");
      const remaining = funding === "known_no" ? 0 : 1;
      expect(await count("participant_details", nonSigner)).toBe(remaining);
      expect(await count("participant_health_data", nonSigner)).toBe(remaining);
      expect(summary.classes.personnel_file.blocked > 0).toBe(funding === "unknown");
      expect(summary.classes.health_record.blocked > 0).toBe(funding === "unknown");
    },
  );
  it("deletes the health record while the personnel file stays readable and writable", async () => {
    const before = await run("2026-09-30", { periods: healthOnly });
    expect(before.classes.health_record.outcome).toBe("applied");
    expect(await count("participant_health_data", exited)).toBe(1);

    const summary = await run("2026-10-01", { periods: healthOnly });
    expect(summary.classes.health_record).toMatchObject({ outcome: "applied", deleted: 1 });
    expect(await count("participant_health_data", exited)).toBe(0);
    expect(await count("participant_details", exited)).toBe(1);
    expect(await count("dsv_scan_signature", exited)).toBeGreaterThan(0);
    // Writable as before: no evidence-only phase while the personnel file is left.
    await owner.query(
      `update participant_details set phone = '+49 40 1111111' where participation_id = $1`,
      [exited],
    );
    expect(
      (await owner.query(`select evidence_set_since from participation where id = $1`, [exited]))
        .rows[0].evidence_set_since,
    ).toBeNull();
  });

  it("deletes a non-signer's personnel file on day 91, not 90", async () => {
    const document = await upload(nonSigner);
    const day90 = await run("2026-05-30");
    expect(day90.classes.personnel_file.due).toBe(0);
    expect(await count("participant_details", nonSigner)).toBe(1);

    const day91 = await run("2026-05-31");
    expect(day91.classes.personnel_file).toMatchObject({ outcome: "applied", deleted: 1 });
    expect(await count("participant_details", nonSigner)).toBe(0);
    expect(await count("participant_health_data", nonSigner)).toBe(0);
    // The document is a tombstone: deleted by `system`, its file name erased, its object gone.
    const { rows } = await owner.query(
      `select deleted_by, file_name, purged_at is not null as purged from document where id = $1`,
      [document],
    );
    expect(rows[0]).toEqual({ deleted_by: "system", file_name: null, purged: true });
    expect(storage.keys()).not.toContain(objectKey(document));
    // Audited by the class and counts, as the system.
    const events = await owner.query(
      `select actor_type, details from audit_event where participation_id = $1
       and event_type = 'retention_applied' order by occurred_at`,
      [nonSigner],
    );
    expect(events.rows.map((e) => e.details.retentionClass).toSorted()).toEqual([
      "health_record",
      "personnel_file",
    ]);
    expect(events.rows[0].actor_type).toBe("system");
  });

  it("keeps the participation record of a non-signer while the funding is unknown", async () => {
    await owner.query(`update participation set funded110 = 'unknown' where id = $1`, [nonSigner]);
    const unknown = await run("2026-06-01");
    expect(unknown.classes.participation_record).toMatchObject({
      outcome: "not_applied",
      blocked: 1,
      due: 0,
    });
    expect(await count("participant_identity", nonSigner)).toBe(1);
    expect(
      (await owner.query(`select evidence_set_since from participation where id = $1`, [nonSigner]))
        .rows[0].evidence_set_since,
    ).toBeNull();

    // Known `known_no`: due for the erasure (stage two), still kept by this stage.
    await owner.query(
      `update participation set funded110 = 'known_no', funded110_source = 'Bescheid',
         funded110_set_by = $2, funded110_set_at = now() where id = $1`,
      [nonSigner, seedStaffUserIds.backOffice],
    );
    const known = await run("2026-06-02");
    expect(known.classes.participation_record).toMatchObject({ blocked: 0, due: 1, deleted: 0 });
    expect(await count("participant_identity", nonSigner)).toBe(1);
  });
});

describe("legal holds (Q218)", () => {
  it("retains the booking, channel and consent referenced by a held reminder", async () => {
    const consent = randomUUID(),
      channel = randomUUID(),
      appointment = randomUUID(),
      booking = randomUUID();
    await owner.query(
      `insert into consent_record (id, project_id, participation_id, purpose, source, channel_id, text_version, language, actor_type)
      select $2, project_id, id, 'portal_contact', 'portal', $3, 'consent:v1', 'de', 'participant' from participation where id = $1`,
      [nonSigner, consent, channel],
    );
    await owner.query(
      `insert into participant_channel (id, project_id, participation_id, kind, address, verified_by, consent_id)
      select $2, project_id, id, 'email', 'synthetic@example.org', 'one_time_code', $3 from participation where id = $1`,
      [nonSigner, channel, consent],
    );
    await owner.query(
      `insert into appointment (id, project_id, kind, starts_at, ends_at, booking_closes_at, capacity, venue, created_by)
      select $2, project_id, 'info_event', '2026-03-10 09:00Z', '2026-03-10 10:00Z', '2026-03-09 09:00Z', 10, 'Raum', $3 from participation where id = $1`,
      [nonSigner, appointment, seedStaffUserIds.projectLead],
    );
    await owner.query(
      `insert into appointment_booking (id, project_id, participation_id, appointment_id, origin, booked_by)
      select $2, project_id, id, $3, 'staff', $4 from participation where id = $1`,
      [nonSigner, booking, appointment, seedStaffUserIds.projectLead],
    );
    await owner.query(
      `insert into participant_reminder (id, project_id, participation_id, batch_id, kind, message_version, language, channel_id, channel_kind, consent_id, requested_on, appointment_id, booking_id)
      select $2, project_id, id, $3, 'appointment_changed', 'reminder:v1', 'de', $4, 'email', $5, '2026-03-01', $6, $7 from participation where id = $1`,
      [nonSigner, randomUUID(), randomUUID(), channel, consent, appointment, booking],
    );
    await hold(nonSigner, { recordKinds: ["participant_reminder"] });
    await run("2026-05-31");
    expect(await count("appointment_booking", nonSigner)).toBe(1);
    expect(await count("participant_channel", nonSigner)).toBe(1);
    expect(await count("consent_record", nonSigner)).toBe(1);
    expect(await count("participant_details", nonSigner)).toBe(0);
  });
  it("keeps signatures of a held scan while deleting the other personnel data", async () => {
    const { rows } = await owner.query(
      `select document_id from dsv_scan_signature where participation_id = $1 limit 1`,
      [exited],
    );
    const document = rows[0].document_id;
    await hold(exited, { documentIds: [document] });
    await run("2026-10-01");
    expect(
      await count("dsv_scan_signature", exited, `and document_id = '${document}'`),
    ).toBeGreaterThan(0);
    expect(await count("participant_details", exited)).toBe(0);
  });
  it("retains a consent referenced by a withdrawal while deleting its unreferenced neighbour", async () => {
    const kept = randomUUID();
    const neighbour = randomUUID();
    for (const id of [kept, neighbour]) {
      await owner.query(
        `insert into consent_record (id, project_id, participation_id, purpose, source, text_version, language, actor_type)
        select $2, project_id, id, 'kug200b_profile_access', 'portal', 'consent:v1', 'de', 'participant' from participation where id = $1`,
        [nonSigner, id],
      );
    }
    await owner.query(
      `insert into kug200b_withdrawal (id, project_id, participation_id, consent_id, received_on, recorded_by)
      select $2, project_id, id, $3, '2026-03-01', $4 from participation where id = $1`,
      [nonSigner, randomUUID(), kept, seedStaffUserIds.backOffice],
    );
    await run("2026-05-31");
    expect(
      (await owner.query(`select id from consent_record where participation_id = $1`, [nonSigner]))
        .rows,
    ).toEqual([{ id: kept }]);
    expect(await count("participant_details", nonSigner)).toBe(0);
  });
  it("keeps exactly the held rows while their neighbours and the unheld classes go", async () => {
    const held = await upload(nonSigner);
    const neighbour = await upload(nonSigner);
    await hold(nonSigner, { recordKinds: ["participant_details"], documentIds: [held] });

    const summary = await run("2026-05-31");
    expect(summary.classes.personnel_file).toMatchObject({ deleted: 1, held: 1 });
    expect(await count("participant_details", nonSigner)).toBe(1);
    expect(await count("document", nonSigner, `and id = '${held}' and deleted_at is null`)).toBe(1);
    expect(storage.keys()).toContain(objectKey(held));
    expect(
      await count("document", nonSigner, `and id = '${neighbour}' and deleted_at is null`),
    ).toBe(0);
    expect(storage.keys()).not.toContain(objectKey(neighbour));
    // The unheld class goes.
    expect(await count("participant_health_data", nonSigner)).toBe(0);
  });

  it("keeps a held class whole and deletes it after the release", async () => {
    await hold(nonSigner, { classes: ["health_record"] });
    const summary = await run("2026-05-31");
    expect(summary.classes.health_record).toMatchObject({ held: 1, deleted: 0 });
    expect(await count("participant_health_data", nonSigner)).toBe(1);
    expect(await count("participant_details", nonSigner)).toBe(0);

    await owner.query(
      `update legal_hold set released_at = now(), released_by = $1, release_source = 'Weisung DSB'`,
      [seedStaffUserIds.regionalOperationsManager],
    );
    await run("2026-06-01");
    expect(await count("participant_health_data", nonSigner)).toBe(0);
  });
});

describe("the retained DSV facts and the evidence-only phase", () => {
  it("allows evidence-only with evidence held, but not with personnel data held", async () => {
    await hold(exited, { recordKinds: ["dsv_offer"] });
    await hold(exited, { recordKinds: ["participant_details"] });
    await run("2026-10-01");
    expect(
      (await owner.query(`select evidence_set_since from participation where id = $1`, [exited]))
        .rows[0].evidence_set_since,
    ).toBeNull();
    await owner.query(
      `update legal_hold set released_at = now(), released_by = $2, release_source = 'Weisung' where participation_id = $1 and 'participant_details' = any(record_kinds)`,
      [exited, seedStaffUserIds.regionalOperationsManager],
    );
    await run("2026-10-02");
    expect(
      (await owner.query(`select evidence_set_since from participation where id = $1`, [exited]))
        .rows[0].evidence_set_since,
    ).not.toBeNull();
  });
  it("keeps the contract's facts when the scans go, then starts the evidence-only phase", async () => {
    await owner.query(
      `update dsv_contract set original_location = 'paper_personnel_file' where participation_id = $1`,
      [exited],
    );
    const facts = (
      await owner.query(
        `select participant_signed_on, customer_signed_on, tg_signed_on, fully_executed_on,
           received_on, received_by_role, fully_executed_accepted_on from dsv_contract
         where participation_id = $1`,
        [exited],
      )
    ).rows[0];

    const summary = await run("2026-10-01");
    expect(summary.classes.personnel_file.deleted).toBe(2); // the non-signer's too
    expect(await count("dsv_scan_signature", exited)).toBe(0);
    expect(
      await count("document", exited, "and type = 'dsv_signed_scan' and deleted_at is null"),
    ).toBe(0);
    const after = (
      await owner.query(
        `select participant_signed_on, customer_signed_on, tg_signed_on, fully_executed_on,
           received_on, received_by_role, fully_executed_accepted_on, original_location
         from dsv_contract where participation_id = $1`,
        [exited],
      )
    ).rows[0];
    expect(after).toEqual({ ...facts, original_location: null });
    expect(await count("dsv_offer", exited)).toBe(1);

    // It entered the TG: an evidence set, and nothing outside it is left.
    expect(summary.evidenceOnly).toBe(1);
    const { rows } = await owner.query(
      `select evidence_set_since from participation where id = $1`,
      [exited],
    );
    expect(rows[0].evidence_set_since).not.toBeNull();
    // From then a write is refused by the trigger, whoever writes outside a run.
    await expect(
      owner.query(`update participant_identity set first_name = 'X' where participation_id = $1`, [
        exited,
      ]),
    ).rejects.toThrow("evidence_set_phase");
    await expect(
      app.query(
        `select set_funding_status(row('user', $2, null, null, null, 'req', null)::audit_context,
           $1, 'known_yes', 'Bescheid', 'unknown', null)`,
        [exited, seedStaffUserIds.backOffice],
      ),
    ).rejects.toThrow("evidence_set_phase");
    // Placing a hold on its records stays possible.
    await hold(exited, { recordKinds: ["dsv_contract"] });
  });

  it("doesn't start it without an evidence set or while a class is left", async () => {
    // The non-signer: funding unknown decides nothing.
    await run("2026-05-31");
    const nonSignerRow = await owner.query(
      `select evidence_set_since from participation where id = $1`,
      [nonSigner],
    );
    expect(nonSignerRow.rows[0].evidence_set_since).toBeNull();
    // The exited participation with its personnel file still kept.
    const summary = await run("2026-10-01", { periods: healthOnly });
    expect(summary.evidenceOnly).toBe(0);
  });
});

describe("with the catalog or activation off", () => {
  it("deletes nothing with the catalog's periods and reports every class", async () => {
    const summary = await run("2026-06-01", { periods: retentionPeriods });
    expect(summary.classes.personnel_file).toMatchObject({ outcome: "period_unset", deleted: 0 });
    expect(summary.classes.health_record).toMatchObject({ outcome: "period_unset", deleted: 0 });
    expect(summary.classes.participation_record.outcome).toBe("period_unset");
    expect(await count("participant_details", nonSigner)).toBe(1);
    expect(await count("participant_health_data", nonSigner)).toBe(1);
  });

  it("counts what is due and deletes nothing with the catalog's activation", async () => {
    const document = await upload(nonSigner);
    const summary = await run("2026-06-01", { prerequisites: retentionPrerequisites });
    expect(summary.dryRun).toBe(true);
    expect(summary.classes.personnel_file).toMatchObject({
      outcome: "counted",
      due: 1,
      deleted: 0,
    });
    expect(summary.classes.health_record).toMatchObject({ outcome: "counted", due: 1, deleted: 0 });
    expect(summary.evidenceOnly).toBe(0);
    expect(await count("participant_details", nonSigner)).toBe(1);
    expect(await count("participant_health_data", nonSigner)).toBe(1);
    expect(storage.keys()).toContain(objectKey(document));
    expect(await count("audit_event", nonSigner, "and event_type = 'retention_applied'")).toBe(0);
  });
});

describe("the functions as the retention role only", () => {
  it("refuses the app role, and the retention role outside a run", async () => {
    await expect(
      app.query(`select retention_delete_class(gen_random_uuid(), $1, 'health_record')`, [
        nonSigner,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.$client.query(`select retention_delete_class(gen_random_uuid(), $1, 'health_record')`, [
        nonSigner,
      ]),
    ).rejects.toThrow("run_not_open");
    await expect(
      db.$client.query(`select place_legal_hold(null, $1, '{}', '{}', '{}', 'x', 'x', '{}')`, [
        nonSigner,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.$client.query(`delete from participant_health_data where project_id = $1`, [
        seedProjectIds.werkNord,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});
