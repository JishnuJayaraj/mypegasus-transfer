import { portalLimits } from "@transfer/domain";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds } from "./seed";
import { call, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// The SQL side of portalLimits (packages/domain/src/portal/limits.ts; ADR-0007, limits): the
// functions and CHECKs hard-code the values, this test holds them to the constants.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const hex = () => randomBytes(32).toString("hex");
const { activationCode, oneTimeCode, session, stepUp } = portalLimits;

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

/** A letter's activating session, past the birth-date step. */
async function activating() {
  const participationId = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
  });
  await owner.query(
    `insert into participant_identity (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', '1970-01-01')`,
    [participationId, seedProjectIds.werkNord, `SYN-${participationId.slice(-8)}`],
  );
  await owner.query(
    `insert into participant_details (participation_id, project_id, address_street, address_postal_code, address_city, address_country)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE')`,
    [participationId, seedProjectIds.werkNord],
  );
  const codeHash = hex();
  const codeId = randomUUID();
  await call(app, "issue_activation_code", {
    participationId,
    codeHash,
    channel: "letter",
    language: "de",
    noticeVersion: "art14-activation:v1",
    replaceOpenCode: false,
    deliveryKind: null,
    deliveryAddressHash: null,
    identityChecked: false,
    context: pl,
    id: codeId,
  });
  const tokenHash = hex();
  await call(app, "start_activation", { codeHash, tokenHash, requestId: null });
  return { participationId, codeId, tokenHash };
}

const minutesAgo = (minutes: number) => `now() - interval '${minutes} minutes'`;

describe("portal limits in SQL", () => {
  it("lock an activation code at the configured failure and keep it 30 days", async () => {
    const { codeId, tokenHash } = await activating();
    const results = [];
    for (let i = 0; i < activationCode.failuresToLock; i++) {
      results.push(
        await call(app, "check_activation_birth_date", {
          tokenHash,
          birthDate: "1999-09-09",
          requestId: null,
        }),
      );
    }
    expect(results.at(-1)).toBe("locked");
    expect(results.filter((r) => r === "mismatch")).toHaveLength(activationCode.failuresToLock - 1);
    const { rows } = await owner.query(
      "select extract(epoch from expires_at - issued_at) / 86400 as days from activation_code where id = $1",
      [codeId],
    );
    expect(Number(rows[0].days)).toBe(activationCode.validityDays);
  });

  it("give one-time codes their lifetime, hourly limit per address and failure count", async () => {
    const { tokenHash, participationId } = await activating();
    await call(app, "check_activation_birth_date", {
      tokenHash,
      birthDate: "1970-01-01",
      requestId: null,
    });
    const send = () =>
      call(app, "create_one_time_code", {
        tokenHash,
        kind: "sms",
        address: "+4915100000000",
        codeHash: hex(),
        id: randomUUID(),
      });
    const expiresAt = await send();
    const { rows } = await owner.query(
      "select extract(epoch from expires_at - created_at) / 60 as minutes from one_time_code_challenge",
    );
    expect(Number(rows[0].minutes)).toBe(oneTimeCode.validityMinutes);
    expect(expiresAt).toBeInstanceOf(Date);
    for (let i = 1; i < oneTimeCode.requestsPerAddressPerHour; i++) await send();
    await expect(send()).rejects.toMatchObject({ message: "rate_limited" });
    // An hour later the address may have codes again.
    await owner.query(
      `update one_time_code_challenge set created_at = created_at - interval '61 minutes',
         expires_at = expires_at - interval '61 minutes'`,
    );
    await send();

    const results = [];
    for (let i = 0; i < oneTimeCode.failures; i++) {
      results.push(
        await call(app, "complete_activation", {
          tokenHash,
          newTokenHash: hex(),
          noticeVersion: "art14-activation:v1",
          consentVersion: "portal-contact-consent:v1",
          language: "de",
          channelId: randomUUID(),
          consentId: randomUUID(),
          requestId: null,
          oneTimeCodeHash: hex(),
        }),
      );
    }
    expect(results.at(-1)).toBe("one_time_code_exhausted");
    expect(
      (
        await owner.query(
          "select max(failed_attempts) as n from one_time_code_challenge where participation_id = $1",
          [participationId],
        )
      ).rows[0].n,
    ).toBe(oneTimeCode.failures);
  });

  it.each([
    ["idle", session.idleMinutes, "last_seen_at"],
    ["absolute", session.absoluteHours * 60, "created_at"],
  ] as const)("end a session after its %s limit", async (_label, minutes, column) => {
    const { tokenHash } = await activating();
    const check = () =>
      call(app, "check_activation_birth_date", {
        tokenHash,
        birthDate: "1970-01-01",
        requestId: null,
      });
    const age = (m: number) =>
      owner.query(
        `update participant_session set ${column} = ${minutesAgo(m)}${
          column === "created_at" ? ", last_seen_at = now()" : ""
        } where token_hash = $1`,
        [tokenHash],
      );
    await age(minutes + 1);
    await expect(check()).rejects.toMatchObject({ message: "session_invalid" });
    await age(minutes - 1);
    await expect(check()).resolves.toBe("ok");
  });

  it("end a session at the configured wrong birth date of its step-up (Q137)", async () => {
    const { rows } = await owner.query(
      `select p.prosrc, (select pg_get_constraintdef(c.oid) from pg_constraint c
         where c.conname = 'participant_session_step_up_failures') as "check"
       from pg_proc p where p.proname = 'fail_step_up'`,
    );
    expect(rows[0].prosrc).toContain(`IF n < ${stepUp.birthDateFailures} THEN`);
    expect(rows[0].check).toContain(`<= ${stepUp.birthDateFailures}`);
  });
});
