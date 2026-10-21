import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds } from "./seed";
import { call, changeStatus, createWave, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// PR 3f (Q130, ADR-0007, Q123): login, channels and lost-access recovery, as transfer_app
// calls them.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = () => randomBytes(32).toString("hex");
const NOTICE = "art14-activation:v1";
const CONSENT = "portal-contact-consent:v1";
const EMAIL = "person@example.invalid";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows;
const events = (participationId: string) =>
  all(
    `select event_type, actor_type, reason_code, details from audit_event
     where participation_id = $1 order by seq`,
    [participationId],
  );
const eventTypes = async (participationId: string) =>
  (await events(participationId)).map((e) => e.event_type);

async function participation(options: { entryWaveId?: string } = {}) {
  const id = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
    ...(options.entryWaveId && { entryWaveId: options.entryWaveId }),
  });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', '1970-01-01')`,
    [id, seedProjectIds.werkNord, `SYN-${id.slice(-8)}`],
  );
  await owner.query(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country, work_email)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE', 'erika@werk.example')`,
    [id, seedProjectIds.werkNord],
  );
  return id;
}

/** Issues a letter code (or a recovery letter) as the PL. */
async function issue(
  participationId: string,
  options: { purpose?: "activation" | "recovery"; replace?: boolean } = {},
) {
  const id = randomUUID();
  const codeHash = hex();
  await call(app, "issue_activation_code", {
    participationId,
    codeHash,
    channel: "letter",
    language: "de",
    noticeVersion: NOTICE,
    replaceOpenCode: options.replace ?? false,
    deliveryKind: null,
    deliveryAddressHash: null,
    identityChecked: false,
    context: pl,
    id,
    purpose: options.purpose ?? "activation",
  });
  return { id, codeHash };
}

/** Runs a letter code through the activation steps with a one-time code to `address`. */
async function redeem(codeHash: string, address = EMAIL, kind: "email" | "sms" = "email") {
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
  const newTokenHash = hex();
  const result = await call(app, "complete_activation", {
    tokenHash,
    newTokenHash,
    noticeVersion: NOTICE,
    consentVersion: CONSENT,
    language: "de",
    channelId: randomUUID(),
    consentId: randomUUID(),
    requestId: "req-3",
    oneTimeCodeHash,
  });
  return { result, tokenHash: newTokenHash };
}

/** An activated participant with one email channel and a live active session. */
async function activated(address = EMAIL) {
  const participationId = await participation();
  const { codeHash } = await issue(participationId);
  const { result, tokenHash } = await redeem(codeHash, address);
  expect(result).toBe("activated");
  const channel = await one(
    "select id, consent_id from participant_channel where participation_id = $1",
    [participationId],
  );
  return { participationId, tokenHash, channelId: channel.id, consentId: channel.consent_id };
}

const requestLogin = (address = EMAIL, kind = "email", codeHash = hex()) =>
  call<string | null>(app, "request_login_code", { kind, address, codeHash, id: randomUUID() });

const login = (codeHash: string, address = EMAIL, kind = "email", tokenHash = hex()) =>
  call(app, "start_participant_session", {
    kind,
    address,
    codeHash,
    tokenHash,
    requestId: "req-login",
  }).then((result) => ({ result, tokenHash }));

const liveSessions = (participationId: string) =>
  all(
    `select token_hash, state from participant_session
     where participation_id = $1 and ended_at is null order by created_at`,
    [participationId],
  );

