import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

// Reminders and consent v2 (data-protection.md, reminders and consent v2), as transfer_app calls
// the functions. Synthetic data only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = () => randomBytes(32).toString("hex");
const NOTICE = "art14-activation:v1";
const V1 = "portal-contact-consent:v1";
const V2 = "portal-contact-consent:v2";
const MESSAGE = "portal-reminder:v1";
const consultant = auditContext({ actorType: "user", staffUserId: seedStaffUserIds.consultant });
const backOffice = auditContext({ actorType: "user", staffUserId: seedStaffUserIds.backOffice });

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

let addresses = 0;
const nextEmail = () => `person-${++addresses}@example.invalid`;

async function participation(projectId: string = seedProjectIds.werkNord) {
  const id = await call(app, "create_participation", { projectId, context: pl });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', '1970-01-01')`,
    [id, projectId, `SYN-${id.slice(-8)}`],
  );
  await owner.query(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE')`,
    [id, projectId],
  );
  return id;
}

/** An activated participant (consent v2) with one channel and a live active session. */
async function activated(
  options: { kind?: "email" | "sms"; address?: string; projectId?: string } = {},
) {
  const { kind = "email", projectId } = options;
  const address = options.address ?? (kind === "email" ? nextEmail() : "+4915112345678");
  const participationId = await participation(projectId);
  const codeHash = hex();
  await call(app, "issue_activation_code", {
    participationId,
    codeHash,
    channel: "letter",
    language: "de",
    noticeVersion: NOTICE,
    replaceOpenCode: false,
    deliveryKind: null,
    deliveryAddressHash: null,
    identityChecked: false,
    context: pl,
    id: randomUUID(),
    purpose: "activation",
  });
  const tokenHash = hex();
  await call(app, "start_activation", { codeHash, tokenHash, requestId: "req-1" });
  await call(app, "check_activation_birth_date", {
    tokenHash,
    birthDate: "1970-01-01",
    requestId: "req-2",
  });
  const oneTimeCodeHash = hex();
  await call(app, "create_one_time_code", {
    tokenHash,
    kind,
    address,
    codeHash: oneTimeCodeHash,
    id: randomUUID(),
  });
  const active = hex();
  const result = await call(app, "complete_activation", {
    tokenHash,
    newTokenHash: active,
    noticeVersion: NOTICE,
    consentVersion: V2,
    language: "en",
    channelId: randomUUID(),
    consentId: randomUUID(),
    requestId: "req-3",
    oneTimeCodeHash,
  });
  expect(result).toBe("activated");
  const channel = await one(
    "select id, consent_id from participant_channel where participation_id = $1",
    [participationId],
  );
  return {
    participationId,
    tokenHash: active,
    channelId: channel.id,
    consentId: channel.consent_id,
  };
}

/** The owner fixture of the e2e spec: the channel's consent recorded as v1, as before Slice 5. */
const makeV1 = (consentId: string) =>
  owner.query("update consent_record set text_version = $1 where id = $2", [V1, consentId]);

/** Withdraws a contacted participation through the status function. */
const withdraw = (id: string) =>
  changeStatus(app, id, {
    field: "status",
    from: "contacted",
    to: "withdrawn",
    endReason: "no_response",
    effectiveDate: "2026-10-20",
  });

type Row = {
  participation_id: string;
  reminder_id: string | null;
  channel_kind: string | null;
  skip: string | null;
};

async function request(ids: string[], context = pl, projectId: string = seedProjectIds.werkNord) {
  const { rows } = await app.query<Row>(
    `select * from request_reminders(p_context => $1, p_project_id => $2,
       p_participation_ids => $3::uuid[], p_kind => 'open_items', p_message_version => $4,
       p_batch_id => $5)`,
    [context, projectId, ids, MESSAGE, randomUUID()],
  );
  return rows;
}

const claim = (reminderId: string, hasActions = true, jobId = "job-1") =>
  call(app, "claim_reminder_dispatch", { reminderId, hasActions, jobId });
const outcome = (reminderId: string, value: string, cancelReason: string | null = null) =>
  call<boolean>(app, "record_reminder_outcome", {
    reminderId,
    outcome: value,
    cancelReason,
    jobId: "job-1",
  });
