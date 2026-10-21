import { randomUUID } from "node:crypto";
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

const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const noticeVersion = "art14-activation:v1";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

async function participation(options: { birthDate?: string | null; address?: boolean } = {}) {
  const id = await call(app, "create_participation", {
    projectId: seedProjectIds.werkNord,
    context: pl,
  });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', $4)`,
    [
      id,
      seedProjectIds.werkNord,
      `SYN-${id.slice(-8)}`,
      options.birthDate === undefined ? "1970-01-01" : options.birthDate,
    ],
  );
  await owner.query(
    `insert into participant_details
       (participation_id, project_id, address_street, address_postal_code, address_city, address_country)
     values ($1, $2, $3, $4, $5, $6)`,
    options.address === false
      ? [id, seedProjectIds.werkNord, null, null, null, null]
      : [id, seedProjectIds.werkNord, "Musterweg 1", "10115", "Berlin", "DE"],
  );
  return id;
}

function issue(
  participationId: string,
  options: {
    id?: string;
    hash?: string;
    channel?: "letter" | "sheet" | "in_person";
    replace?: boolean;
    deliveryKind?: "email" | "sms" | null;
    deliveryHash?: string | null;
    identityChecked?: boolean;
    context?: string;
  } = {},
) {
  const channel = options.channel ?? "letter";
  return call(app, "issue_activation_code", {
    participationId,
    codeHash: options.hash ?? "a".repeat(64),
    channel,
    language: "de",
    noticeVersion,
    replaceOpenCode: options.replace ?? false,
    deliveryKind: options.deliveryKind ?? (channel === "in_person" ? "email" : null),
    deliveryAddressHash: options.deliveryHash ?? (channel === "in_person" ? "b".repeat(64) : null),
    identityChecked: options.identityChecked ?? channel === "in_person",
    context: options.context ?? pl,
    id: options.id ?? randomUUID(),
  });
}

async function codes(participationId: string) {
  return (
    await owner.query(
      `select id, code_hash, channel, identity_check, delivery_kind, delivery_status,
              issued_at, expires_at, handed_over_at, revoked_at, revoke_reason
       from activation_code where participation_id = $1 order by issued_at, id`,
      [participationId],
    )
  ).rows;
}

async function notices(participationId: string) {
  return (
    await owner.query(
      `select notice_version, language, method, activation_code_id
       from privacy_notice_delivery where participation_id = $1 order by provided_at, id`,
      [participationId],
    )
  ).rows;
}