describe("login codes (ADR-0007)", () => {
  it("creates a login challenge for a live channel's address and none for any other", async () => {
    const { participationId } = await activated();
    const codeHash = hex();
    const challengeId = await requestLogin(EMAIL, "email", codeHash);
    expect(challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await one(
        `select participation_id, purpose, kind, address, code_hash, delivery_status
         from one_time_code_challenge where id = $1`,
        [challengeId],
      ),
    ).toEqual({
      participation_id: participationId,
      purpose: "login",
      kind: "email",
      address: EMAIL,
      code_hash: codeHash,
      delivery_status: "pending",
    });
    // Unknown address, other kind, the imported work email: no code, no row.
    expect(await requestLogin("nobody@example.invalid")).toBeNull();
    expect(await requestLogin("+4915100000000", "sms")).toBeNull();
    expect(await requestLogin("erika@werk.example")).toBeNull();
    expect(
      (
        await one(
          "select count(*)::int as n from one_time_code_challenge where purpose = 'login'",
          [],
        )
      ).n,
    ).toBe(1);
  });

  it("gives a terminal participation's channel no code", async () => {
    const { participationId } = await activated();
    await changeStatus(app, participationId, {
      field: "status",
      from: "contacted",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-10-21",
    });
    expect(await requestLogin()).toBeNull();
  });

  it("counts login and verification codes per address together, five an hour", async () => {
    await activated();
    // The activation sent one verification code to the address.
    for (let i = 0; i < 4; i++) await requestLogin();
    await expect(requestLogin()).rejects.toMatchObject(failsWith("rate_limited"));
  });

  it("supersedes an earlier login code and records the delivery outcome", async () => {
    await activated();
    const first = await requestLogin();
    const second = await requestLogin();
    expect(
      await one("select invalidation_reason from one_time_code_challenge where id = $1", [first]),
    ).toEqual({ invalidation_reason: "superseded" });
    // A failed send of the superseded code doesn't overwrite its reason.
    await call(app, "record_login_code_delivery", { challengeId: first, outcome: "failed" });
    expect(
      await one(
        "select delivery_status, invalidation_reason from one_time_code_challenge where id = $1",
        [first],
      ),
    ).toEqual({ delivery_status: "failed", invalidation_reason: "superseded" });
    await call(app, "record_login_code_delivery", { challengeId: second, outcome: "failed" });
    expect(
      await one("select invalidation_reason from one_time_code_challenge where id = $1", [second]),
    ).toEqual({ invalidation_reason: "delivery_failed" });
    await expect(
      call(app, "record_login_code_delivery", { challengeId: second, outcome: "sent" }),
    ).rejects.toMatchObject(failsWith("invalid_delivery_state"));
    await expect(
      call(app, "record_login_code_delivery", { challengeId: randomUUID(), outcome: "sent" }),
    ).rejects.toMatchObject(failsWith("challenge_not_found"));
  });
});

