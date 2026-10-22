import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// Assisted mode (ADR-0007, assisted mode; data-protection.md, access matrix; Q136) as transfer_app
// calls it: bound to the staff session, the roles' rights in the encrypted groups, actor and
// onBehalfOf on every write. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const NOTICE = "self-service-purposes:v1";
const key = hex();
const keyId = hex(8);

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

const baDetails = {
  pensionInsuranceNumber: "65170839J003",
  nationality: { kind: "german" },
  entryToGermanyDate: null,
  residenceStatus: null,
  buergergeld: false,
};

/** A participation without an account (ADR-0007: some never activate). */
async function participation() {
  const participationId = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
  });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', '1970-01-01')`,
    [participationId, seedProjectIds.werkNord, `SYN-${participationId.slice(-8)}`],
  );
  return participationId;
}

/** A live staff session (dev login) of the user; returns its token hash. */
async function staffSession(staffUserId: string) {
  const tokenHash = hex();
  await call(app, "start_staff_session", {
    staffUserId,
    tokenHash,
    method: "dev",
    oidcIssuer: null,
    oidcSubject: null,
    supersededTokenHash: null,
    requestId: "req-login",
  });
  return tokenHash;
}

const own = (staffUserId: string) =>
  auditContext({ actorType: "user", staffUserId, requestId: "req-staff" });
const onBehalf = (staffUserId: string, participationId: string) =>
  auditContext({
    actorType: "user",
    staffUserId,
    onBehalfOf: participationId,
    requestId: "req-assisted",
  });

type Staff = { staffUserId: string; session: string };
const start = (s: Staff, participationId: string, how = "phone") =>
  call(app, "start_assisted_mode", {
    participationId,
    context: own(s.staffUserId),
    staffSessionHash: s.session,
    how,
    id: randomUUID(),
  });
const end = (s: Staff, participationId: string) =>
  call<boolean>(app, "end_assisted_mode", {
    participationId,
    context: own(s.staffUserId),
    staffSessionHash: s.session,
  });

const acknowledge = (s: Staff, participationId: string) =>
  call(app, "acknowledge_self_service_notice", {
    participationId,
    context: onBehalf(s.staffUserId, participationId),
    noticeVersion: NOTICE,
    language: "de",
    id: randomUUID(),
    tokenHash: s.session,
  });
const writePage = (
  s: Staff,
  participationId: string,
  page: string,
  values: Record<string, unknown>,
  revision: number,
) =>
  call<number>(app, "write_self_service_data", {
    participationId,
    context: onBehalf(s.staffUserId, participationId),
    page,
    values: JSON.stringify(values),
    revision,
    noticeVersion: NOTICE,
    tokenHash: s.session,
  });
const writeGroup = (
  s: Staff,
  participationId: string,
  group: string,
  values: Record<string, unknown>,
  revision: number,
) =>
  call<number>(app, "write_sensitive_fields", {
    participationId,
    context: onBehalf(s.staffUserId, participationId),
    group,
    values: JSON.stringify(values),
    revision,
    noticeVersion: NOTICE,
    key,
    keyId,
    tokenHash: s.session,
  });
const read = (s: Staff, participationId: string, keys: string[]) =>
  call<Record<string, unknown>>(app, "read_sensitive_fields", {
    participationId,
    context: onBehalf(s.staffUserId, participationId),
    keys,
    key,
    keyId,
    tokenHash: s.session,
  });

const events = (participationId: string, types: string[]) =>
  all(
    `select event_type, actor_type, actor_staff_user_id, on_behalf_of_participation_id, details
     from audit_event where participation_id = $1 and event_type = any($2) order by seq`,
    [participationId, types],
  );

const assign = (participationId: string) =>
  owner.query(
    `insert into participant_assignment (project_id, participation_id, staff_user_id, assigned_by)
     values ($1, $2, $3, $4)`,
    [
      seedProjectIds.werkNord,
      participationId,
      seedStaffUserIds.consultant,
      seedStaffUserIds.projectLead,
    ],
  );

