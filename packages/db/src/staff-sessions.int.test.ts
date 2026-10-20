import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedStaffUserIds } from "./seed";
import { call, resetTestDatabase, testDatabaseUrls } from "./testing";

// Slice 3 plan, D1–D6 (PR 3b): the staff session store, identity binding and refused logins,
// written only by their SECURITY DEFINER functions, each with its staff audit event.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });

const issuer = "https://login.example.org/tenant/v2.0";
const pl = seedStaffUserIds.projectLead;
const consultant = seedStaffUserIds.consultant;
const requestId = "0c4b1f4e-1111-4000-8000-000000000001";
const permissionDenied = { code: "42501" };
const refused = (code: string) => ({ code: "P0001", message: code });

const newHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

const start = (client: Client, args: Record<string, unknown> = {}) =>
  call<Date>(client, "start_staff_session", {
    staffUserId: pl,
    tokenHash: newHash(),
    method: "dev",
    oidcIssuer: null,
    oidcSubject: null,
    supersededTokenHash: null,
    requestId,
    ...args,
  });

const sessions = async () =>
  (
    await owner.query(
      `select staff_user_id, end_reason, ended_at is not null as ended,
         expires_at = created_at + interval '8 hours' as eight_hours
       from staff_session order by created_at, token_hash`,
    )
  ).rows;

const insertSession = (columns: string) =>
  owner.query(
    `insert into staff_session (token_hash, staff_user_id, expires_at, ended_at, end_reason) values ${columns}`,
  );

const events = async () =>
  (
    await owner.query(
      `select event_type, actor_staff_user_id, subject_staff_user_id, reason_code, details, request_id
       from staff_audit_event order by seq`,
    )
  ).rows;

const record = (args: Record<string, unknown>) =>
  call(app, "record_staff_login_refused", { method: "oidc", requestId, ...args });