describe("start_participant_session (ADR-0007)", () => {
  it("logs in with the code sent to the address, once, with the step-up and the audit", async () => {
    const { participationId, channelId } = await activated();
    const codeHash = hex();
    await requestLogin(EMAIL, "email", codeHash);
    const { result, tokenHash } = await login(codeHash);
    expect(result).toBe("ok");
    expect(
      await one(
        `select state, step_up_method, step_up_at is not null as stepped_up, activation_code_id
         from participant_session where token_hash = $1`,
        [tokenHash],
      ),
    ).toEqual({
      state: "active",
      step_up_method: "one_time_code",
      stepped_up: true,
      activation_code_id: null,
    });
    expect((await events(participationId)).at(-1)).toEqual({
      event_type: "participant_login",
      actor_type: "participant",
      reason_code: null,
      details: { method: "one_time_code", channelId },
    });
    // Single use.
    expect((await login(codeHash)).result).toBe("one_time_code_invalid");
  });

  it("answers an unknown address, another address and a wrong code alike; the fifth ends it", async () => {
    const { participationId } = await activated();
    await activated("other@example.invalid");
    const codeHash = hex();
    await requestLogin(EMAIL, "email", codeHash);
    expect((await login(codeHash, "nobody@example.invalid")).result).toBe("one_time_code_invalid");
    // The other account's address with this code: no live code of its own.
    expect((await login(codeHash, "other@example.invalid")).result).toBe("one_time_code_invalid");
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await login(hex())).result);
    expect(results).toEqual([
      "one_time_code_invalid",
      "one_time_code_invalid",
      "one_time_code_invalid",
      "one_time_code_invalid",
      "one_time_code_exhausted",
    ]);
    expect((await login(codeHash)).result).toBe("one_time_code_invalid");
    expect(await eventTypes(participationId)).toContain("one_time_code_exhausted");
    expect(await eventTypes(participationId)).not.toContain("participant_login");
  });

  it("needs a code sent to the address it logs in with", async () => {
    const { participationId, tokenHash } = await activated();
    // A second channel by SMS.
    const smsCode = hex();
    await call(app, "request_channel_code", {
      tokenHash,
      kind: "sms",
      address: "+4915100000000",
      codeHash: smsCode,
      id: randomUUID(),
    });
    await call(app, "add_participant_channel", {
      tokenHash,
      codeHash: smsCode,
      channelId: randomUUID(),
      consentId: randomUUID(),
      consentVersion: CONSENT,
      language: "de",
      requestId: "req-4",
    });
    const codeHash = hex();
    await requestLogin(EMAIL, "email", codeHash);
    expect((await login(codeHash, "+4915100000000", "sms")).result).toBe("one_time_code_invalid");
    expect((await login(codeHash)).result).toBe("ok");
    expect((await liveSessions(participationId)).length).toBe(2);
  });

  it("refuses an expired code", async () => {
    await activated();
    const codeHash = hex();
    await requestLogin(EMAIL, "email", codeHash);
    await owner.query(
      `update one_time_code_challenge set created_at = created_at - interval '16 minutes',
         expires_at = expires_at - interval '16 minutes' where purpose = 'login'`,
    );
    expect((await login(codeHash)).result).toBe("one_time_code_invalid");
  });
});