async function withdraw(participationId: string) {
  await changeStatus(app, participationId, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(app, participationId, {
    field: "status",
    from: "contacted",
    to: "withdrawn",
    endReason: "other",
    effectiveDate: "2026-10-21",
  });
}

async function asStaff(staffUserId: string): Promise<Staff> {
  return { staffUserId, session: await staffSession(staffUserId) };
}

describe("start_assisted_mode and end_assisted_mode (Q136)", () => {
  let participationId: string;
  let lead: Staff;
  beforeEach(async () => {
    participationId = await participation();
    lead = await asStaff(seedStaffUserIds.projectLead);
  });

  it("open it for a participant without an account, bound to the staff session, audited", async () => {
    const id = await start(lead, participationId, "in_person");
    expect(
      await one(
        `select staff_user_id, staff_session_hash, how, ended_at from assisted_mode where id = $1`,
        [id],
      ),
    ).toEqual({
      staff_user_id: seedStaffUserIds.projectLead,
      staff_session_hash: lead.session,
      how: "in_person",
      ended_at: null,
    });
    expect(await events(participationId, ["assisted_mode_started"])).toEqual([
      {
        event_type: "assisted_mode_started",
        actor_type: "user",
        actor_staff_user_id: seedStaffUserIds.projectLead,
        on_behalf_of_participation_id: null,
        details: { assistedModeId: id, how: "in_person" },
      },
    ]);
  });

  it("let the PL, back office and only the assigned consultant open it", async () => {
    const backOffice = await asStaff(seedStaffUserIds.backOffice);
    expect(await start(backOffice, participationId)).toMatch(/^[0-9a-f-]{36}$/);
    const consultant = await asStaff(seedStaffUserIds.consultant);
    await expect(start(consultant, participationId)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await assign(participationId);
    expect(await start(consultant, participationId)).toMatch(/^[0-9a-f-]{36}$/);
    const admin = await asStaff(seedStaffUserIds.admin);
    await expect(start(admin, participationId)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });

  it("need a live session of the acting staff user", async () => {
    const other = await staffSession(seedStaffUserIds.backOffice);
    await expect(start({ ...lead, session: other }, participationId)).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await expect(start({ ...lead, session: hex() }, participationId)).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
  });

  it("refuse a terminal participation", async () => {
    await withdraw(participationId);
    await expect(start(lead, participationId)).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });

  it("end it on 'Beenden', once; starting again ends the open one first", async () => {
    const first = await start(lead, participationId);
    const second = await start(lead, participationId, "in_person");
    expect(await end(lead, participationId)).toBe(true);
    expect(await end(lead, participationId)).toBe(false);
    expect(
      (await events(participationId, ["assisted_mode_started", "assisted_mode_ended"])).map((e) => [
        e.event_type,
        e.details,
      ]),
    ).toEqual([
      ["assisted_mode_started", { assistedModeId: first, how: "phone" }],
      ["assisted_mode_ended", { assistedModeId: first, endReason: "ended" }],
      ["assisted_mode_started", { assistedModeId: second, how: "in_person" }],
      ["assisted_mode_ended", { assistedModeId: second, endReason: "ended" }],
    ]);
  });

  it("end with the staff session", async () => {
    const id = await start(lead, participationId);
    await acknowledge(lead, participationId);
    await call(app, "end_staff_session", { tokenHash: lead.session, requestId: "req-logout" });
    expect(await one(`select end_reason from assisted_mode where id = $1`, [id])).toEqual({
      end_reason: "staff_session_ended",
    });
    expect((await events(participationId, ["assisted_mode_ended"]))[0]).toMatchObject({
      actor_staff_user_id: seedStaffUserIds.projectLead,
      details: { assistedModeId: id, endReason: "staff_session_ended" },
    });
    await expect(
      writePage(lead, participationId, "personal", { gender: "female", maritalStatus: null }, 0),
    ).rejects.toMatchObject(failsWith("assisted_mode_required"));
  });

  it("are dead once the staff session expired; the next start closes them", async () => {
    const id = await start(lead, participationId);
    await owner.query(
      `update staff_session set created_at = now() - interval '9 hours',
         expires_at = now() - interval '1 hour' where token_hash = $1`,
      [lead.session],
    );
    await expect(acknowledge(lead, participationId)).rejects.toMatchObject(
      failsWith("assisted_mode_required"),
    );
    const fresh = await asStaff(seedStaffUserIds.projectLead);
    await start(fresh, participationId);
    expect(await one(`select end_reason from assisted_mode where id = $1`, [id])).toEqual({
      end_reason: "staff_session_ended",
    });
  });
});

describe("writes and reads in assisted mode (Q136)", () => {
  let participationId: string;
  beforeEach(async () => {
    participationId = await participation();
  });

  async function opened(staffUserId: string) {
    const s = await asStaff(staffUserId);
    await start(s, participationId);
    return s;
  }

  it("need a live mode of this session and participation, on behalf of the participant", async () => {
    const lead = await asStaff(seedStaffUserIds.projectLead);
    await expect(acknowledge(lead, participationId)).rejects.toMatchObject(
      failsWith("assisted_mode_required"),
    );
    await start(lead, participationId);
    const elsewhere = await participation();
    await expect(acknowledge(lead, elsewhere)).rejects.toMatchObject(
      failsWith("assisted_mode_required"),
    );
    const otherSession = await asStaff(seedStaffUserIds.projectLead);
    await expect(acknowledge(otherSession, participationId)).rejects.toMatchObject(
      failsWith("assisted_mode_required"),
    );
    await expect(
      call(app, "acknowledge_self_service_notice", {
        participationId,
        context: own(seedStaffUserIds.projectLead),
        noticeVersion: NOTICE,
        language: "de",
        id: randomUUID(),
        tokenHash: lead.session,
      }),
    ).rejects.toMatchObject(failsWith("invalid_actor"));
    expect(await acknowledge(lead, participationId)).toBe(true);
  });

  it("audit actor and onBehalfOf; contact fields become participant-maintained", async () => {
    const lead = await opened(seedStaffUserIds.projectLead);
    await acknowledge(lead, participationId);
    const contact = {
      address: { street: "Musterweg 2", postalCode: "10115", city: "Berlin", country: "DE" },
      phone: null,
      mobile: "+4915100000000",
      privateEmail: null,
    };
    expect(await writePage(lead, participationId, "contact", contact, 0)).toBe(1);
    expect(
      await one(
        `select participant_maintained from participant_details where participation_id = $1`,
        [participationId],
      ),
    ).toEqual({ participant_maintained: ["address", "mobile"] });
    const written = await events(participationId, [
      "self_service_notice_acknowledged",
      "participant_data_changed",
    ]);
    expect(
      written.map((e) => [e.actor_type, e.actor_staff_user_id, e.on_behalf_of_participation_id]),
    ).toEqual([
      ["user", seedStaffUserIds.projectLead, participationId],
      ["user", seedStaffUserIds.projectLead, participationId],
    ]);
    expect(written[1].details).toEqual({ fields: ["address", "mobile"] });
    expect(
      await one(
        `select actor_type, actor_staff_user_id from self_service_notice_acknowledgement
         where participation_id = $1`,
        [participationId],
      ),
    ).toEqual({ actor_type: "user", actor_staff_user_id: seedStaffUserIds.projectLead });
  });

  it("let the PL write and read health and disability, never the BA details", async () => {
    const lead = await opened(seedStaffUserIds.projectLead);
    await acknowledge(lead, participationId);
    expect(
      await writeGroup(
        lead,
        participationId,
        "health",
        { healthRestrictions: false, severeDisability: true },
        0,
      ),
    ).toBe(1);
    expect(await read(lead, participationId, ["healthRestrictions", "severeDisability"])).toEqual({
      healthRestrictions: false,
      severeDisability: true,
    });
    await expect(
      writeGroup(lead, participationId, "ba_details", baDetails, 1),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(read(lead, participationId, ["nationality"])).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const audited = await events(participationId, ["sensitive_write", "sensitive_read"]);
    expect(
      audited.map((e) => [e.event_type, e.details.key, e.on_behalf_of_participation_id]),
    ).toEqual([
      ["sensitive_write", "healthRestrictions", participationId],
      ["sensitive_write", "severeDisability", participationId],
      ["sensitive_read", "healthRestrictions", participationId],
      ["sensitive_read", "severeDisability", participationId],
    ]);
  });

  it("let back office write all but health; the health restrictions keep their value", async () => {
    const consultant = await (async () => {
      await assign(participationId);
      return opened(seedStaffUserIds.consultant);
    })();
    await acknowledge(consultant, participationId);
    await writeGroup(
      consultant,
      participationId,
      "health",
      { healthRestrictions: true, severeDisability: false },
      0,
    );
    const backOffice = await opened(seedStaffUserIds.backOffice);
    await expect(
      writeGroup(
        backOffice,
        participationId,
        "health",
        { healthRestrictions: false, severeDisability: true },
        1,
      ),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    expect(
      await writeGroup(backOffice, participationId, "health", { severeDisability: true }, 1),
    ).toBe(2);
    expect(await writeGroup(backOffice, participationId, "ba_details", baDetails, 2)).toBe(3);
    await expect(read(backOffice, participationId, ["healthRestrictions"])).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    expect(
      await read(consultant, participationId, [
        "healthRestrictions",
        "severeDisability",
        "pensionInsuranceNumber",
      ]),
    ).toEqual({
      healthRestrictions: true,
      severeDisability: true,
      pensionInsuranceNumber: baDetails.pensionInsuranceNumber,
    });
    expect(
      await one(
        `select health_restrictions_present, severe_disability_present from participant_health_data
         where participation_id = $1`,
        [participationId],
      ),
    ).toEqual({ health_restrictions_present: true, severe_disability_present: true });
  });

  it("stop for a consultant whose assignment ended", async () => {
    await assign(participationId);
    const consultant = await opened(seedStaffUserIds.consultant);
    await owner.query(
      `update participant_assignment set ended_at = now(), ended_by = $2,
         end_reason = 'unassigned' where participation_id = $1`,
      [participationId, seedStaffUserIds.projectLead],
    );
    await expect(acknowledge(consultant, participationId)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });

  it("are refused once the participation is terminal", async () => {
    const lead = await opened(seedStaffUserIds.projectLead);
    await withdraw(participationId);
    await expect(acknowledge(lead, participationId)).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });
});