const reminder = (id: string) => one("select * from participant_reminder where id = $1", [id]);
const events = (participationId: string, types: string[]) =>
  all(
    `select event_type, actor_type, system_job, reason_code, details from audit_event
     where participation_id = $1 and event_type::text = any($2) order by seq`,
    [participationId, types],
  );

async function queued(options: Parameters<typeof activated>[0] = {}) {
  const participant = await activated(options);
  const [row] = await request([participant.participationId]);
  return { ...participant, reminderId: row!.reminder_id! };
}

describe("request_reminders", () => {
  it("queues one reminder on the eligible channel with its consent, language and event", async () => {
    const { participationId, channelId, consentId } = await activated();
    const rows = await request([participationId]);
    expect(rows).toEqual([
      {
        participation_id: participationId,
        reminder_id: expect.any(String),
        channel_kind: "email",
        skip: null,
      },
    ]);
    expect(await reminder(rows[0]!.reminder_id!)).toMatchObject({
      status: "queued",
      kind: "open_items",
      message_version: MESSAGE,
      language: "en",
      channel_id: channelId,
      channel_kind: "email",
      consent_id: consentId,
      requested_by: seedStaffUserIds.projectLead,
      cancel_reason: null,
    });
    const [event] = await events(participationId, ["reminder_queued"]);
    expect(event).toMatchObject({ actor_type: "user" });
    expect(Object.keys(event.details).toSorted()).toEqual([
      "batchId",
      "channelKind",
      "kind",
      "reminderId",
    ]);
  });

  it("skips per row with the API bypassed: closed, no channel, consent required, recently", async () => {
    const closed = await activated();
    await withdraw(closed.participationId);
    const noAccount = await participation();
    const v1 = await activated();
    await makeV1(v1.consentId);
    const recent = await queued();
    const rows = await request([
      closed.participationId,
      noAccount,
      v1.participationId,
      recent.participationId,
    ]);
    expect(rows.map((r) => [r.reminder_id, r.skip])).toEqual([
      [null, "participation_closed"],
      [null, "no_channel"],
      [null, "consent_required"],
      [null, "reminded_recently"],
    ]);
    expect(await one("select count(*)::int as n from participant_reminder")).toEqual({ n: 1 });
  });

  it("counts the window from the last queued request, whatever its outcome", async () => {
    const { participationId, reminderId } = await queued();
    await outcome(reminderId, "cancelled", "delivery_unavailable");
    expect((await request([participationId]))[0]!.skip).toBe("reminded_recently");
    // Three Berlin calendar days later the next one may go.
    await owner.query(
      "update participant_reminder set requested_on = requested_on - 3 where id = $1",
      [reminderId],
    );
    expect((await request([participationId]))[0]!.skip).toBeNull();
  });

  it("prefers the most recently verified email and never a v1 channel", async () => {
    const { participationId, tokenHash } = await activated({ kind: "sms" });
    const code = hex();
    await call(app, "request_channel_code", {
      tokenHash,
      kind: "email",
      address: nextEmail(),
      codeHash: code,
      id: randomUUID(),
    });
    const added = await call(app, "add_participant_channel", {
      tokenHash,
      codeHash: code,
      channelId: randomUUID(),
      consentId: randomUUID(),
      consentVersion: V2,
      language: "de",
      requestId: "req-add",
    });
    expect(added).toBe("added");
    const email = await one(
      "select consent_id from participant_channel where participation_id = $1 and kind = 'email'",
      [participationId],
    );
    await makeV1(email.consent_id);
    expect((await request([participationId]))[0]!.channel_kind).toBe("sms");
  });

  it("refuses a hidden participation, a role that may not remind and assisted mode", async () => {
    const { participationId } = await activated();
    const other = await participation(seedProjectIds.verwaltung);
    await expect(request([participationId, other])).rejects.toMatchObject(
      failsWith("participation_not_found"),
    );
    await expect(request([participationId], consultant)).rejects.toMatchObject(
      failsWith("participation_not_found"),
    );
    await expect(request([participationId], backOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const assisted = auditContext({
      actorType: "user",
      staffUserId: seedStaffUserIds.projectLead,
      onBehalfOf: participationId,
    });
    await expect(request([participationId], assisted)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(request([participationId, participationId])).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    expect(await one("select count(*)::int as n from participant_reminder")).toEqual({ n: 0 });
  });

  it("lets the assigned consultant remind and refuses a project that isn't active", async () => {
    const { participationId } = await activated();
    await owner.query(
      `insert into participant_assignment (project_id, participation_id, staff_user_id, assigned_by)
       values ($1, $2, $3, $4)`,
      [
        seedProjectIds.werkNord,
        participationId,
        seedStaffUserIds.consultant,
        seedStaffUserIds.projectLead,
      ],
    );
    expect((await request([participationId], consultant))[0]!.channel_kind).toBe("email");
    const draft = await participation(seedProjectIds.lagerSued);
    await expect(request([draft], pl, seedProjectIds.lagerSued)).rejects.toMatchObject(
      failsWith("project_not_active"),
    );
  });
});

describe("claim_reminder_dispatch", () => {
  it("claims a reminder whose checks hold, and settles a retry", async () => {
    const { reminderId } = await queued();
    expect(await claim(reminderId)).toBe("dispatching");
    expect(await reminder(reminderId)).toMatchObject({ status: "dispatching", outcome_at: null });
    // A retry after an unknown outcome claims again with the same reminder.
    expect(await claim(reminderId, true, "job-2")).toBe("dispatching");
  });

  it("cancels the channel removed before the claim, never rerouting", async () => {
    const { participationId, tokenHash, channelId, reminderId } = await queued({ kind: "sms" });
    const code = hex();
    await call(app, "request_channel_code", {
      tokenHash,
      kind: "email",
      address: nextEmail(),
      codeHash: code,
      id: randomUUID(),
    });
    await call(app, "add_participant_channel", {
      tokenHash,
      codeHash: code,
      channelId: randomUUID(),
      consentId: randomUUID(),
      consentVersion: V2,
      language: "de",
      requestId: "req-add",
    });
    await call(app, "remove_participant_channel", { tokenHash, channelId, requestId: "req-rm" });
    expect(await claim(reminderId)).toBe("channel_unavailable");
    expect(await reminder(reminderId)).toMatchObject({
      status: "cancelled",
      cancel_reason: "channel_unavailable",
      channel_id: channelId,
    });
    expect(await events(participationId, ["reminder_delivery"])).toEqual([
      {
        event_type: "reminder_delivery",
        actor_type: "system",
        system_job: "reminders.send",
        reason_code: "channel_unavailable",
        details: { reminderId, outcome: "cancelled" },
      },
    ]);
  });

  it("cancels for an ended consent, a closed participation, nothing open and a lost assignment", async () => {
    const ended = await queued();
    await owner.query(
      "update consent_record set ended_at = now(), end_reason = 'revoked' where id = $1",
      [ended.consentId],
    );
    expect(await claim(ended.reminderId)).toBe("consent_ended");

    const closed = await queued();
    await withdraw(closed.participationId);
    expect(await claim(closed.reminderId)).toBe("participation_closed");

    const done = await queued();
    expect(await claim(done.reminderId, false)).toBe("nothing_open");

    const assigned = await activated();
    await owner.query(
      `insert into participant_assignment (project_id, participation_id, staff_user_id, assigned_by)
       values ($1, $2, $3, $4)`,
      [
        seedProjectIds.werkNord,
        assigned.participationId,
        seedStaffUserIds.consultant,
        seedStaffUserIds.projectLead,
      ],
    );
    const [row] = await request([assigned.participationId], consultant);
    await owner.query(
      "update participant_assignment set ended_at = now(), end_reason = 'unassigned', ended_by = $2 where participation_id = $1",
      [assigned.participationId, seedStaffUserIds.projectLead],
    );
    expect(await claim(row!.reminder_id!)).toBe("requester_no_longer_authorized");
    // A settled reminder isn't claimed again.
    expect(await claim(row!.reminder_id!)).toBe("settled");
  });

  it("settles a retry whose claim now fails as delivery_unknown, without another dispatch", async () => {
    const { participationId, consentId, reminderId } = await queued();
    expect(await claim(reminderId)).toBe("dispatching");
    await owner.query(
      "update consent_record set ended_at = now(), end_reason = 'revoked' where id = $1",
      [consentId],
    );
    expect(await claim(reminderId, true, "job-2")).toBe("settled");
    expect(await reminder(reminderId)).toMatchObject({
      status: "delivery_unknown",
      cancel_reason: null,
    });
    const [event] = await events(participationId, ["reminder_delivery"]);
    expect(event.details).toEqual({ reminderId, outcome: "delivery_unknown" });
  });
});

describe("record_reminder_outcome", () => {
  it("records a final outcome once", async () => {
    const { reminderId } = await queued();
    await expect(outcome(reminderId, "sent")).rejects.toMatchObject(
      failsWith("reminder_not_dispatching"),
    );
    await claim(reminderId);
    expect(await outcome(reminderId, "sent")).toBe(true);
    expect(await outcome(reminderId, "sent")).toBe(false);
    await expect(outcome(reminderId, "failed")).rejects.toMatchObject(
      failsWith("reminder_settled"),
    );
    expect(await reminder(reminderId)).toMatchObject({ status: "sent" });
  });

  it("keeps a definitive failure final and cancels an undeliverable queued one", async () => {
    const failed = await queued();
    await claim(failed.reminderId);
    expect(await outcome(failed.reminderId, "failed")).toBe(true);
    expect(await claim(failed.reminderId)).toBe("settled");
    const unavailable = await queued();
    expect(await outcome(unavailable.reminderId, "cancelled", "delivery_unavailable")).toBe(true);
    await expect(
      outcome(unavailable.reminderId, "cancelled", "nothing_open"),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    expect(await reminder(unavailable.reminderId)).toMatchObject({
      status: "cancelled",
      cancel_reason: "delivery_unavailable",
    });
  });
});

const upgrade = (tokenHash: string, channelId: string, consentVersion = V2) =>
  call(app, "upgrade_channel_consent", {
    tokenHash,
    channelId,
    consentId: randomUUID(),
    consentVersion,
    language: "de",
    requestId: "req-up",
  });

describe("consent v2 (data-protection.md, consent v2)", () => {
  it("supersedes the v1 consent with the participant's v2 in one transaction, once", async () => {
    const { participationId, tokenHash, channelId, consentId } = await activated();
    await makeV1(consentId);
    expect((await request([participationId]))[0]!.skip).toBe("consent_required");
    const before = await one("select verified_at from participant_channel where id = $1", [
      channelId,
    ]);
    expect(await upgrade(tokenHash, channelId)).toBe("upgraded");
    const old = await one("select ended_at, end_reason from consent_record where id = $1", [
      consentId,
    ]);
    expect(old.end_reason).toBe("superseded");
    const channel = await one(
      "select c.consent_id, c.verified_at, k.text_version, k.actor_type, k.ended_at from participant_channel c join consent_record k on k.id = c.consent_id where c.id = $1",
      [channelId],
    );
    expect(channel).toMatchObject({ text_version: V2, actor_type: "participant", ended_at: null });
    expect(channel.verified_at).toEqual(before.verified_at);
    const audit = await events(participationId, ["consent_ended", "consent_given"]);
    expect(audit.slice(-2).map((e) => [e.event_type, e.reason_code])).toEqual([
      ["consent_ended", "superseded"],
      ["consent_given", null],
    ]);
    const count = await one("select count(*)::int as n from consent_record");
    expect(await upgrade(tokenHash, channelId)).toBe("already_current");
    expect(await one("select count(*)::int as n from consent_record")).toEqual(count);
    expect((await request([participationId]))[0]!.channel_kind).toBe("email");
  });

  it("refuses another participant's channel, v1 and a session that isn't the participant's", async () => {
    const mine = await activated();
    const theirs = await activated();
    await makeV1(theirs.consentId);
    await expect(upgrade(mine.tokenHash, theirs.channelId)).rejects.toMatchObject(
      failsWith("channel_not_found"),
    );
    await expect(upgrade(theirs.tokenHash, theirs.channelId, V1)).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(upgrade(hex(), theirs.channelId)).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
  });

  it("records v2 only for a new channel and refuses v1", async () => {
    const { tokenHash } = await activated();
    const code = hex();
    await call(app, "request_channel_code", {
      tokenHash,
      kind: "email",
      address: nextEmail(),
      codeHash: code,
      id: randomUUID(),
    });
    await expect(
      call(app, "add_participant_channel", {
        tokenHash,
        codeHash: code,
        channelId: randomUUID(),
        consentId: randomUUID(),
        consentVersion: V1,
        language: "de",
        requestId: "req-add",
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });

  it("has no migration that changes a consent's version", () => {
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
      const text = readFileSync(new URL(file, dir), "utf8");
      expect(text).not.toMatch(/update\s+(public\.)?consent_record\s+set\s+text_version/i);
    }
  });
});