describe("channels (Q123)", () => {
  async function addChannel(tokenHash: string, address: string, kind = "email") {
    const codeHash = hex();
    await call(app, "request_channel_code", {
      tokenHash,
      kind,
      address,
      codeHash,
      id: randomUUID(),
    });
    const channelId = randomUUID();
    const consentId = randomUUID();
    const result = await call(app, "add_participant_channel", {
      tokenHash,
      codeHash,
      channelId,
      consentId,
      consentVersion: CONSENT,
      language: "en",
      requestId: "req-add",
    });
    return { result, channelId, consentId };
  }

  it("adds a verified channel with its own consent, audited as the participant", async () => {
    const { participationId, tokenHash } = await activated();
    const { result, channelId, consentId } = await addChannel(tokenHash, "+4915100000000", "sms");
    expect(result).toBe("added");
    expect(
      await one(
        `select ch.kind, ch.address, ch.verified_by, c.text_version, c.language, c.actor_type,
           c.channel_id = ch.id as linked
         from participant_channel ch join consent_record c on c.id = ch.consent_id
         where ch.id = $1`,
        [channelId],
      ),
    ).toEqual({
      kind: "sms",
      address: "+4915100000000",
      verified_by: "one_time_code",
      text_version: CONSENT,
      language: "en",
      actor_type: "participant",
      linked: true,
    });
    expect((await events(participationId)).slice(-2)).toEqual([
      {
        event_type: "consent_given",
        actor_type: "participant",
        reason_code: null,
        details: {
          consentId,
          channelId,
          purpose: "portal_contact",
          textVersion: CONSENT,
          language: "en",
        },
      },
      {
        event_type: "contact_channel_added",
        actor_type: "participant",
        reason_code: null,
        details: { channelId, kind: "sms", verifiedBy: "one_time_code" },
      },
    ]);
  });

  it("counts a wrong verification code and refuses a taken, own or work address generically", async () => {
    const { tokenHash } = await activated();
    await activated("other@example.invalid");
    const request = (address: string) =>
      call(app, "request_channel_code", {
        tokenHash,
        kind: "email",
        address,
        codeHash: hex(),
        id: randomUUID(),
      });
    await expect(request("other@example.invalid")).rejects.toMatchObject(
      failsWith("channel_in_use"),
    );
    await expect(request(EMAIL)).rejects.toMatchObject(failsWith("channel_in_use"));
    await expect(request("erika@werk.example")).rejects.toMatchObject(failsWith("channel_invalid"));
    await request("third@example.invalid");
    expect(
      await call(app, "add_participant_channel", {
        tokenHash,
        codeHash: hex(),
        channelId: randomUUID(),
        consentId: randomUUID(),
        consentVersion: CONSENT,
        language: "de",
        requestId: null,
      }),
    ).toBe("one_time_code_invalid");
    expect(
      await one(
        "select failed_attempts from one_time_code_challenge where address = 'third@example.invalid'",
        [],
      ),
    ).toEqual({ failed_attempts: 1 });
  });

  it("refuses an address another account verified meanwhile and keeps the code usable", async () => {
    const { tokenHash } = await activated();
    const codeHash = hex();
    await call(app, "request_channel_code", {
      tokenHash,
      kind: "email",
      address: "late@example.invalid",
      codeHash,
      id: randomUUID(),
    });
    await activated("late@example.invalid");
    await expect(
      call(app, "add_participant_channel", {
        tokenHash,
        codeHash,
        channelId: randomUUID(),
        consentId: randomUUID(),
        consentVersion: CONSENT,
        language: "de",
        requestId: null,
      }),
    ).rejects.toMatchObject(failsWith("channel_in_use"));
    expect(
      await one(
        "select consumed_at from one_time_code_challenge where address = 'late@example.invalid' and purpose = 'channel_verification' and participation_id <> (select participation_id from participant_channel where address = 'late@example.invalid')",
        [],
      ),
    ).toEqual({ consumed_at: null });
  });

  it("removes a channel: consent ended `revoked`, both audited, the session lives on", async () => {
    const { participationId, tokenHash, channelId, consentId } = await activated();
    await addChannel(tokenHash, "+4915100000000", "sms");
    expect(
      await call(app, "remove_participant_channel", { tokenHash, channelId, requestId: "req-rm" }),
    ).toBe(false);
    expect(
      await one(
        `select ch.removed_reason, c.end_reason, ch.removed_at = c.ended_at as same_time
         from participant_channel ch join consent_record c on c.id = ch.consent_id
         where ch.id = $1`,
        [channelId],
      ),
    ).toEqual({ removed_reason: "consent_revoked", end_reason: "revoked", same_time: true });
    expect((await events(participationId)).slice(-2)).toEqual([
      {
        event_type: "consent_ended",
        actor_type: "participant",
        reason_code: "revoked",
        details: { consentId, channelId, purpose: "portal_contact" },
      },
      {
        event_type: "contact_channel_removed",
        actor_type: "participant",
        reason_code: "consent_revoked",
        details: { channelId, kind: "email" },
      },
    ]);
    expect(await liveSessions(participationId)).toHaveLength(1);
    // The address is free again, and no longer logs in.
    expect(await requestLogin()).toBeNull();
    await expect(
      call(app, "remove_participant_channel", { tokenHash, channelId, requestId: null }),
    ).rejects.toMatchObject(failsWith("channel_not_found"));
  });

  it("ends every session of the participant when the last channel goes", async () => {
    const { participationId, tokenHash, channelId } = await activated();
    const codeHash = hex();
    await requestLogin(EMAIL, "email", codeHash);
    await login(codeHash);
    expect(await liveSessions(participationId)).toHaveLength(2);
    expect(
      await call(app, "remove_participant_channel", { tokenHash, channelId, requestId: null }),
    ).toBe(true);
    expect(await liveSessions(participationId)).toEqual([]);
    expect(
      await all(
        "select distinct end_reason from participant_session where participation_id = $1 and end_reason <> 'activated'",
        [participationId],
      ),
    ).toEqual([{ end_reason: "no_channel" }]);
    await expect(
      call(app, "request_channel_code", {
        tokenHash,
        kind: "email",
        address: "new@example.invalid",
        codeHash: hex(),
        id: randomUUID(),
      }),
    ).rejects.toMatchObject(failsWith("session_invalid"));
  });

  it("can't touch another participant's channel or use an activating session", async () => {
    const { tokenHash } = await activated();
    const other = await activated("other@example.invalid");
    await expect(
      call(app, "remove_participant_channel", {
        tokenHash,
        channelId: other.channelId,
        requestId: null,
      }),
    ).rejects.toMatchObject(failsWith("channel_not_found"));
    const participationId = await participation();
    const { codeHash } = await issue(participationId);
    const activating = hex();
    await call(app, "start_activation", { codeHash, tokenHash: activating, requestId: null });
    await expect(
      call(app, "remove_participant_channel", {
        tokenHash: activating,
        channelId: other.channelId,
        requestId: null,
      }),
    ).rejects.toMatchObject(failsWith("session_invalid"));
  });
});

