import { randomBytes } from "node:crypto";
import {
  AuditEventType,
  auditProjectionRows,
  fieldCategoryRows,
  roleFieldKnowledgeRows,
} from "@transfer/domain";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { call, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// The audit history (data-protection.md, audit metadata; Q157): `audit_history` called directly
// as transfer_app, the authorization boundary. Synthetic data only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = () => randomBytes(32).toString("hex");
const { projectLead, consultant, backOffice, admin } = seedStaffUserIds;
/** A second consultant of Werk Nord, created per test. */
const otherConsultant = "00000000-0000-4000-8000-0000000000c2";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true, keepSessions: false }));

const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

/** A live staff session of the user, through its function. */
async function session(staffUserId: string) {
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

type Row = Record<string, unknown> & { event_type: string; seq: string };

async function history(
  sessionHash: string,
  participationId: string,
  options: { before?: string | null; limit?: number } = {},
): Promise<Row[]> {
  const { rows } = await app.query("select * from audit_history($1, $2, $3, $4, $5)", [
    sessionHash,
    participationId,
    options.before ?? null,
    options.limit ?? 100,
    "req-history",
  ]);
  return rows;
}

const types = (rows: Row[]) => rows.map((row) => row.event_type);

/** A synthetic audit row of the participation, written as the owner (a fixture, never the app). */
async function event(participationId: string, row: Record<string, unknown>) {
  const columns = {
    project_id: seedProjectIds.werkNord,
    participation_id: participationId,
    actor_type: "user",
    actor_staff_user_id: projectLead,
    details: {},
    ...row,
  };
  const names = Object.keys(columns);
  const values = names.map((name) =>
    name === "details"
      ? JSON.stringify(columns[name as keyof typeof columns])
      : columns[name as keyof typeof columns],
  );
  await owner.query(
    `insert into audit_event (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    values,
  );
}

async function participation() {
  return call(app, "create_participation", { projectId: seedProjectIds.werkNord, context: pl });
}

async function assign(participationId: string, staffUserId: string = consultant) {
  await call(app, "assign_participations", {
    projectId: seedProjectIds.werkNord,
    participationIds: [participationId],
    staffUserId,
    context: pl,
  });
}

describe("the reference tables (drift)", () => {
  it("hold the domain's projection, one row per event type and status field", async () => {
    const rows = await all(
      `select event_type, field::text, stream::text, shows_change, shows_reason, detail_keys
       from audit_event_projection`,
    );
    const expected = auditProjectionRows().map((row) => ({
      event_type: row.eventType,
      field: row.field,
      stream: row.stream,
      shows_change: row.showsChange,
      shows_reason: row.showsReason,
      detail_keys: [...row.detailKeys],
    }));
    const key = (row: { event_type: string; field: string | null }) =>
      `${row.event_type}/${row.field}`;
    const sorted = <T extends { event_type: string; field: string | null }>(list: T[]) =>
      list.toSorted((a, b) => key(a).localeCompare(key(b)));
    expect(sorted(rows)).toEqual(sorted(expected));
    const enumValues = await all("select unnest(enum_range(null::audit_event_type))::text as v");
    expect(enumValues.map((row) => row.v).toSorted()).toEqual(AuditEventType.options.toSorted());
  });

  it("hold the domain's role knowledge and field categories", async () => {
    const knowledge = await all(
      "select project_role::text, access_category::text from role_field_knowledge",
    );
    expect(knowledge.map((r) => `${r.project_role}/${r.access_category}`).toSorted()).toEqual(
      roleFieldKnowledgeRows()
        .map((r) => `${r.projectRole}/${r.accessCategory}`)
        .toSorted(),
    );
    const fields = await all("select field_key, access_category::text from field_access_category");
    expect(fields.map((r) => `${r.field_key}/${r.access_category}`).toSorted()).toEqual(
      fieldCategoryRows()
        .map((r) => `${r.fieldKey}/${r.accessCategory}`)
        .toSorted(),
    );
  });
});

describe("audit_history (Q157)", () => {
  let id: string;
  beforeEach(async () => {
    await owner.query(
      `insert into staff_user (id, display_name, email) values ($1, 'Clara Coaching', 'consultant-2@example.org')`,
      [otherConsultant],
    );
    await owner.query(
      `insert into project_membership (project_id, staff_user_id, role) values ($1, $2, 'consultant')`,
      [seedProjectIds.werkNord, otherConsultant],
    );
    id = await participation(); // participation_created by the PL
    await event(id, {
      event_type: "status_changed",
      field: "profiling_status",
      from_value: "not_started",
      to_value: "profiling_accepted",
      actor_staff_user_id: consultant,
    });
    await event(id, {
      event_type: "status_changed",
      field: "dsv_status",
      from_value: "not_offered",
      to_value: "dsv_offered",
      details: { offerDeadline: "2091-02-15" },
    });
    await event(id, {
      event_type: "status_changed",
      field: "dsv_status",
      from_value: "dsv_offered",
      to_value: "dsv_signed",
      actor_staff_user_id: consultant,
    });
    await event(id, {
      event_type: "status_changed",
      field: "dsv_status",
      from_value: "dsv_offered",
      to_value: "dsv_signed",
      actor_staff_user_id: otherConsultant,
    });
    await event(id, {
      event_type: "document_opened",
      details: { documentType: "cv", documentId: id },
    });
    await event(id, { event_type: "sensitive_read", details: { key: "healthRestrictions" } });
    await event(id, {
      event_type: "participant_login",
      actor_type: "participant",
      actor_staff_user_id: null,
      actor_participation_id: id,
      details: { method: "one_time_code", channelId: id },
    });
    await event(id, {
      event_type: "review_recorded",
      reason_code: "approved",
      details: { reviewedEventId: id },
    });
    await event(id, {
      event_type: "break_glass_access",
      reason_code: "incident",
      flagged_for_review: true,
      details: { action: "read", target: { kind: "field", category: "health" } },
    });
  });

  it("gives the PL case, profiling and dsv, never security or review events", async () => {
    const rows = await history(await session(projectLead), id);
    expect(types(rows)).toEqual([
      "status_changed",
      "status_changed",
      "status_changed",
      "status_changed",
      "participation_created",
    ]);
    expect(rows.map((row) => row.to_value)).toEqual([
      "dsv_signed",
      "dsv_signed",
      "dsv_offered",
      "profiling_accepted",
      "imported",
    ]);
    expect(rows.map((row) => row.actor_name)).toEqual([
      "Clara Coaching",
      "Bernd Beratung",
      "Petra Projektleitung",
      "Bernd Beratung",
      "Petra Projektleitung",
    ]);
    expect(rows[2]!.details).toEqual({ offerDeadline: "2091-02-15" });
  });

  it("gives the assigned consultant case and profiling, and only their own DSV action", async () => {
    await assign(id);
    const rows = await history(await session(consultant), id);
    expect(rows.map((row) => `${row.event_type}/${row.to_value ?? ""}`)).toEqual([
      "participant_assigned/",
      "status_changed/dsv_signed",
      "status_changed/profiling_accepted",
      "participation_created/imported",
    ]);
    expect(rows[1]!.actor_name).toBe("Bernd Beratung");
  });

  it("gives back office dsv and payroll only", async () => {
    const rows = await history(await session(backOffice), id);
    expect(rows.map((row) => row.to_value)).toEqual(["dsv_signed", "dsv_signed", "dsv_offered"]);
  });

  it("is the union of the viewer's roles (Q61)", async () => {
    await assign(id);
    await owner.query(
      `insert into project_membership (project_id, staff_user_id, role) values ($1, $2, 'back_office')`,
      [seedProjectIds.werkNord, otherConsultant],
    );
    await assign(id, otherConsultant);
    const rows = await history(await session(otherConsultant), id);
    expect(types(rows)).toEqual([
      "participant_assigned",
      "participant_assigned",
      "status_changed",
      "status_changed",
      "status_changed",
      "status_changed",
      "participation_created",
    ]);
  });

  it("refuses an ended session, a non-member and an unassigned consultant", async () => {
    const ended = await session(projectLead);
    await app.query("select end_staff_session($1, 'req-logout')", [ended]);
    await expect(history(ended, id)).rejects.toMatchObject(failsWith("unauthenticated"));
    await expect(history(hex(), id)).rejects.toMatchObject(failsWith("unauthenticated"));
    await expect(history(await session(admin), id)).rejects.toMatchObject(failsWith("not_member"));
    await expect(history(await session(consultant), id)).rejects.toMatchObject(
      failsWith("not_assigned"),
    );
    await expect(
      history(await session(projectLead), "00000000-0000-4000-a000-00000000dead"),
    ).rejects.toMatchObject(failsWith("participation_not_found"));
    for (const limit of [0, 101]) {
      await expect(history(await session(projectLead), id, { limit })).rejects.toMatchObject(
        failsWith("invalid_argument"),
      );
    }
  });

  it("follows an unassignment at the next call", async () => {
    await assign(id);
    const hash = await session(consultant);
    expect((await history(hash, id)).length).toBeGreaterThan(0);
    await call(app, "unassign_participation", {
      participationId: id,
      staffUserId: consultant,
      context: pl,
    });
    await expect(history(hash, id)).rejects.toMatchObject(failsWith("not_assigned"));
  });

  it("writes one audit_history_opened on the first page, none on later pages, and never returns it", async () => {
    const hash = await session(projectLead);
    const first = await history(hash, id, { limit: 2 });
    expect(first).toHaveLength(2);
    const later = await history(hash, id, { before: first[1]!.seq, limit: 2 });
    expect(later.map((row) => row.to_value)).toEqual(["dsv_offered", "profiling_accepted"]);
    const opened = await all(
      `select actor_type::text, actor_staff_user_id, participation_id, details, request_id
       from audit_event where event_type = 'audit_history_opened'`,
    );
    expect(opened).toEqual([
      {
        actor_type: "user",
        actor_staff_user_id: projectLead,
        participation_id: id,
        details: {},
        request_id: "req-history",
      },
    ]);
    expect(types(await history(hash, id))).not.toContain("audit_history_opened");
  });

  it("never returns openings, sensitive reads, logins, reviews or break-glass", async () => {
    await assign(id);
    for (const viewer of [projectLead, consultant, backOffice]) {
      const shown = types(await history(await session(viewer), id));
      for (const type of [
        "document_opened",
        "sensitive_read",
        "participant_login",
        "review_recorded",
        "break_glass_access",
        "audit_history_opened",
      ]) {
        expect(shown).not.toContain(type);
      }
    }
  });

  it("returns no project-level event", async () => {
    await owner.query(
      `insert into audit_event (project_id, participation_id, event_type, actor_type, actor_staff_user_id, details)
       values ($1, null, 'warning_confirmed', 'user', $2, '{}')`,
      [seedProjectIds.werkNord, projectLead],
    );
    const shown = await history(await session(projectLead), id);
    expect(shown.every((row) => row.event_type !== "warning_confirmed")).toBe(true);
  });
});

describe("audit_history redaction (Q157)", () => {
  let id: string;
  beforeEach(async () => {
    id = await participation();
  });

  const latest = async (staffUserId: string = projectLead) =>
    (await history(await session(staffUserId), id))[0]!;

  it("keeps only the allowed detail keys", async () => {
    await event(id, {
      event_type: "activation_code_issued",
      details: {
        activationCodeId: id,
        purpose: "activation",
        channel: "letter",
        identityCheck: "none",
        noticeVersion: "art14-activation:v1",
        language: "de",
      },
    });
    expect((await latest()).details).toEqual({ purpose: "activation", channel: "letter" });
  });

  it("nulls a reason code its type doesn't show, and a change its type doesn't show", async () => {
    await event(id, {
      event_type: "entry_wave_assigned",
      reason_code: "not_for_viewers",
      details: { waveId: id, previousWaveId: null },
    });
    const row = await latest();
    expect(row).toMatchObject({
      event_type: "entry_wave_assigned",
      reason_code: null,
      field: null,
    });
    expect(row.details).toEqual({ waveId: id, previousWaveId: null });
    await event(id, {
      event_type: "document_reviewed",
      reason_code: "unreadable",
      details: { documentType: "cv", documentId: id, decision: "rejected" },
    });
    expect(await latest()).toMatchObject({
      reason_code: "unreadable",
      details: { documentType: "cv", decision: "rejected" },
    });
  });

  it("keeps field keys only of the categories the viewer's roles may know", async () => {
    await assign(id);
    await event(id, {
      event_type: "participant_data_changed",
      details: {
        fields: ["lastName", "pensionInsuranceNumber", "healthRestrictions", "custom.shoe_size"],
      },
    });
    // The PL knows confidential and health data (in assisted mode), never identifiers.
    expect((await latest()).details).toEqual({
      fields: ["lastName", "healthRestrictions", "custom.shoe_size"],
    });
    expect((await latest(consultant)).details).toEqual({
      fields: ["lastName", "pensionInsuranceNumber", "healthRestrictions", "custom.shoe_size"],
    });
    await event(id, {
      event_type: "participant_data_changed",
      details: { fields: ["pensionInsuranceNumber", "unknownField"] },
    });
    expect((await latest()).details).toEqual({});
  });

  it("names the actor: a retained staff name, the participant, the system, assisted mode", async () => {
    await event(id, {
      event_type: "consent_given",
      actor_type: "participant",
      actor_staff_user_id: null,
      actor_participation_id: id,
      details: {
        consentId: id,
        channelId: id,
        purpose: "portal_contact",
        textVersion: "portal-contact-consent:v2",
        language: "de",
      },
    });
    expect(await latest()).toMatchObject({
      actor_type: "participant",
      actor_name: null,
      on_behalf: false,
      details: { purpose: "portal_contact", textVersion: "portal-contact-consent:v2" },
    });
    await event(id, {
      event_type: "reminder_delivery",
      actor_type: "system",
      actor_staff_user_id: null,
      system_job: "reminders.send",
      details: { reminderId: id, outcome: "sent" },
    });
    expect(await latest()).toMatchObject({
      actor_type: "system",
      actor_name: null,
      system_job: "reminders.send",
      details: { outcome: "sent" },
    });
    await event(id, {
      event_type: "document_added",
      on_behalf_of_participation_id: id,
      details: { documentId: id, documentType: "cv", source: "assisted" },
    });
    expect(await latest()).toMatchObject({
      actor_type: "user",
      actor_name: "Petra Projektleitung",
      on_behalf: true,
    });
  });
});

describe("transfer_app and the trail", () => {
  it("still can't select audit_event", async () => {
    await expect(app.query("select * from audit_event")).rejects.toMatchObject({ code: "42501" });
  });
});