describe("activation-code functions (D12–D20)", () => {
  it("stores only the keyed code hash and records a letter's immutable notice evidence", async () => {
    const participationId = await participation();
    const activationCodeId = randomUUID();
    await issue(participationId, { id: activationCodeId });

    const [row] = await codes(participationId);
    expect(row).toMatchObject({
      id: activationCodeId,
      code_hash: "a".repeat(64),
      channel: "letter",
      identity_check: "none",
      delivery_kind: null,
      delivery_status: null,
      handed_over_at: null,
      revoked_at: null,
    });
    expect(row.expires_at.getTime() - row.issued_at.getTime()).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(await notices(participationId)).toEqual([
      {
        notice_version: noticeVersion,
        language: "de",
        method: "letter",
        activation_code_id: activationCodeId,
      },
    ]);
    await expect(
      owner.query(
        "update privacy_notice_delivery set language = 'en' where participation_id = $1",
        [participationId],
      ),
    ).rejects.toMatchObject(failsWith("privacy_notice_immutable"));
  });

  it("keeps a sheet printed until an ID-checked handover supplies the notice", async () => {
    const participationId = await participation({ birthDate: null, address: false });
    const activationCodeId = randomUUID();
    await issue(participationId, {
      id: activationCodeId,
      channel: "sheet",
      hash: "c".repeat(64),
    });
    expect(await notices(participationId)).toEqual([]);

    await call(app, "hand_over_activation_code", { activationCodeId, context: pl });
    expect((await codes(participationId))[0]).toMatchObject({
      identity_check: "photo_id",
      handed_over_at: expect.any(Date),
    });
    expect(await notices(participationId)).toEqual([
      {
        notice_version: noticeVersion,
        language: "de",
        method: "sheet",
        activation_code_id: activationCodeId,
      },
    ]);
    await expect(
      call(app, "hand_over_activation_code", { activationCodeId, context: pl }),
    ).rejects.toMatchObject(failsWith("handover_not_allowed"));
  });

  it("records in-person notice evidence only after a definitive successful send", async () => {
    for (const [outcome, hash] of [
      ["sent", "d"],
      ["failed", "e"],
      ["unknown", "f"],
    ] as const) {
      const participationId = await participation({ birthDate: null, address: false });
      const activationCodeId = randomUUID();
      await issue(participationId, {
        id: activationCodeId,
        hash: hash.repeat(64),
        channel: "in_person",
        deliveryKind: "sms",
      });
      expect(await notices(participationId)).toEqual([]);
      await call(app, "record_activation_delivery", {
        activationCodeId,
        outcome,
        context: pl,
      });
      expect(await notices(participationId)).toHaveLength(outcome === "sent" ? 1 : 0);
      const [row] = await codes(participationId);
      expect(row.delivery_status).toBe(outcome);
      expect(Boolean(row.revoked_at)).toBe(outcome === "failed");
      expect(row.revoke_reason).toBe(outcome === "failed" ? "delivery_failed" : null);
    }
  });

  it("requires a conscious replacement and revokes the old code in the same transaction", async () => {
    const participationId = await participation();
    await issue(participationId, { id: randomUUID(), hash: "1".repeat(64) });
    await expect(
      issue(participationId, { id: randomUUID(), hash: "2".repeat(64) }),
    ).rejects.toMatchObject(failsWith("open_code_exists"));
    await issue(participationId, {
      id: randomUUID(),
      hash: "2".repeat(64),
      replace: true,
    });
    const rows = await codes(participationId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
    expect(rows.find((row) => row.code_hash.startsWith("1"))).toMatchObject({
      revoke_reason: "reissued",
    });
  });

  it("re-checks project, participation, channel and actor preconditions under the lock", async () => {
    const missingBirthDate = await participation({ birthDate: null });
    await expect(issue(missingBirthDate)).rejects.toMatchObject(failsWith("birth_date_required"));
    const missingAddress = await participation({ address: false });
    await expect(issue(missingAddress, { hash: "2".repeat(64) })).rejects.toMatchObject(
      failsWith("address_required"),
    );
    await expect(
      issue(missingAddress, {
        hash: "3".repeat(64),
        channel: "in_person",
        identityChecked: false,
      }),
    ).rejects.toMatchObject(failsWith("identity_not_checked"));
    await expect(
      issue(missingAddress, {
        hash: "4".repeat(64),
        context: auditContext({
          actorType: "user",
          staffUserId: seedStaffUserIds.consultant,
        }),
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));

    await owner.query(
      "update project set status = 'draft', activated_at = null, activated_by = null where id = $1",
      [seedProjectIds.werkNord],
    );
    await expect(
      issue(missingAddress, { hash: "5".repeat(64), channel: "sheet" }),
    ).rejects.toMatchObject(failsWith("project_not_active"));
  });

  it("revokes every open code atomically when the participation becomes terminal", async () => {
    const participationId = await participation();
    await issue(participationId, { id: randomUUID(), hash: "9".repeat(64) });
    await changeStatus(app, participationId, {
      field: "status",
      from: "imported",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-10-21",
    });
    expect((await codes(participationId))[0]).toMatchObject({
      revoked_at: expect.any(Date),
      revoke_reason: "participation_closed",
    });
    await expect(
      issue(participationId, { hash: "8".repeat(64), replace: true }),
    ).rejects.toMatchObject(failsWith("participation_closed"));
    const { rows } = await owner.query(
      `select actor_type, system_job, reason_code from audit_event
       where participation_id = $1 and event_type = 'activation_code_revoked'`,
      [participationId],
    );
    expect(rows).toContainEqual({
      actor_type: "system",
      system_job: "terminal-code-revocation",
      reason_code: "participation_closed",
    });
  });
});

describe("notice-only delivery", () => {
  it("requires an address for a letter but not for an in-person print", async () => {
    const participationId = await participation({ address: false });
    const record = (method: "letter" | "in_person_print") =>
      call(app, "record_privacy_notice", {
        participationId,
        language: "en",
        method,
        noticeVersion,
        context: pl,
      });
    await expect(record("letter")).rejects.toMatchObject(failsWith("address_required"));
    await record("in_person_print");
    expect(await notices(participationId)).toEqual([
      {
        notice_version: noticeVersion,
        language: "en",
        method: "in_person_print",
        activation_code_id: null,
      },
    ]);
  });
});