describe("lost-access recovery (Q130)", () => {
  it("refuses a recovery for an account not activated, and an activation code for an activated one", async () => {
    const participationId = await participation();
    await expect(issue(participationId, { purpose: "recovery" })).rejects.toMatchObject(
      failsWith("not_activated"),
    );
    const { participationId: activatedId } = await activated();
    await expect(issue(activatedId)).rejects.toMatchObject(failsWith("already_activated"));
  });

  it("ends all sessions and suspends every live channel at once, audited", async () => {
    const { participationId, channelId } = await activated();
    const loginCode = hex();
    await requestLogin(EMAIL, "email", loginCode);
    const { tokenHash } = await login(loginCode);
    const { id } = await issue(participationId, { purpose: "recovery" });
    expect(await liveSessions(participationId)).toEqual([]);
    expect(
      await one("select end_reason from participant_session where token_hash = $1", [tokenHash]),
    ).toEqual({ end_reason: "lost_access" });
    expect(
      await one("select suspension_reason, removed_at from participant_channel where id = $1", [
        channelId,
      ]),
    ).toEqual({ suspension_reason: "lost_access", removed_at: null });
    const recorded = await events(participationId);
    expect(recorded.find((e) => e.event_type === "contact_channels_suspended")).toEqual({
      event_type: "contact_channels_suspended",
      actor_type: "user",
      reason_code: "lost_access",
      details: { activationCodeId: id, channelIds: [channelId] },
    });
    expect(recorded.find((e) => e.event_type === "activation_code_issued")?.details).toBeDefined();
    expect(
      recorded.filter((e) => e.event_type === "activation_code_issued").at(-1).details.purpose,
    ).toBe("recovery");
    // A suspended channel neither logs in nor gets codes.
    expect(await requestLogin()).toBeNull();
    expect((await login(loginCode)).result).toBe("one_time_code_invalid");
  });

  it("is issued after the cutoff: an activated account stays usable (Q121)", async () => {
    const waveId = await createWave(owner);
    const participationId = await participation({ entryWaveId: waveId });
    const { codeHash } = await issue(participationId);
    expect((await redeem(codeHash)).result).toBe("activated");
    await owner.query(
      `update project_entry_wave set signing_deadline = '2024-12-01', default_tg_start = '2024-12-15',
         default_tg_end = '2025-12-14', latest_entry_date = '2025-01-01' where id = $1`,
      [waveId],
    );
    const recovery = await issue(participationId, { purpose: "recovery" });
    expect((await redeem(recovery.codeHash, "new@example.invalid")).result).toBe("recovered");
  });

  it("completes by replacing the channels: old consents end `lost_access_replaced`, no status change", async () => {
    const { participationId, channelId, consentId } = await activated();
    const statusBefore = await one(
      "select status, status_version from participation where id = $1",
      [participationId],
    );
    const { id, codeHash } = await issue(participationId, { purpose: "recovery" });
    const before = (await events(participationId)).length;
    const { result, tokenHash } = await redeem(codeHash, "+4915100000000", "sms");
    expect(result).toBe("recovered");
    expect(
      await one("select status, status_version from participation where id = $1", [
        participationId,
      ]),
    ).toEqual(statusBefore);
    expect(
      await one(
        `select ch.removed_reason, ch.suspension_reason, c.end_reason
         from participant_channel ch join consent_record c on c.id = ch.consent_id
         where ch.id = $1`,
        [channelId],
      ),
    ).toEqual({
      removed_reason: "lost_access_replaced",
      suspension_reason: "lost_access",
      end_reason: "lost_access_replaced",
    });
    const live = await all(
      "select id, kind, address from participant_channel where participation_id = $1 and removed_at is null",
      [participationId],
    );
    expect(live).toEqual([{ id: expect.any(String), kind: "sms", address: "+4915100000000" }]);
    const added = (await events(participationId)).slice(before);
    expect(added.map((e) => [e.event_type, e.reason_code])).toEqual([
      ["consent_ended", "lost_access_replaced"],
      ["contact_channel_removed", "lost_access_replaced"],
      ["consent_given", null],
      ["contact_channel_added", null],
      ["participant_login", null],
    ]);
    expect(added[0].details).toEqual({ consentId, channelId, purpose: "portal_contact" });
    expect(added.at(-1).details).toEqual({ method: "recovery_code", activationCodeId: id });
    expect(added.every((e) => e.actor_type === "participant")).toBe(true);
    expect(
      await one("select used_at is not null as used from activation_code where id = $1", [id]),
    ).toEqual({ used: true });
    expect(await liveSessions(participationId)).toEqual([
      { token_hash: tokenHash, state: "active" },
    ]);
    // The account still records its first activation.
    expect(
      await one(
        "select activation_code_id <> $2 as first from participant_account where participation_id = $1",
        [participationId, id],
      ),
    ).toEqual({ first: true });
  });

  it("may register the participant's own old address again", async () => {
    const { participationId } = await activated();
    const { codeHash } = await issue(participationId, { purpose: "recovery" });
    expect((await redeem(codeHash, EMAIL)).result).toBe("recovered");
    expect(
      await all(
        "select address, removed_reason from participant_channel where participation_id = $1 order by verified_at",
        [participationId],
      ),
    ).toEqual([
      { address: EMAIL, removed_reason: "lost_access_replaced" },
      { address: EMAIL, removed_reason: null },
    ]);
    const codeHash2 = hex();
    await requestLogin(EMAIL, "email", codeHash2);
    expect((await login(codeHash2)).result).toBe("ok");
  });

  it("leaves the channels suspended when the recovery code expires", async () => {
    const { participationId, channelId } = await activated();
    const { id, codeHash } = await issue(participationId, { purpose: "recovery" });
    await owner.query(
      `update activation_code set issued_at = issued_at - interval '31 days',
         expires_at = expires_at - interval '31 days' where id = $1`,
      [id],
    );
    await expect(
      call(app, "start_activation", { codeHash, tokenHash: hex(), requestId: null }),
    ).resolves.toBeNull();
    expect(
      await one(
        "select suspended_at is not null as suspended from participant_channel where id = $1",
        [channelId],
      ),
    ).toEqual({ suspended: true });
    expect(await requestLogin()).toBeNull();
    // Staff may issue the next one; nothing suspended twice.
    await issue(participationId, { purpose: "recovery", replace: true });
    const suspended = (await events(participationId)).filter(
      (e) => e.event_type === "contact_channels_suspended",
    );
    expect(suspended.at(-1).details.channelIds).toEqual([]);
  });

  it("starts a recovery session for the activated account", async () => {
    const { participationId } = await activated();
    const { codeHash } = await issue(participationId, { purpose: "recovery" });
    const tokenHash = hex();
    expect(
      await call(app, "start_activation", { codeHash, tokenHash, requestId: null }),
    ).toMatchObject({ purpose: "recovery", channel: "letter", needsBirthDate: true });
  });
});
