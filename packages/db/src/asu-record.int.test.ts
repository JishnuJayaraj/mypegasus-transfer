import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// The ASU record (process-and-lifecycle.md, Arbeitsuchendmeldung; data-protection.md, the ASU
// record; Q184, Q186; readings Q201) as transfer_app calls the functions: the route, the
// registration with the PL's attestation, the BA confirmation's upload, review and link, the
// knowledge date. Synthetic values only; the BA-Kundennummer below is made up.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { werkNord, verwaltung } = seedProjectIds;
const key = hex();
const keyId = hex(8);
const number = "123A456789";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const today = async () => (await one("select berlin_today()::text as d")).d as string;
const daysAgo = async (n: number) =>
  (await one(`select (berlin_today() - $1::int)::text as d`, [n])).d as string;

/** An informed participation of Werk Nord (`ta_tg`), assigned to the consultant. */
async function participation(projectId: string = werkNord) {
  const id = await informedParticipation(app, { projectId });
  await call(app, "assign_participations", {
    projectId,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

const route = (id: string, channel: string, version: number, context = pl) =>
  call<number>(app, "set_asu_route", { context, participationId: id, channel, version });

const register = (
  id: string,
  registeredOn: string,
  attestation?: { customerNumber: string; source: string },
  context = attestation ? pl : asConsultant,
) =>
  call(app, "record_asu_registration", {
    context,
    participationId: id,
    id: randomUUID(),
    registeredOn,
    ...(attestation && {
      customerNumber: attestation.customerNumber,
      attestationSource: attestation.source,
      key,
      keyId,
    }),
  });

/** A BA confirmation added by `context`; its id. */
function proof(id: string, context = asConsultant) {
  return call(app, "add_document", {
    context,
    participationId: id,
    id: randomUUID(),
    type: "asu_proof",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
  });
}

const review = (documentId: string, decision = "accepted", context = asConsultant) =>
  call(app, "review_document", {
    context,
    documentId,
    decision,
    reason: decision === "rejected" ? "unreadable" : null,
  });

const link = (id: string, registrationId: string, documentId: string, context = asConsultant) =>
  call(app, "link_asu_proof", { context, participationId: id, registrationId, documentId });

const remove = (documentId: string, reason: string, context = pl) =>
  call(app, "delete_document", { context, documentId, reason });

/** A participation on `online_self` with a registration of 20 days ago, without proof. */
async function registered() {
  const id = await participation();
  await route(id, "online_self", 0);
  const registrationId = await register(id, await daysAgo(20));
  return { id, registrationId };
}

const set = (id: string, knowledgeDate: string | null, previous: string | null, context = pl) =>
  call(app, "set_knowledge_date", { context, participationId: id, knowledgeDate, previous });

const events = (id: string, types: string[]) =>
  all(
    `select event_type::text as type, details from audit_event
     where participation_id = $1 and event_type::text = any($2) order by occurred_at, id`,
    [id, types],
  );

describe("set_asu_route (process-and-lifecycle.md, Arbeitsuchendmeldung)", () => {
  it("is set by the PL or the assigned consultant with the version read, audited", async () => {
    const id = await participation();
    expect(await route(id, "kug_200b", 0)).toBe(1);
    expect(await route(id, "online_self", 1, asConsultant)).toBe(2);
    // Unchanged: nothing written.
    expect(await route(id, "online_self", 2)).toBe(2);
    expect(await events(id, ["asu_route_set"])).toEqual([
      { type: "asu_route_set", details: { channel: "kug_200b" } },
      { type: "asu_route_set", details: { channel: "online_self", previousChannel: "kug_200b" } },
    ]);
    await expect(route(id, "in_person", 1)).rejects.toMatchObject(failsWith("stale_revision"));
  });

  it("refuses back office and a ta_only project", async () => {
    const id = await participation();
    await expect(route(id, "kug_200b", 0, asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const taOnly = await participation(verwaltung);
    await expect(route(taOnly, "online_self", 0)).rejects.toMatchObject(
      failsWith("asu_not_applicable"),
    );
  });

  it("is fixed once a registration is recorded (an entry error is corrected through an approved correction)", async () => {
    const id = await participation();
    await route(id, "online_self", 0);
    await register(id, await today());
    await expect(route(id, "in_person", 1)).rejects.toMatchObject(failsWith("asu_registered"));
  });

  it("refuses a terminal participation", async () => {
    const id = await participation();
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await today(),
    });
    await expect(route(id, "online_self", 0)).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });
});

describe("record_asu_registration (process-and-lifecycle.md, Arbeitsuchendmeldung; Q184, Q186)", () => {
  it("needs a direct route, a date not after today and is recorded once", async () => {
    const id = await participation();
    await expect(register(id, await today())).rejects.toMatchObject(failsWith("asu_route_unset"));
    await route(id, "kug_200b", 0);
    await expect(register(id, await today())).rejects.toMatchObject(failsWith("asu_route_kug200b"));
    await route(id, "online_self", 1);
    const tomorrow = await daysAgo(-1);
    await expect(register(id, tomorrow)).rejects.toMatchObject(
      failsWith("registered_on_in_future"),
    );
    const registeredOn = await daysAgo(10);
    const registrationId = await register(id, registeredOn);
    await expect(register(id, registeredOn)).rejects.toMatchObject(failsWith("asu_registered"));
    expect(
      await one(
        `select channel::text, registered_on, proof_kind, recorded_by from asu_registration
         where id = $1`,
        [registrationId],
      ),
    ).toEqual({
      channel: "online_self",
      registered_on: registeredOn,
      proof_kind: null,
      recorded_by: consultant,
    });
  });

  it("attests by the PL only: the number encrypted, written once audited, never in an event", async () => {
    const id = await participation();
    await route(id, "online_self", 0);
    const attestation = {
      customerNumber: ` ${number.toLowerCase()} `,
      source: "ba_online_account_inspected",
    };
    await expect(register(id, await today(), attestation, asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const registeredOn = await daysAgo(3);
    const registrationId = await register(id, registeredOn, attestation);
    expect(
      await one(
        `select proof_kind::text, attestation_source::text, proof_linked_by,
           proof_linked_at = recorded_at as at_once from asu_registration where id = $1`,
        [registrationId],
      ),
    ).toEqual({
      proof_kind: "ba_customer_number",
      attestation_source: "ba_online_account_inspected",
      proof_linked_by: seedStaffUserIds.projectLead,
      at_once: true,
    });
    const stored = await one(
      `select ba_customer_number_present as present, key_id,
         position($2::bytea in ba_customer_number) as plain,
         crypto.pgp_sym_decrypt(ba_customer_number, $3)::jsonb ->> 'v' as value
       from participant_identifier_data where participation_id = $1`,
      [id, Buffer.from(number), key],
    );
    expect(stored).toEqual({ present: true, key_id: keyId, plain: 0, value: number });
    const audit = await events(id, ["sensitive_write", "asu_registration_recorded"]);
    expect(audit).toEqual([
      { type: "sensitive_write", details: { key: "baCustomerNumber" } },
      {
        type: "asu_registration_recorded",
        details: {
          registrationId,
          channel: "online_self",
          registeredOn,
          proofKind: "ba_customer_number",
          attestationSource: "ba_online_account_inspected",
        },
      },
    ]);
    expect(JSON.stringify(await all("select * from audit_event"))).not.toContain(number);
  });

  it("refuses a malformed number or a half attestation without echoing it", async () => {
    const id = await participation();
    await route(id, "in_person", 0);
    for (const customerNumber of ["12", "123-456-789", "X".repeat(21)]) {
      const error = await register(id, await today(), {
        customerNumber,
        source: "ba_document_inspected",
      }).catch((e: Error) => e);
      expect(error).toMatchObject(failsWith("invalid_argument"));
      expect(JSON.stringify(error)).not.toContain(customerNumber);
    }
    await expect(
      call(app, "record_asu_registration", {
        context: pl,
        participationId: id,
        id: randomUUID(),
        registeredOn: await today(),
        customerNumber: number,
        key,
        keyId,
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });

  it("refuses another key over the row's (key_unknown)", async () => {
    const id = await participation();
    await route(id, "online_self", 0);
    await owner.query(
      `insert into participant_identifier_data (participation_id, project_id, key_id)
       values ($1, $2, $3)`,
      [id, werkNord, hex(8)],
    );
    await expect(
      register(id, await today(), { customerNumber: number, source: "ba_confirmed_by_phone" }),
    ).rejects.toMatchObject(failsWith("key_unknown"));
  });

  it("is never readable by transfer_app as a ciphertext", async () => {
    await expect(
      app.query("select ba_customer_number from participant_identifier_data"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query("select ba_customer_number_present from participant_identifier_data"),
    ).resolves.toBeTruthy();
  });
});

describe("the BA confirmation (asu_proof, catalog version 5; Q186)", () => {
  it("is added by the consultant and the PL in normal mode, reviewed by the consultant only", async () => {
    const id = await participation();
    const byPl = await proof(id, pl);
    await expect(review(byPl, "accepted", pl)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await review(byPl);
    await expect(proof(id, asBackOffice)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    const assisted = auditContext({
      actorType: "user",
      staffUserId: seedStaffUserIds.projectLead,
      onBehalfOf: id,
    });
    await expect(proof(id, assisted)).rejects.toBeTruthy();
  });

  it("is deleted by the PL before its review only, as wrong_person or wrong_file", async () => {
    const id = await participation();
    const first = await proof(id);
    await expect(remove(first, "duplicate")).rejects.toMatchObject(
      failsWith("delete_reason_not_allowed"),
    );
    await expect(remove(first, "wrong_file", asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await remove(first, "wrong_file");
    const second = await proof(id);
    await review(second);
    await expect(remove(second, "wrong_file")).rejects.toMatchObject(
      failsWith("document_immutable"),
    );
  });
});

describe("link_asu_proof (process-and-lifecycle.md, Arbeitsuchendmeldung; Q201)", () => {
  it("links an accepted proof by the consultant; a proof accepted earlier counts from today (the snapshot rule)", async () => {
    const { id, registrationId } = await registered();
    const documentId = await proof(id);
    await review(documentId);
    // Accepted yesterday: the link today completes the fact.
    await owner.query(`update document set reviewed_at = now() - interval '1 day' where id = $1`, [
      documentId,
    ]);
    await expect(link(id, registrationId, documentId, pl)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await link(id, registrationId, documentId);
    const row = await one(
      `select r.proof_kind::text, r.proof_document_id, r.proof_linked_by,
         r.proof_linked_at > d.reviewed_at + interval '23 hours' as linked_today
       from asu_registration r join document d on d.id = r.proof_document_id where r.id = $1`,
      [registrationId],
    );
    expect(row).toEqual({
      proof_kind: "ba_confirmation",
      proof_document_id: documentId,
      proof_linked_by: consultant,
      linked_today: true,
    });
    expect(await events(id, ["asu_proof_linked"])).toEqual([
      { type: "asu_proof_linked", details: { registrationId, documentId } },
    ]);
    await expect(link(id, registrationId, documentId)).rejects.toMatchObject(
      failsWith("asu_proof_present"),
    );
  });

  it("refuses an unaccepted, quarantined or another participation's document", async () => {
    const { id, registrationId } = await registered();
    const pending = await proof(id);
    await expect(link(id, registrationId, pending)).rejects.toMatchObject(
      failsWith("document_not_accepted"),
    );
    await review(pending);
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: pending,
      reason: "suspected_wrong_person",
    });
    await expect(link(id, registrationId, pending)).rejects.toMatchObject(
      failsWith("document_quarantined"),
    );
    const otherOne = await participation();
    const foreign = await proof(otherOne);
    await review(foreign);
    await expect(link(id, registrationId, foreign)).rejects.toMatchObject(
      failsWith("document_not_found"),
    );
  });

  it("refuses a registration of another participation or one with a proof", async () => {
    const { id, registrationId } = await registered();
    const documentId = await proof(id);
    await review(documentId);
    await expect(link(id, randomUUID(), documentId)).rejects.toMatchObject(
      failsWith("asu_registration_not_found"),
    );
    const attested = await participation();
    await route(attested, "online_self", 0);
    const attestedId = await register(attested, await today(), {
      customerNumber: number,
      source: "ba_document_inspected",
    });
    const theirs = await proof(attested);
    await review(theirs);
    await expect(link(attested, attestedId, theirs)).rejects.toMatchObject(
      failsWith("asu_proof_present"),
    );
    await expect(link(attested, registrationId, theirs)).rejects.toMatchObject(
      failsWith("asu_registration_not_found"),
    );
  });
});

describe("the knowledge date (process-and-lifecycle.md, dates)", () => {
  it("is set, changed and cleared by the PL against the date read, audited without the date", async () => {
    const id = await participation();
    const first = await daysAgo(40);
    const second = await daysAgo(30);
    await set(id, first, null);
    await expect(set(id, second, null)).rejects.toMatchObject(failsWith("stale_value"));
    await set(id, second, first);
    await set(id, second, second);
    await set(id, null, second);
    expect(await events(id, ["knowledge_date_set"])).toEqual(
      ["set", "changed", "cleared"].map((change) => ({
        type: "knowledge_date_set",
        details: { change },
      })),
    );
    expect(
      (
        await one(`select knowledge_date from participant_details where participation_id = $1`, [
          id,
        ])
      ).knowledge_date,
    ).toBeNull();
  });

  it("refuses a future date, a consultant and back office", async () => {
    const id = await participation();
    await expect(set(id, await daysAgo(-1), null)).rejects.toMatchObject(
      failsWith("knowledge_date_in_future"),
    );
    for (const context of [asConsultant, asBackOffice]) {
      await expect(set(id, await today(), null, context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
  });

  it("comes with the import through write_participant_data, a null keeping it", async () => {
    const id = await participation();
    const knowledgeDate = await daysAgo(50);
    const identity = { personnelNumber: "P-ASU-1", lastName: "Muster", firstName: "Mia" };
    await call(app, "write_participant_data", { participationId: id, context: pl, ...identity });
    await call(app, "write_participant_data", { participationId: id, context: pl, knowledgeDate });
    await call(app, "write_participant_data", {
      participationId: id,
      context: pl,
      phone: "0301234",
    });
    expect(
      (
        await one(`select knowledge_date from participant_details where participation_id = $1`, [
          id,
        ])
      ).knowledge_date,
    ).toBe(knowledgeDate);
    expect((await events(id, ["participant_data_changed"])).map((e) => e.details)).toContainEqual({
      fields: ["knowledgeDate"],
    });
    await expect(
      call(app, "write_participant_data", {
        participationId: id,
        context: pl,
        knowledgeDate: await daysAgo(-1),
      }),
    ).rejects.toMatchObject(failsWith("knowledge_date_in_future"));
  });
});

describe("the ASU events (ADR-0002)", () => {
  it.each(["asu_route_set", "asu_registration_recorded", "asu_proof_linked", "knowledge_date_set"])(
    "record_audit_event refuses %s",
    async (type) => {
      const id = await participation();
      await expect(
        call(app, "record_audit_event", {
          projectId: werkNord,
          participationId: id,
          eventType: type,
          context: pl,
        }),
      ).rejects.toMatchObject(failsWith("event_type_reserved"));
    },
  );

  it("transfer_app writes no ASU table", async () => {
    await expect(app.query("delete from asu_registration")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("update asu_record set version = 9")).rejects.toMatchObject({
      code: "42501",
    });
  });
});
