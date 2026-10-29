import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STAFF_SESSION_HOURS } from "@transfer/domain";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// The Kug 200a's header on the project and the official artifacts of a batch (ba-forms.md, the
// Kug 200a as built; data-protection.md, exports; Q203 (6), Q205) as transfer_app calls the
// functions: the link of each kind, the read with its purpose-bound RV-Nummer reads, the record
// with its full recheck and the fingerprint of everything printed. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, projectLead } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const { werkNord } = seedProjectIds;
const nord = "beispielstadt-nord";
const three = ["declarations_ticked", "mandatory_completed", "signature_present"];
const key = hex();
const keyId = hex(8);
const organisation = hex();

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const today = async () => (await one("select berlin_today()::text as d")).d as string;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const { message, detail } = error as { message: string; detail?: string };
    return { message, rows: detail ? JSON.parse(detail) : undefined };
  }
  throw new Error("expected a refusal");
}

const projectEvents = (type: string) =>
  all(
    `select participation_id, details from audit_event
     where project_id = $1 and event_type::text = $2 order by seq`,
    [werkNord, type],
  );

describe("update_project and the Kug 200a's header", () => {
  const update = (kug200a: unknown) =>
    call(app, "update_project", { id: werkNord, context: pl, kug200a });

  it("sets and clears each key in any status, audited by field name only", async () => {
    await update({
      tKugNumber: "123-456-7890",
      employerBetriebsnummer: "87654321",
      employerEconomicClass: "C 28.22",
    });
    expect(
      await one(
        `select t_kug_number, employer_betriebsnummer, employer_economic_class from project
         where id = $1`,
        [werkNord],
      ),
    ).toEqual({
      t_kug_number: "123-456-7890",
      employer_betriebsnummer: "87654321",
      employer_economic_class: "C 28.22",
    });
    await update({ tKugNumber: null, employerBetriebsnummer: "87654321" });
    expect(
      await one(`select t_kug_number, employer_betriebsnummer from project where id = $1`, [
        werkNord,
      ]),
    ).toEqual({ t_kug_number: null, employer_betriebsnummer: "87654321" });
    expect((await projectEvents("project_changed")).map(({ details }) => details)).toEqual([
      { fields: ["tKugNumber", "employerBetriebsnummer", "employerEconomicClass"] },
      { fields: ["tKugNumber"] },
    ]);
    await expect(update({ employerBetriebsnummer: "87654321" })).rejects.toMatchObject(
      failsWith("project_unchanged"),
    );
  });

  it("refuses a malformed value, an unknown key and another shape", async () => {
    for (const bad of [
      { tKugNumber: "TK-123" },
      { tKugNumber: "tk-123" },
      { tKugNumber: " 123" },
      { employerBetriebsnummer: "8765432" },
      { employerEconomicClass: "" },
      { employerEconomicClass: "C 28\n" },
      { employerEconomicClass: 28 },
      { employer: "x" },
      JSON.stringify(["tKugNumber"]),
    ]) {
      await expect(update(bad)).rejects.toMatchObject(failsWith("invalid_argument"));
    }
  });
});

/** An informed participation on `kug_200b`, placed with Nord, with name, address and RV-Nummer. */
async function participation(lastName: string, rv: string | null = "12290751D121") {
  const id = await informedParticipation(app, { projectId: werkNord });
  await call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  await owner.query(
    "update participation set placement_agentur_key = $2, placement_agentur_set_at = now() where id = $1",
    [id, nord],
  );
  await owner.query(
    `insert into participant_identity (participation_id, project_id, personnel_number, last_name,
       first_name) values ($1, $2, $3, $4, 'Erika')`,
    [id, werkNord, `P-${lastName}`, lastName],
  );
  if (rv) {
    await owner.query(
      `insert into participant_identifier_data (participation_id, project_id,
         pension_insurance_number, pension_insurance_number_present, key_id)
       values ($1, $2, seal_sensitive_value($1, 'pensionInsuranceNumber', to_jsonb($3::text), $4),
         true, $5)`,
      [id, werkNord, rv, key, keyId],
    );
  }
  await call(app, "set_asu_route", {
    context: pl,
    participationId: id,
    channel: "kug_200b",
    version: 0,
  });
  return id;
}

