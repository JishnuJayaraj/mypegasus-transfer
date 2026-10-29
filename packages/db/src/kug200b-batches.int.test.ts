import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STAFF_SESSION_HOURS } from "@transfer/domain";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  activateAsOwner,
  auditContext,
  call,
  changeStatus,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// Kug 200b batches (process-and-lifecycle.md, Kug 200b batches; data-protection.md, exports; D25,
// D33, Q203) as transfer_app calls the functions: building, discarding and submitting a batch
// under the project's exclusive lock, the rechecks with their rows, the members' submissions and
// ASU registrations, the Agentur's confirmation and the batch's export link. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const other = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, projectLead, admin } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asAdmin = auditContext({ actorType: "user", staffUserId: admin });
const { werkNord, verwaltung } = seedProjectIds;
const nord = "beispielstadt-nord";
const three = ["declarations_ticked", "mandatory_completed", "signature_present"];

beforeAll(() => Promise.all([app.connect(), other.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), other.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const today = async () => (await one("select berlin_today()::text as d")).d as string;
const daysFrom = async (n: number) =>
  (await one(`select (berlin_today() + $1::int)::text as d`, [n])).d as string;

/**
 * An informed participation of `projectId`, assigned to the consultant, placed with `agentur`
 * (written as the owner: a fixture, set_placement_agentur has its own tests) and on `route`.
 */
async function participation({
  projectId = werkNord as string,
  agentur = nord,
  route = "kug_200b" as string | null,
} = {}) {
  const id = await informedParticipation(app, { projectId });
  await call(app, "assign_participations", {
    projectId,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  await owner.query(
    "update participation set placement_agentur_key = $2, placement_agentur_set_at = now() where id = $1",
    [id, agentur],
  );
  if (route) {
    await call(app, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: route,
      version: 0,
    });
  }
  return id;
}

/** An accepted external-paper Kug 200b 09/2021 scan of the participation; its id. */
async function acceptedScan(id: string) {
  const documentId = await call(app, "add_document", {
    context: asConsultant,
    participationId: id,
    id: randomUUID(),
    type: "kug200b_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    scanOrigin: "external_paper",
    generationDocumentId: null,
  });
  await call(app, "review_document", {
    context: asConsultant,
    documentId,
    decision: "accepted",
    reason: null,
    signedOn: await today(),
    countersignedOn: null,
    confirmations: three,
    formVersion: "09-2021",
    declarations: null,
  });
  return documentId;
}

type Create = {
  context?: string;
  projectId?: string;
  agenturKey?: string;
  channel?: string | null;
  artifact?: string;
  outdated?: string[];
};

function create(documentIds: string[], args: Create = {}, client = app) {
  return call(client, "create_kug200b_batch", {
    context: args.context ?? pl,
    projectId: args.projectId ?? werkNord,
    batchId: randomUUID(),
    agenturKey: args.agenturKey ?? nord,
    channel: args.channel === undefined ? "scan_email" : args.channel,
    artifact: args.artifact ?? "kug200a",
    documentIds,
    outdatedVersions: args.outdated ?? [],
  });
}

type Submit = { context?: string; submittedOn?: string; channel?: string; artifact?: string };

async function submit(batchId: string, args: Submit = {}) {
  return call<{ submissions: number; registrations: number }>(app, "submit_kug200b_batch", {
    context: args.context ?? pl,
    batchId,
    submittedOn: args.submittedOn ?? (await today()),
    channel: args.channel ?? "scan_email",
    artifact: args.artifact ?? "kug200a",
    outdatedVersions: [],
  });
}

/** The refusal's code and its rows (`DETAIL`), as the API reads them. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const { message, detail } = error as { message: string; detail?: string };
    return { message, rows: detail ? JSON.parse(detail) : undefined };
  }
  throw new Error("expected a refusal");
}

const projectEvents = (projectId: string, type: string) =>
  all(
    `select participation_id, details from audit_event
     where project_id = $1 and event_type::text = $2 order by seq`,
    [projectId, type],
  );

describe("create_kug200b_batch (D25)", () => {
  it("builds a batch of the PL's scans, each member with its route as read now", async () => {
    const a = await participation();
    const b = await participation({ route: "online_self" });
    const scans = [await acceptedScan(a), await acceptedScan(b)];
    const batchId = await create(scans);
    expect(
      await one(
        "select status::text, member_count, channel::text, artifact::text from kug200b_batch",
      ),
    ).toEqual({ status: "open", member_count: 2, channel: "scan_email", artifact: "kug200a" });
    expect(
      await all(
        `select participation_id, asu_channel::text, placement_agentur_key, active
         from kug200b_batch_member order by participation_id`,
      ),
    ).toEqual(
      [
        { participation_id: a, asu_channel: "kug_200b", placement_agentur_key: nord, active: true },
        {
          participation_id: b,
          asu_channel: "online_self",
          placement_agentur_key: nord,
          active: true,
        },
      ].toSorted((x, y) => x.participation_id.localeCompare(y.participation_id)),
    );
    expect(await projectEvents(werkNord, "kug200b_batch_created")).toEqual([
      {
        participation_id: null,
        details: {
          batchId,
          agenturKey: nord,
          channel: "scan_email",
          artifact: "kug200a",
          count: 2,
        },
      },
    ]);
  });

  it("checks visibility before permission before state", async () => {
    const id = await participation();
    const scan = await acceptedScan(id);
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: scan,
      reason: "suspected_wrong_person",
    });
    // A non-member learns nothing, whatever the scans' state.
    await expect(create([scan], { context: asAdmin })).rejects.toMatchObject(
      failsWith("project_not_found"),
    );
    await expect(create([scan], { context: asConsultant })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(create([scan], { projectId: verwaltung })).rejects.toMatchObject(
      failsWith("asu_not_applicable"),
    );
    await expect(create([scan], { channel: null })).rejects.toMatchObject(
      failsWith("batch_settings_missing"),
    );
    // Another project's scan is not found, never told apart by its state.
    await activateAsOwner(owner, [seedProjectIds.lagerSued]);
    const otherProject = await participation({ projectId: seedProjectIds.lagerSued });
    await expect(create([await acceptedScan(otherProject)])).rejects.toMatchObject(
      failsWith("document_not_found"),
    );
    expect(await refusal(create([scan]))).toEqual({
      message: "batch_stale",
      rows: [{ participationId: id, documentId: scan, reason: "scan_unusable" }],
    });
  });

  it("refuses all or nothing with the rows of every scan that can't join", async () => {
    const ok = await participation();
    const elsewhere = await participation({ agentur: "beispielstadt-sued" });
    const closed = await participation();
    const scans = [
      await acceptedScan(ok),
      await acceptedScan(elsewhere),
      await acceptedScan(closed),
    ];
    await changeStatus(app, closed, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await today(),
    });
    const { message, rows } = await refusal(create(scans));
    expect(message).toBe("batch_stale");
    expect(rows).toEqual(
      expect.arrayContaining([
        { participationId: elsewhere, documentId: scans[1], reason: "placement_agentur_changed" },
        { participationId: closed, documentId: scans[2], reason: "participation_closed" },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(await one("select count(*)::int as n from kug200b_batch")).toEqual({ n: 0 });
    // An outdated version only where the Agentur rejects it (the API passes the expired ones).
    expect((await refusal(create([scans[0]!], { outdated: ["09-2021"] }))).rows).toEqual([
      { participationId: ok, documentId: scans[0], reason: "form_version_outdated" },
    ]);
  });

  it("gives one batch when two race for one scan (D33)", async () => {
    const id = await participation();
    const scan = await acceptedScan(id);
    await app.query("begin");
    const first = await create([scan]);
    // The second waits on the exclusive project lock the first holds.
    const second = refusal(create([scan], {}, other));
    await expect(
      Promise.race([second, new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]),
    ).resolves.toBe("waiting");
    await app.query("commit");
    expect(await second).toEqual({
      message: "batch_stale",
      rows: [{ participationId: id, documentId: scan, reason: "in_open_batch" }],
    });
    expect(await all("select id from kug200b_batch")).toEqual([{ id: first }]);
  });

  it("frees the members of a discarded batch; a submitted participation stays out", async () => {
    const id = await participation();
    const scan = await acceptedScan(id);
    const batchId = await create([scan]);
    await call(app, "discard_kug200b_batch", { context: pl, batchId });
    await expect(
      call(app, "discard_kug200b_batch", { context: pl, batchId }),
    ).rejects.toMatchObject(failsWith("batch_not_open"));
    await expect(submit(batchId)).rejects.toMatchObject(failsWith("batch_not_open"));
    expect(await projectEvents(werkNord, "kug200b_batch_discarded")).toEqual([
      { participation_id: null, details: { batchId, count: 1 } },
    ]);
    const next = await create([scan]);
    await submit(next);
    expect((await refusal(create([scan]))).rows).toEqual([
      { participationId: id, documentId: scan, reason: "already_submitted" },
    ]);
  });

  it("needs an explicitly chosen route (Q203)", async () => {
    const id = await participation({ route: null });
    const scan = await acceptedScan(id);
    expect((await refusal(create([scan]))).rows).toEqual([
      { participationId: id, documentId: scan, reason: "asu_route_unset" },
    ]);
    await call(app, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: "kug_200b",
      version: 0,
    });
    expect(await create([scan])).toEqual(expect.any(String));
  });

  it("never turns a submission on another route into kug_200b afterwards (Q203)", async () => {
    const id = await participation({ route: "online_self" });
    await submit(await create([await acceptedScan(id)]));
    await expect(
      call(app, "set_asu_route", {
        context: pl,
        participationId: id,
        channel: "kug_200b",
        version: 1,
      }),
    ).rejects.toMatchObject(failsWith("asu_kug200b_submitted"));
    // Another direct route stays open: the person registers on the route they are on.
    expect(
      await call(app, "set_asu_route", {
        context: pl,
        participationId: id,
        channel: "in_person",
        version: 1,
      }),
    ).toBe(2);
  });
});

describe("submit_kug200b_batch (D19, D25)", () => {
  it("records each member's submission and, on kug_200b, its registration on the sent date", async () => {
    const onBatch = await participation();
    const online = await participation({ route: "online_self" });
    const batchId = await create([await acceptedScan(onBatch), await acceptedScan(online)]);
    const sentOn = await today();
    expect(await submit(batchId, { submittedOn: sentOn })).toEqual({
      submissions: 2,
      registrations: 1,
    });
    expect(
      await one("select status::text, submitted_on::text, submitted_by from kug200b_batch"),
    ).toEqual({ status: "submitted", submitted_on: sentOn, submitted_by: projectLead });
    expect(
      await all(
        `select participation_id, form_code::text, form_version, agentur_key, channel::text,
           submitted_on::text from agentur_submission order by participation_id`,
      ),
    ).toHaveLength(2);
    const registration = await one(
      `select r.participation_id, r.channel::text, r.registered_on::text, r.proof_kind::text,
         r.proof_linked_at = r.recorded_at as complete, s.batch_id
       from asu_registration r join agentur_submission s on s.id = r.agentur_submission_id`,
    );
    expect(registration).toEqual({
      participation_id: onBatch,
      channel: "kug_200b",
      registered_on: sentOn,
      proof_kind: "kug200b_submission",
      complete: true,
      batch_id: batchId,
    });
    expect(await projectEvents(werkNord, "kug200b_batch_submitted")).toEqual([
      {
        participation_id: null,
        details: { batchId, submittedOn: sentOn, count: 2, registrations: 1 },
      },
    ]);
    const memberEvents = await all(
      `select event_type::text as type, details->>'channel' as channel from audit_event
       where participation_id = $1 and event_type::text in
         ('agentur_submission_recorded', 'asu_registration_recorded') order by seq`,
      [onBatch],
    );
    expect(memberEvents).toEqual([
      { type: "agentur_submission_recorded", channel: "scan_email" },
      { type: "asu_registration_recorded", channel: "kug_200b" },
    ]);
  });

  it("takes a sent date from the batch's day to today", async () => {
    const batchId = await create([await acceptedScan(await participation())]);
    await expect(submit(batchId, { submittedOn: await daysFrom(1) })).rejects.toMatchObject(
      failsWith("submitted_on_in_future"),
    );
    await expect(submit(batchId, { submittedOn: await daysFrom(-1) })).rejects.toMatchObject(
      failsWith("submitted_before_batch"),
    );
  });

  it("refuses a stale batch with its rows and writes nothing; a terminal member gets no registration (D33)", async () => {
    const stays = await participation();
    const leaves = await participation();
    const moved = await participation();
    const scans = [
      await acceptedScan(stays),
      await acceptedScan(leaves),
      await acceptedScan(moved),
    ];
    const batchId = await create(scans);
    await changeStatus(app, leaves, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await today(),
    });
    await call(app, "set_asu_route", {
      context: pl,
      participationId: moved,
      channel: "online_self",
      version: 1,
    });
    const { message, rows } = await refusal(submit(batchId));
    expect(message).toBe("batch_stale");
    expect(rows).toEqual(
      expect.arrayContaining([
        { participationId: leaves, documentId: scans[1], reason: "participation_closed" },
        { participationId: moved, documentId: scans[2], reason: "asu_route_changed" },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(await one("select status::text from kug200b_batch")).toEqual({ status: "open" });
    expect(await all("select id from agentur_submission")).toEqual([]);
    expect(await all("select id from asu_registration")).toEqual([]);
    // The settings resolved otherwise: one batch-level row.
    expect((await refusal(submit(batchId, { channel: "upload" }))).rows).toEqual([
      { participationId: null, documentId: null, reason: "settings_changed" },
    ]);
    expect((await refusal(submit(batchId, { artifact: "accepted_alternative" }))).rows).toEqual([
      { participationId: null, documentId: null, reason: "settings_changed" },
    ]);
  });

  it("refuses a quarantined scan as stale, and hides a batch from anyone but its PL", async () => {
    const id = await participation();
    const scan = await acceptedScan(id);
    const batchId = await create([scan]);
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: scan,
      reason: "suspected_wrong_person",
    });
    await expect(submit(batchId, { context: asConsultant })).rejects.toMatchObject(
      failsWith("batch_not_found"),
    );
    await expect(submit(batchId, { context: asAdmin })).rejects.toMatchObject(
      failsWith("batch_not_found"),
    );
    await expect(
      call(app, "discard_kug200b_batch", { context: asConsultant, batchId }),
    ).rejects.toMatchObject(failsWith("batch_not_found"));
    expect((await refusal(submit(batchId))).rows).toEqual([
      { participationId: id, documentId: scan, reason: "scan_unusable" },
    ]);
  });
});

async function submitted() {
  const id = await participation();
  await submit(await create([await acceptedScan(id)]));
  const { id: registrationId } = await one("select id from asu_registration");
  return { id, registrationId };
}
const confirm = (id: string, registrationId: string, confirmedOn: string, context = pl) =>
  call(app, "record_asu_confirmation", {
    context,
    participationId: id,
    registrationId,
    confirmedOn,
  });

describe("record_asu_confirmation (D19)", () => {
  it("records the Agentur's date once, by the PL, from the submission to today", async () => {
    const { id, registrationId } = await submitted();
    await expect(confirm(id, registrationId, await today(), asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(confirm(id, registrationId, await daysFrom(1))).rejects.toMatchObject(
      failsWith("confirmed_on_in_future"),
    );
    await expect(confirm(id, registrationId, await daysFrom(-1))).rejects.toMatchObject(
      failsWith("confirmed_before_submission"),
    );
    await expect(confirm(id, randomUUID(), await today())).rejects.toMatchObject(
      failsWith("asu_registration_not_found"),
    );
    await confirm(id, registrationId, await today());
    expect(await one("select confirmed_on::text, confirmed_by from asu_registration")).toEqual({
      confirmed_on: await today(),
      confirmed_by: projectLead,
    });
    await expect(confirm(id, registrationId, await today())).rejects.toMatchObject(
      failsWith("asu_confirmed"),
    );
    expect(
      await one(
        `select details from audit_event where participation_id = $1
           and event_type::text = 'asu_confirmation_recorded'`,
        [id],
      ),
    ).toEqual({ details: { registrationId, confirmedOn: await today() } });
  });

  it("takes no confirmation on another route", async () => {
    const id = await participation({ route: "online_self" });
    const registrationId = randomUUID();
    await call(app, "record_asu_registration", {
      context: pl,
      participationId: id,
      id: registrationId,
      registeredOn: await today(),
      routeVersion: 1,
    });
    await expect(confirm(id, registrationId, await today())).rejects.toMatchObject(
      failsWith("asu_not_kug200b"),
    );
  });
});

describe("a batch's export link (data-protection.md, exports; D24)", () => {
  let session: string;
  beforeEach(async () => {
    session = hex();
    await owner.query(
      `insert into staff_session (token_hash, staff_user_id, created_at, expires_at)
       values ($1, $2, now(), now() + interval '${STAFF_SESSION_HOURS} hours')`,
      [session, projectLead],
    );
  });
  const link = (
    batchId: string,
    linkHash: string,
    context = pl,
    channel = "scan_email",
    sessionHash = session,
  ) =>
    call(app, "create_kug200b_batch_export_link", {
      context,
      kind: "kug200b_batch_index",
      batchId,
      sessionHash,
      linkHash,
      channel,
      artifact: "kug200a",
      outdatedVersions: [],
    });
  const content = (linkHash: string) =>
    all(
      `select participation_id, last_name, first_name, form_version
       from kug200b_batch_export_content($1, $2, $3)`,
      [pl, linkHash, session],
    ).catch(() => null);

  it("rechecks at the request, re-authorizes at the download and stores no file", async () => {
    const id = await participation();
    const scan = await acceptedScan(id);
    const batchId = await create([scan]);
    const linkHash = hex();
    await link(batchId, linkHash);
    const rows = await all(
      `select participation_id, form_version from kug200b_batch_export_content($1, $2, $3)`,
      [pl, linkHash, session],
    );
    expect(rows).toEqual([{ participation_id: id, form_version: "09-2021" }]);
    expect(
      await one(
        `select kind::text, document_ids, batch_id from export_link where token_hash = $1`,
        [linkHash],
      ),
    ).toEqual({ kind: "kug200b_batch_index", document_ids: [], batch_id: batchId });
    expect(
      await call(app, "export_link_kind", { context: pl, linkHash, sessionHash: session }),
    ).toBe("kug200b_batch_index");
    // The print file's content function never serves a batch's link.
    await expect(
      app.query("select * from export_link_content($1, $2, $3)", [pl, linkHash, session]),
    ).rejects.toMatchObject(failsWith("export_link_invalid"));
    expect(
      (await projectEvents(werkNord, "export_downloaded")).map(({ details }) => details),
    ).toEqual([{ exportKind: "kug200b_batch_index", count: 1 }]);
    // A member that moves after the request: the download is stale.
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: scan,
      reason: "suspected_wrong_person",
    });
    await expect(
      app.query("select * from kug200b_batch_export_content($1, $2, $3)", [pl, linkHash, session]),
    ).rejects.toMatchObject(failsWith("export_stale"));
    // At the request: hidden first, then stale with its rows.
    const consultantSession = hex();
    await owner.query(
      `insert into staff_session (token_hash, staff_user_id, created_at, expires_at)
       values ($1, $2, now(), now() + interval '${STAFF_SESSION_HOURS} hours')`,
      [consultantSession, consultant],
    );
    await expect(
      link(batchId, hex(), asConsultant, "scan_email", consultantSession),
    ).rejects.toMatchObject(failsWith("batch_not_found"));
    expect((await refusal(link(batchId, hex()))).rows).toEqual([
      { participationId: id, documentId: scan, reason: "scan_unusable" },
    ]);
    expect(await content(hex())).toBeNull();
  });

  it("refuses a submitted batch and changed settings", async () => {
    const batchId = await create([await acceptedScan(await participation())]);
    expect((await refusal(link(batchId, hex(), pl, "upload"))).rows).toEqual([
      { participationId: null, documentId: null, reason: "settings_changed" },
    ]);
    await submit(batchId);
    await expect(link(batchId, hex())).rejects.toMatchObject(failsWith("batch_not_open"));
  });
});