const checkViolation = (constraint: string) => ({ code: "23514", constraint });
const insertEvent = async (values: Record<string, unknown>) => {
  const columns = Object.keys(values);
  await owner.query("begin");
  try {
    await owner.query(
      `insert into staff_audit_event (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      columns.map((c) => (c === "details" ? JSON.stringify(values[c]) : values[c])),
    );
  } finally {
    await owner.query("rollback");
  }
};

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, keepSessions: false }));

describe("start_staff_session (D1, D2)", () => {
  it("stores the token's hash for 8 hours of database time and writes staff_login", async () => {
    const tokenHash = newHash();
    const before = (await owner.query("select now() as now")).rows[0].now as Date;
    const expiresAt = await start(app, { tokenHash });
    expect(expiresAt.getTime() - before.getTime()).toBeGreaterThanOrEqual(8 * 3600 * 1000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(8 * 3600 * 1000 + 5000);
    const { rows } = await app.query(
      "select staff_user_id from staff_session where token_hash = $1",
      [tokenHash],
    );
    expect(rows).toEqual([{ staff_user_id: pl }]);
    expect(await sessions()).toEqual([
      { staff_user_id: pl, end_reason: null, ended: false, eight_hours: true },
    ]);
    expect(await events()).toEqual([
      {
        event_type: "staff_login",
        actor_staff_user_id: pl,
        subject_staff_user_id: pl,
        reason_code: null,
        details: { method: "dev" },
        request_id: requestId,
      },
    ]);
  });

  it("ends a superseded live session of the same browser", async () => {
    const old = newHash();
    await start(app, { tokenHash: old });
    await start(app, { staffUserId: consultant, supersededTokenHash: old });
    expect(await sessions()).toEqual([
      expect.objectContaining({ staff_user_id: pl, end_reason: "superseded", ended: true }),
      expect.objectContaining({ staff_user_id: consultant, end_reason: null, ended: false }),
    ]);
  });

  it("starts an OIDC session only for the identity bound to the account", async () => {
    await owner.query(
      "update staff_user set oidc_issuer = $1, oidc_subject = 'sub-1' where id = $2",
      [issuer, pl],
    );
    const oidc = { method: "oidc", oidcIssuer: issuer };
    await expect(start(app, { ...oidc, oidcSubject: "sub-2" })).rejects.toMatchObject(
      refused("identity_mismatch"),
    );
    await expect(
      start(app, { ...oidc, staffUserId: consultant, oidcSubject: "sub-1" }),
    ).rejects.toMatchObject(refused("identity_mismatch"));
    await start(app, { ...oidc, oidcSubject: "sub-1" });
    expect((await events()).map((e) => e.details)).toEqual([{ method: "oidc" }]);
  });

  it("refuses unknown and deactivated accounts and writes nothing", async () => {
    await expect(
      start(app, { staffUserId: "00000000-0000-4000-8000-0000000000ff" }),
    ).rejects.toMatchObject(refused("unknown_account"));
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [pl]);
    await expect(start(app)).rejects.toMatchObject(refused("account_deactivated"));
    expect(await sessions()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it.each([
    ["a token hash that isn't a SHA-256", { tokenHash: "abc" }],
    ["an upper-case hash", { tokenHash: newHash().toUpperCase() }],
    ["an unknown method", { method: "password" }],
    ["an OIDC login without its identity", { method: "oidc" }],
    ["a dev login with an identity", { oidcIssuer: issuer, oidcSubject: "sub-1" }],
  ])("refuses %s (invalid_argument)", async (_label, args) => {
    await expect(start(app, args)).rejects.toMatchObject(refused("invalid_argument"));
  });

  it("is atomic: a failing audit event leaves no session and supersedes nothing", async () => {
    const old = newHash();
    await start(app, { tokenHash: old });
    await expect(
      start(app, { supersededTokenHash: old, requestId: "not an id" }),
    ).rejects.toMatchObject({ code: "23514", constraint: "staff_audit_event_request_id_is_id" });
    expect(await sessions()).toEqual([expect.objectContaining({ ended: false })]);
    expect(await events()).toHaveLength(1);
  });
});

describe("end_staff_session (D2)", () => {
  it("ends the live session with logout and writes staff_logout", async () => {
    const tokenHash = newHash();
    await start(app, { tokenHash });
    expect(await call<boolean>(app, "end_staff_session", { tokenHash, requestId })).toBe(true);
    expect(await sessions()).toEqual([
      expect.objectContaining({ end_reason: "logout", ended: true }),
    ]);
    expect((await events()).at(-1)).toEqual({
      event_type: "staff_logout",
      actor_staff_user_id: pl,
      subject_staff_user_id: pl,
      reason_code: null,
      details: {},
      request_id: requestId,
    });
  });

  it("answers false without an event for an unknown, ended or expired session", async () => {
    const ended = newHash();
    await start(app, { tokenHash: ended });
    await call(app, "end_staff_session", { tokenHash: ended, requestId });
    const expired = newHash();
    await start(app, { tokenHash: expired });
    await owner.query(
      `update staff_session set created_at = now() - interval '9 hours',
         expires_at = now() - interval '1 hour' where token_hash = $1`,
      [expired],
    );
    const before = (await events()).length;
    for (const tokenHash of [newHash(), ended, expired]) {
      expect(await call<boolean>(app, "end_staff_session", { tokenHash, requestId })).toBe(false);
    }
    expect(await events()).toHaveLength(before);
  });
});

const bind = (args: Record<string, unknown> = {}) =>
  call(app, "bind_staff_identity", {
    staffUserId: pl,
    oidcIssuer: issuer,
    oidcSubject: "sub-1",
    matchedBy: "email",
    requestId,
    ...args,
  });
const identity = async (id: string) =>
  (await app.query("select oidc_issuer, oidc_subject from staff_user where id = $1", [id])).rows[0];

describe("bind_staff_identity (D5)", () => {
  it("binds an unbound account once and writes staff_identity_bound with the claim", async () => {
    await bind({ matchedBy: "preferred_username" });
    expect(await identity(pl)).toEqual({ oidc_issuer: issuer, oidc_subject: "sub-1" });
    expect(await events()).toEqual([
      {
        event_type: "staff_identity_bound",
        actor_staff_user_id: pl,
        subject_staff_user_id: pl,
        reason_code: null,
        details: { matchedBy: "preferred_username" },
        request_id: requestId,
      },
    ]);
  });

  it("refuses a bound account, an identity bound elsewhere, unknown and deactivated accounts", async () => {
    await bind();
    await expect(bind({ oidcSubject: "sub-2" })).rejects.toMatchObject(
      refused("identity_mismatch"),
    );
    await expect(bind({ staffUserId: consultant })).rejects.toMatchObject(
      refused("identity_mismatch"),
    );
    await expect(
      bind({ staffUserId: "00000000-0000-4000-8000-0000000000ff" }),
    ).rejects.toMatchObject(refused("unknown_account"));
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [consultant]);
    await expect(bind({ staffUserId: consultant, oidcSubject: "sub-3" })).rejects.toMatchObject(
      refused("account_deactivated"),
    );
    expect(await identity(consultant)).toEqual({ oidc_issuer: null, oidc_subject: null });
    expect(await events()).toHaveLength(1);
  });

  it.each([
    ["an issuer that isn't a URL", { oidcIssuer: "login.example.org" }],
    ["a subject with a space", { oidcSubject: "sub 1" }],
    ["an empty subject", { oidcSubject: "" }],
    ["a subject over 255 characters", { oidcSubject: "s".repeat(256) }],
    ["an unknown claim", { matchedBy: "upn" }],
  ])("refuses %s (invalid_argument)", async (_label, args) => {
    await expect(bind(args)).rejects.toMatchObject(refused("invalid_argument"));
  });
});

describe("record_staff_login_refused (D5, D6)", () => {
  it("records the code, and the matched account only where there is one", async () => {
    await record({ reasonCode: "unknown_account", subjectStaffUserId: null });
    await record({ reasonCode: "identity_mismatch", subjectStaffUserId: pl });
    await record({ reasonCode: "account_deactivated", subjectStaffUserId: pl, method: "dev" });
    expect(await events()).toEqual([
      {
        event_type: "staff_login_refused",
        actor_staff_user_id: null,
        subject_staff_user_id: null,
        reason_code: "unknown_account",
        details: { method: "oidc" },
        request_id: requestId,
      },
      expect.objectContaining({ subject_staff_user_id: pl, reason_code: "identity_mismatch" }),
      expect.objectContaining({ reason_code: "account_deactivated", details: { method: "dev" } }),
    ]);
  });

  it.each([
    ["another code", { reasonCode: "wrong_password", subjectStaffUserId: null }],
    [
      "an unknown account with a subject",
      { reasonCode: "unknown_account", subjectStaffUserId: pl },
    ],
    ["a mismatch without a subject", { reasonCode: "identity_mismatch", subjectStaffUserId: null }],
    [
      "a subject that doesn't exist",
      {
        reasonCode: "identity_mismatch",
        subjectStaffUserId: "00000000-0000-4000-8000-0000000000ff",
      },
    ],
    ["an unknown method", { reasonCode: "unknown_account", subjectStaffUserId: null, method: "x" }],
  ])("refuses %s (invalid_argument)", async (_label, args) => {
    await expect(record(args)).rejects.toMatchObject(refused("invalid_argument"));
  });
});

describe("transfer_app and the staff session tables (D2, D6)", () => {
  beforeEach(() => start(app));

  it("may select sessions and nothing of the staff audit trail", async () => {
    expect((await app.query("select staff_user_id from staff_session")).rows).toEqual([
      { staff_user_id: pl },
    ]);
    await expect(app.query("select * from staff_audit_event")).rejects.toMatchObject(
      permissionDenied,
    );
  });

  it.each([
    [
      "insert into staff_session",
      `insert into staff_session (token_hash, staff_user_id, expires_at) values ('${newHash()}', '${pl}', now() + interval '8 hours')`,
    ],
    ["update staff_session", "update staff_session set ended_at = null"],
    ["update staff_session expiry", "update staff_session set expires_at = now()"],
    ["delete from staff_session", "delete from staff_session"],
    ["truncate staff_session", "truncate staff_session"],
    [
      "insert into staff_audit_event",
      "insert into staff_audit_event (event_type, reason_code) values ('staff_login_refused', 'unknown_account')",
    ],
    ["update staff_audit_event", "update staff_audit_event set reason_code = reason_code"],
    ["delete from staff_audit_event", "delete from staff_audit_event"],
    ["truncate staff_audit_event", "truncate staff_audit_event"],
    ["bind an identity directly", "update staff_user set oidc_subject = 'x'"],
    ["deactivate an account directly", "update staff_user set deactivated_at = now()"],
  ])("may not %s (42501)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });
});

describe("the staff tables themselves (D2, D6)", () => {
  it("holds a session to 8 hours, a SHA-256 key and a reason for every end", async () => {
    await expect(
      insertSession(`('${newHash()}', '${pl}', now() + interval '9 hours', null, null)`),
    ).rejects.toMatchObject(checkViolation("staff_session_lifetime"));
    await expect(
      insertSession(`('not-a-hash', '${pl}', now() + interval '8 hours', null, null)`),
    ).rejects.toMatchObject(checkViolation("staff_session_token_hash"));
    await expect(
      insertSession(`('${newHash()}', '${pl}', now() + interval '8 hours', now(), null)`),
    ).rejects.toMatchObject(checkViolation("staff_session_ended"));
  });

  it.each([
    [
      "a refusal naming an email",
      {
        event_type: "staff_login_refused",
        reason_code: "unknown_account",
        details: { email: "a@example.org" },
      },
      "staff_audit_event_details_ids_and_codes",
    ],
    [
      "a refusal with a sentence as its code",
      { event_type: "staff_login_refused", reason_code: "Kein Konto gefunden" },
      "staff_audit_event_reason_code_is_code",
    ],
    [
      "a refusal with an actor",
      {
        event_type: "staff_login_refused",
        reason_code: "unknown_account",
        actor_staff_user_id: pl,
      },
      "staff_audit_event_shape",
    ],
    [
      "an unknown account with a subject",
      {
        event_type: "staff_login_refused",
        reason_code: "unknown_account",
        subject_staff_user_id: pl,
      },
      "staff_audit_event_shape",
    ],
    [
      "a login of someone else",
      { event_type: "staff_login", actor_staff_user_id: pl, subject_staff_user_id: consultant },
      "staff_audit_event_shape",
    ],
    [
      "a login with a reason code",
      {
        event_type: "staff_login",
        actor_staff_user_id: pl,
        subject_staff_user_id: pl,
        reason_code: "unknown_account",
      },
      "staff_audit_event_shape",
    ],
    [
      "a request id that isn't an id",
      {
        event_type: "staff_logout",
        actor_staff_user_id: pl,
        subject_staff_user_id: pl,
        request_id: "a b",
      },
      "staff_audit_event_request_id_is_id",
    ],
  ])("refuses %s", async (_label, values, constraint) => {
    await expect(insertEvent(values)).rejects.toMatchObject(checkViolation(constraint));
  });

  it("keeps one account per email, compared case-insensitively, and complete identities", async () => {
    await expect(
      owner.query(
        "insert into staff_user (display_name, email) values ('X', 'Project-Lead@Example.org')",
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "staff_user_email_lower_key" });
    await expect(
      owner.query("update staff_user set oidc_subject = 'x' where id = $1", [pl]),
    ).rejects.toMatchObject(checkViolation("staff_user_oidc_identity_complete"));
  });
});