async function acceptedScan(id: string) {
  const documentId = await call(app, "add_document", {
    context: asConsultant,
    participationId: id,
    id: randomUUID(),
    type: "kug200b_signed_scan",
    mediaType: "image/png",
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

describe("the official artifacts of a batch (Q203 (6))", () => {
  let session: string;
  beforeEach(async () => {
    session = hex();
    await owner.query(
      `insert into staff_session (token_hash, staff_user_id, created_at, expires_at)
       values ($1, $2, now(), now() + interval '${STAFF_SESSION_HOURS} hours')`,
      [session, projectLead],
    );
  });

  async function batch(scans: string[], channel = "scan_email") {
    return call<string>(app, "create_kug200b_batch", {
      context: pl,
      projectId: werkNord,
      batchId: randomUUID(),
      agenturKey: nord,
      channel,
      artifact: "kug200a",
      documentIds: scans,
      outdatedVersions: [],
    });
  }
  const link = (batchId: string, kind: string, linkHash = hex(), channel = "scan_email") =>
    call(app, "create_kug200b_batch_export_link", {
      context: pl,
      kind,
      batchId,
      sessionHash: session,
      linkHash,
      channel,
      artifact: "kug200a",
      outdatedVersions: [],
    }).then(() => linkHash);
  const settings = (channel = "scan_email", artifact = "kug200a") => ({
    channel,
    artifact,
    outdatedVersions: [],
  });
  type Read = {
    kind: string;
    fingerprint: string;
    sources: { members: Record<string, unknown>[] } & Record<string, unknown>;
    insuranceNumbers?: Record<string, string>;
    files?: Record<string, unknown>[];
  };
  const read = (linkHash: string, s = settings()) =>
    call<Read>(app, "read_kug200b_batch_export", {
      context: pl,
      linkHash,
      sessionHash: session,
      ...s,
      organisationSha256: organisation,
      key,
      keyId,
    });
  const record = (linkHash: string, fingerprint: string, s = settings()) =>
    call(app, "record_kug200b_batch_export", {
      context: pl,
      linkHash,
      sessionHash: session,
      ...s,
      organisationSha256: organisation,
      fingerprint,
    });

  it("reads what the Kug 200a prints with the RV-Nummern audited, then records the download", async () => {
    const zimmer = await participation("Zimmer");
    const adler = await participation("Adler", null);
    const scans = [await acceptedScan(zimmer), await acceptedScan(adler)];
    const batchId = await batch(scans);
    await owner.query(
      `insert into participant_details (participation_id, project_id, address_street,
         address_postal_code, address_city, address_country)
       values ($1, $2, 'Beispielweg 1', '10115', 'Berlin', 'DE')`,
      [zimmer, werkNord],
    );
    const linkHash = await link(batchId, "kug200b_batch_artifact");
    const found = await read(linkHash);
    expect(found.kind).toBe("kug200b_batch_artifact");
    expect(found.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(found.insuranceNumbers).toEqual({ [zimmer]: "12290751D121" });
    expect(found.sources.members.map((m) => m.lastName)).toEqual(["Adler", "Zimmer"]);
    expect(found.sources.members[1]).toMatchObject({
      participationId: zimmer,
      documentId: scans[0],
      address: { street: "Beispielweg 1", postalCode: "10115", city: "Berlin", country: "DE" },
      profileAccess: true,
      infoEventDates: [],
    });
    expect(found.sources.members[0]).toMatchObject({ address: null, insuranceNumberSha256: null });
    expect(JSON.stringify(found.sources)).not.toContain("12290751D121");
    expect(
      await all(
        `select participation_id, details from audit_event
         where event_type = 'sensitive_read' and project_id = $1`,
        [werkNord],
      ),
    ).toEqual([{ participation_id: zimmer, details: { key: "pensionInsuranceNumber" } }]);
    // Reading isn't downloading: the record writes the event.
    expect(await projectEvents("export_downloaded")).toEqual([]);
    await record(linkHash, found.fingerprint);
    expect((await projectEvents("export_downloaded")).map(({ details }) => details)).toEqual([
      { exportKind: "kug200b_batch_artifact", count: 2 },
    ]);
    // The other content functions never serve an official link.
    await expect(
      app.query("select * from kug200b_batch_export_content($1, $2, $3)", [pl, linkHash, session]),
    ).rejects.toMatchObject(failsWith("export_link_invalid"));
  });

  it("refuses the record when anything printed moved after the read", async () => {
    const id = await participation("Zimmer");
    const batchId = await batch([await acceptedScan(id)]);
    const linkHash = await link(batchId, "kug200b_batch_artifact");
    const before = await read(linkHash);
    await call(app, "update_project", {
      id: werkNord,
      context: pl,
      kug200a: { employerBetriebsnummer: "87654321" },
    });
    await expect(record(linkHash, before.fingerprint)).rejects.toMatchObject(
      failsWith("source_changed"),
    );
    const after = await read(linkHash);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    // A changed RV-Nummer, an address, the organisation's configuration: each moves it.
    await owner.query(
      `update participant_identifier_data set pension_insurance_number =
         seal_sensitive_value($1, 'pensionInsuranceNumber', to_jsonb('12290751D129'::text), $2)
       where participation_id = $1`,
      [id, key],
    );
    await expect(record(linkHash, after.fingerprint)).rejects.toMatchObject(
      failsWith("source_changed"),
    );
    const third = await read(linkHash);
    await expect(
      call(app, "record_kug200b_batch_export", {
        context: pl,
        linkHash,
        sessionHash: session,
        ...settings(),
        organisationSha256: hex(),
        fingerprint: third.fingerprint,
      }),
    ).rejects.toMatchObject(failsWith("source_changed"));
    await record(linkHash, third.fingerprint);
  });

  it("rechecks members and settings at both steps (export_stale with the rows)", async () => {
    const id = await participation("Zimmer");
    const scan = await acceptedScan(id);
    const batchId = await batch([scan]);
    const linkHash = await link(batchId, "kug200b_batch_artifact");
    expect((await refusal(read(linkHash, settings("upload")))).rows).toEqual([
      { participationId: null, documentId: null, reason: "settings_changed" },
    ]);
    expect(
      (await refusal(read(linkHash, settings("scan_email", "accepted_alternative")))).message,
    ).toBe("export_stale");
    const found = await read(linkHash);
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: scan,
      reason: "suspected_wrong_person",
    });
    expect(await refusal(record(linkHash, found.fingerprint))).toEqual({
      message: "export_stale",
      rows: [{ participationId: id, documentId: scan, reason: "scan_unusable" }],
    });
    expect(await projectEvents("export_downloaded")).toEqual([]);
  });

  it("serves the scans for the digital channels only, with their key material", async () => {
    const id = await participation("Zimmer");
    const scan = await acceptedScan(id);
    const batchId = await batch([scan]);
    const linkHash = await link(batchId, "kug200b_batch_scans");
    const found = await read(linkHash);
    expect(found.insuranceNumbers).toBeNull();
    expect(found.files).toEqual([
      {
        documentId: scan,
        participationId: id,
        type: "kug200b_signed_scan",
        mediaType: "image/png",
        keyId: expect.stringMatching(/^[0-9a-f]{16}$/),
        wrappedKey: expect.any(String),
      },
    ]);
    expect(await all(`select 1 from audit_event where event_type = 'sensitive_read'`)).toEqual([]);
    await record(linkHash, found.fingerprint);
    expect((await projectEvents("export_downloaded")).map(({ details }) => details)).toEqual([
      { exportKind: "kug200b_batch_scans", count: 1 },
    ]);

    const paper = await participation("Adler");
    const paperBatch = await batch([await acceptedScan(paper)], "paper_post");
    await expect(
      link(paperBatch, "kug200b_batch_scans", hex(), "paper_post"),
    ).rejects.toMatchObject(failsWith("export_not_applicable"));
    // The Kug 200a goes with the originals.
    await link(paperBatch, "kug200b_batch_artifact", hex(), "paper_post");
  });

  it("hides another user's or an index link, and refuses a malformed call", async () => {
    const id = await participation("Zimmer");
    const batchId = await batch([await acceptedScan(id)]);
    const index = await link(batchId, "kug200b_batch_index");
    await expect(read(index)).rejects.toMatchObject(failsWith("export_link_invalid"));
    await expect(read(hex())).rejects.toMatchObject(failsWith("export_link_invalid"));
    const linkHash = await link(batchId, "kug200b_batch_artifact");
    await expect(
      call(app, "read_kug200b_batch_export", {
        context: asConsultant,
        linkHash,
        sessionHash: session,
        ...settings(),
        organisationSha256: organisation,
        key,
        keyId,
      }),
    ).rejects.toMatchObject(failsWith("export_link_invalid"));
    for (const bad of [
      { organisationSha256: "x", key, keyId },
      { organisationSha256: organisation, key: "x", keyId },
      { organisationSha256: organisation, key, keyId: null },
    ]) {
      await expect(
        call(app, "read_kug200b_batch_export", {
          context: pl,
          linkHash,
          sessionHash: session,
          ...settings(),
          ...bad,
        }),
      ).rejects.toMatchObject(failsWith("invalid_argument"));
    }
    await expect(
      call(app, "read_kug200b_batch_export", {
        context: pl,
        linkHash,
        sessionHash: session,
        ...settings(),
        organisationSha256: organisation,
        key,
        keyId: hex(8),
      }),
    ).rejects.toMatchObject(failsWith("key_unknown"));
    await expect(record(linkHash, "x")).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(
      call(app, "read_kug200b_batch_export", {
        context: pl,
        linkHash,
        sessionHash: session,
        channel: "scan_email",
        artifact: null,
        outdatedVersions: [],
        organisationSha256: organisation,
        key,
        keyId,
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    // A PL who no longer leads the project: stale.
    await owner.query(
      "delete from project_membership where project_id = $1 and staff_user_id = $2 and role = 'project_lead'",
      [werkNord, projectLead],
    );
    await expect(read(linkHash)).rejects.toMatchObject(failsWith("export_stale"));
  });
});
