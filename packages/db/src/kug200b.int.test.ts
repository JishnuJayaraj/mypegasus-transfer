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

// The Kug 200b (process-and-lifecycle.md, the Kug 200b offer; data-protection.md, generated
// forms, signed scans, signed declarations and exports; Q179, Q184, Q185, Q197) as transfer_app
// calls the functions: the generation, one and in bulk, the purpose-bound read, the review with
// the three confirmations, declaration 17's consent record, the decline, a withdrawal and its BA
// notice, the export link. Synthetic values only; the files are the API's.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, backOffice, projectLead } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { werkNord, verwaltung } = seedProjectIds;
const three = ["declarations_ticked", "mandatory_completed", "signature_present"];
const key = hex();
const keyId = hex(8);

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

const person = {
  firstName: "",
  lastName: "",
  birthDate: null,
  street: null,
  postalCode: null,
  city: null,
  country: null,
  phone: null,
  mobile: null,
  privateEmail: null,
  tgStart: null,
  tgEnd: null,
};
const sources = { profile: 0, profiling: 0, assessment: 0, unemployment: 0 };

/** The participation's person as `form_person` reads it (the identity comes from the import). */
const personOf = async (id: string) =>
  (await one("select form_person($1) as p", [id])).p as typeof person;

type Generation = {
  context?: string;
  checklist?: string | null;
  declarations?: string | null;
  formCode?: string;
  anlage?: boolean;
  person?: object;
};

/** A generated Kug 200b recorded by `context` (the PL by default); its document id. */
async function generate(id: string, overrides: Generation = {}) {
  const documentId = randomUUID();
  await call(app, "record_form_generation", {
    context: overrides.context ?? pl,
    participationId: id,
    generationId: randomUUID(),
    documentId,
    formCode: overrides.formCode ?? "kug200b",
    formVersion: "09-2021",
    sources: JSON.stringify(sources),
    person: JSON.stringify(overrides.person ?? (await personOf(id))),
    sourceToken: hex(),
    organisationSha256: hex(),
    declarations: overrides.declarations ?? null,
    confirmedWarnings: [],
    anlage: overrides.anlage ?? false,
    sizeBytes: 2048,
    contentSha256: hex(),
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    checklist:
      overrides.checklist === undefined
        ? JSON.stringify([{ code: "required_blank", key: "pensionInsuranceNumber" }])
        : overrides.checklist,
  });
  return documentId;
}

/** A signed Kug 200b scan stored by `context`; its id. */
function scan(
  id: string,
  origin: "generated" | "external_paper",
  generationDocumentId: string | null = null,
  context = asConsultant,
) {
  return call(app, "add_document", {
    context,
    participationId: id,
    id: randomUUID(),
    type: "kug200b_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    scanOrigin: origin,
    generationDocumentId,
  });
}

type Review = {
  signedOn?: string;
  countersignedOn?: string | null;
  confirmations?: string[] | null;
  formVersion?: string | null;
  declarations?: object | null;
  context?: string;
};

async function accept(documentId: string, review: Review = {}) {
  return call(app, "review_document", {
    context: review.context ?? asConsultant,
    documentId,
    decision: "accepted",
    reason: null,
    signedOn: review.signedOn ?? (await today()),
    countersignedOn: review.countersignedOn ?? null,
    confirmations: review.confirmations === undefined ? three : review.confirmations,
    formVersion: review.formVersion ?? null,
    declarations: review.declarations ? JSON.stringify(review.declarations) : null,
  });
}

/** A generated, signed and accepted Kug 200b; the scan's id. */
async function signed(id: string, signedOn?: string) {
  const documentId = await scan(id, "generated", await generate(id));
  await accept(documentId, signedOn ? { signedOn } : {});
  return documentId;
}

const consentsOf = (id: string) =>
  all(
    `select purpose::text, source::text, text_version, language::text, actor_staff_user_id,
       given_on::text, document_id, end_reason::text from consent_record
     where participation_id = $1 and purpose = 'kug200b_profile_access' order by given_at, id`,
    [id],
  );

const events = async (id: string, types: string[]) =>
  (
    await all(
      `select event_type::text as type, reason_code, details from audit_event
       where participation_id = $1 and event_type::text = any ($2) order by seq`,
      [id, types],
    )
  ).map(({ type, reason_code, details }) => ({
    type,
    ...(reason_code !== null && { reason: reason_code }),
    details,
  }));

describe("record_form_generation for the Kug 200b (Q179, Q197)", () => {
  it("stores the PL's or the assigned consultant's Kug 200b with its checklist, audited", async () => {
    const id = await participation();
    const byPl = await generate(id);
    const byConsultant = await generate(id, { context: asConsultant, checklist: "[]" });
    expect(
      await all(
        `select d.type::text, d.catalog_version, d.retention_class::text, g.form_code::text,
           g.checklist, g.jobboerse_choice, g.anlage
         from form_generation g join document d on d.id = g.document_id
         where g.participation_id = $1 order by g.generated_at, d.id`,
        [id],
      ),
    ).toEqual(
      expect.arrayContaining(
        [byPl, byConsultant].map((_, index) => ({
          type: "kug200b_form",
          catalog_version: 6,
          retention_class: "form_working_copy",
          form_code: "kug200b",
          checklist: index === 0 ? [{ code: "required_blank", key: "pensionInsuranceNumber" }] : [],
          jobboerse_choice: null,
          anlage: false,
        })),
      ),
    );
    expect(await events(id, ["form_generated"])).toEqual([
      {
        type: "form_generated",
        details: { documentId: byPl, formCode: "kug200b", formVersion: "09-2021", anlage: false },
      },
      {
        type: "form_generated",
        details: {
          documentId: byConsultant,
          formCode: "kug200b",
          formVersion: "09-2021",
          anlage: false,
        },
      },
    ]);
  });

  it("refuses back office, an unassigned consultant, a ta_only project and a closed participation", async () => {
    const id = await participation();
    await expect(generate(id, { context: asBackOffice })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const unassigned = await informedParticipation(app);
    await expect(generate(unassigned, { context: asConsultant })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const taOnly = await participation(verwaltung);
    await expect(generate(taOnly)).rejects.toMatchObject(failsWith("asu_not_applicable"));
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await today(),
    });
    await expect(generate(id)).rejects.toMatchObject(failsWith("participation_closed"));
  });

  it("refuses a declaration snapshot, an Anlage, a malformed checklist and a changed person", async () => {
    const id = await participation();
    for (const bad of [
      { declarations: JSON.stringify({ jobboerseChoice: null, baContactConsent: null }) },
      { anlage: true },
      { checklist: null },
      { checklist: JSON.stringify([{ code: "required_blank", key: "x", value: "y" }]) },
      { checklist: JSON.stringify([{ code: "other", key: "x" }]) },
    ]) {
      await expect(generate(id, bad)).rejects.toMatchObject(failsWith("invalid_argument"));
    }
    // The TL 407 takes no checklist.
    await expect(
      generate(id, {
        formCode: "tl407",
        context: asConsultant,
        declarations: JSON.stringify({ jobboerseChoice: null, baContactConsent: null }),
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(
      generate(id, { person: { ...(await personOf(id)), lastName: "Anders" } }),
    ).rejects.toMatchObject(failsWith("source_changed"));
  });
});

describe("lock_bulk_form_generation (Q179)", () => {
  const lock = (context: string, projectId: string, participationIds: string[]) =>
    call(app, "lock_bulk_form_generation", { context, projectId, participationIds });

  it("is the PL's, takes the exclusive project lock, and the generations go all or nothing", async () => {
    const ids = [await participation(), await participation()];
    await app.query("begin");
    try {
      await lock(pl, werkNord, ids);
      // Another transaction can't take even the shared project lock now.
      const blocked = await one(
        `select pg_try_advisory_xact_lock_shared(project_lock_key($1)) as got`,
        [werkNord],
      );
      expect(blocked).toEqual({ got: false });
      for (const id of ids) await generate(id);
      // One refused member rolls the whole batch back.
      await expect(generate(ids[0]!, { checklist: null })).rejects.toMatchObject(
        failsWith("invalid_argument"),
      );
    } finally {
      await app.query("rollback");
    }
    expect(
      await one(
        "select count(*)::int as n from form_generation where participation_id = any ($1)",
        [ids],
      ),
    ).toEqual({ n: 0 });
  });

  it("refuses a consultant, a ta_only project, a foreign participation and a bad list", async () => {
    const id = await participation();
    await expect(lock(asConsultant, werkNord, [id])).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(lock(pl, verwaltung, [await participation(verwaltung)])).rejects.toMatchObject(
      failsWith("asu_not_applicable"),
    );
    const other = await participation(verwaltung);
    await expect(lock(pl, werkNord, [id, other])).rejects.toMatchObject(
      failsWith("participation_not_found"),
    );
    for (const bad of [[], [id, id], Array.from({ length: 101 }, () => randomUUID())]) {
      await expect(lock(pl, werkNord, bad)).rejects.toMatchObject(failsWith("invalid_argument"));
    }
  });
});

describe("read_kug200b_values (ba-forms.md, what is filled)", () => {
  it("is read by the PL and the assigned consultant for the form, each key audited", async () => {
    const id = await participation();
    for (const context of [pl, asConsultant]) {
      expect(
        await call(app, "read_kug200b_values", {
          participationId: id,
          context,
          keys: ["nationality", "pensionInsuranceNumber", "severeDisability"],
          key,
          keyId,
        }),
      ).toEqual({ nationality: null, pensionInsuranceNumber: null, severeDisability: null });
    }
    expect((await events(id, ["sensitive_read"])).map((e) => e.details.key)).toEqual([
      "nationality",
      "pensionInsuranceNumber",
      "severeDisability",
      "nationality",
      "pensionInsuranceNumber",
      "severeDisability",
    ]);
    await expect(
      call(app, "read_kug200b_values", {
        participationId: id,
        context: asBackOffice,
        keys: ["nationality"],
        key,
        keyId,
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(
      call(app, "read_kug200b_values", {
        participationId: id,
        context: pl,
        keys: ["healthRestrictions"],
        key,
        keyId,
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });
});

describe("review_document for the signed Kug 200b (Q184, Q185)", () => {
  it("accepts with 16, 17, the mandatory information and the signature confirmed: signed declarations and one consent", async () => {
    const id = await participation();
    const signedOn = await daysAgo(1);
    const generation = await generate(id);
    // Generated yesterday (the date the paper may carry).
    await owner.query(
      "update form_generation set generated_at = now() - interval '1 day' where document_id = $1",
      [generation],
    );
    const documentId = await scan(id, "generated", generation, pl);
    await accept(documentId, { signedOn, context: pl });
    expect(
      await one(
        `select review_state::text, form_code::text, form_version, signed_on::text,
           countersigned_on, review_confirmations from document where id = $1`,
        [documentId],
      ),
    ).toEqual({
      review_state: "accepted",
      form_code: "kug200b",
      form_version: "09-2021",
      signed_on: signedOn,
      countersigned_on: null,
      review_confirmations: three,
    });
    expect(
      await all(
        `select declaration, value, form_code::text, form_version, signed_on::text
         from signed_declaration where document_id = $1 order by declaration`,
        [documentId],
      ),
    ).toEqual(
      ["kug200bJobSeeking", "kug200bProfileAccess"].map((declaration) => ({
        declaration,
        value: "yes",
        form_code: "kug200b",
        form_version: "09-2021",
        signed_on: signedOn,
      })),
    );
    expect(await consentsOf(id)).toEqual([
      {
        purpose: "kug200b_profile_access",
        source: "paper_form",
        text_version: "kug200b-09-2021:v1",
        language: "de",
        actor_staff_user_id: projectLead,
        given_on: signedOn,
        document_id: documentId,
        end_reason: null,
      },
    ]);
    const consentId = (
      await one("select id from consent_record where document_id = $1", [documentId])
    ).id;
    expect(
      await events(id, ["signed_declaration_recorded", "consent_given", "document_reviewed"]),
    ).toEqual([
      {
        type: "signed_declaration_recorded",
        details: {
          documentId,
          formCode: "kug200b",
          formVersion: "09-2021",
          declarations: ["kug200bJobSeeking", "kug200bProfileAccess"],
        },
      },
      {
        type: "consent_given",
        details: {
          consentId,
          purpose: "kug200b_profile_access",
          textVersion: "kug200b-09-2021:v1",
          language: "de",
          source: "paper_form",
        },
      },
      {
        type: "document_reviewed",
        details: {
          documentId,
          documentType: "kug200b_signed_scan",
          decision: "accepted",
          origin: "generated",
          formVersion: "09-2021",
        },
      },
    ]);
  });

  it("refuses an acceptance without every confirmation, or with a TL 407's record", async () => {
    const id = await participation();
    const documentId = await scan(id, "generated", await generate(id));
    for (const bad of [
      { confirmations: null },
      { confirmations: ["declarations_ticked", "signature_present"] },
      { confirmations: ["signatures_present", "all_pages_present"] },
      { countersignedOn: await today() },
      { declarations: { kind: "as_printed" } },
      { formVersion: "09-2021" },
    ]) {
      await expect(accept(documentId, bad)).rejects.toMatchObject(failsWith("invalid_argument"));
    }
    await expect(accept(documentId, { signedOn: await daysAgo(-1) })).rejects.toMatchObject(
      failsWith("signature_in_future"),
    );
    await expect(accept(documentId, { signedOn: await daysAgo(1) })).rejects.toMatchObject(
      failsWith("signature_before_generation"),
    );
    expect(await consentsOf(id)).toEqual([]);
  });

  it("records external paper signed before the platform with its version, without re-signing", async () => {
    const id = await participation();
    const documentId = await scan(id, "external_paper");
    await expect(accept(documentId, { signedOn: await daysAgo(40) })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await accept(documentId, { signedOn: await daysAgo(40), formVersion: "09-2021" });
    expect((await consentsOf(id)).map((c) => c.given_on)).toEqual([await daysAgo(40)]);
  });

  it("keeps one record of declaration 17 in force: a later paper supersedes the earlier", async () => {
    const id = await participation();
    await signed(id);
    const second = await signed(id);
    expect((await consentsOf(id)).map((c) => [c.document_id === second, c.end_reason])).toEqual([
      [false, "superseded"],
      [true, null],
    ]);
  });

  it("is refused for back office (no Kug 200b access, Q49) and in assisted mode", async () => {
    const id = await participation();
    await expect(scan(id, "external_paper", null, asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });
});

describe("decline_kug200b_offer (process-and-lifecycle.md, the Kug 200b offer)", () => {
  const decline = (id: string, declinedOn: string, context = pl) =>
    call(app, "decline_kug200b_offer", { context, participationId: id, declinedOn });

  it("records the decline once, by the PL or the assigned consultant, audited by its date", async () => {
    const id = await participation();
    const on = await today();
    await decline(id, on, asConsultant);
    await expect(decline(id, on)).rejects.toMatchObject(failsWith("kug200b_declined"));
    expect(
      await one("select declined_on::text from kug200b_decline where participation_id = $1", [id]),
    ).toEqual({
      declined_on: on,
    });
    expect(await events(id, ["kug200b_offer_declined"])).toEqual([
      { type: "kug200b_offer_declined", details: { declinedOn: on } },
    ]);
  });

  it("leaves a valid ASU registration intact (D33)", async () => {
    const id = await participation();
    await call(app, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: "in_person",
      version: 0,
    });
    await call(app, "record_asu_registration", {
      context: pl,
      participationId: id,
      id: randomUUID(),
      registeredOn: await daysAgo(3),
      routeVersion: 1,
      customerNumber: "123A456789",
      attestationSource: "ba_document_inspected",
      key,
      keyId,
    });
    const before = await one("select * from asu_registration where participation_id = $1", [id]);
    await generate(id);
    await decline(id, await today());
    expect(await one("select * from asu_registration where participation_id = $1", [id])).toEqual(
      before,
    );
  });

  it("refuses a future date, a signed offer, the route kug_200b and back office", async () => {
    const id = await participation();
    await expect(decline(id, await daysAgo(-1))).rejects.toMatchObject(
      failsWith("declined_on_in_future"),
    );
    await expect(decline(id, await today(), asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await call(app, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: "kug_200b",
      version: 0,
    });
    await expect(decline(id, await today())).rejects.toMatchObject(failsWith("asu_route_kug200b"));
    const other = await participation();
    await signed(other);
    await expect(decline(other, await today())).rejects.toMatchObject(failsWith("kug200b_signed"));
  });
});

describe("a withdrawal and its BA notice (Q185)", () => {
  const withdraw = async (id: string, receivedOn: string, context = pl) => {
    const consentId = (
      await one(
        `select id from consent_record where participation_id = $1
           and purpose = 'kug200b_profile_access' and ended_at is null`,
        [id],
      )
    )?.id;
    return call<string>(app, "record_declaration_withdrawal", {
      context,
      participationId: id,
      id: randomUUID(),
      consentId: consentId ?? randomUUID(),
      receivedOn,
    });
  };
  const notice = (id: string, withdrawalId: string, notifiedOn: string, context = pl) =>
    call(app, "record_withdrawal_ba_notice", {
      context,
      participationId: id,
      withdrawalId,
      notifiedOn,
    });

  it("ends the record revoked, keeps the registration intact and closes with the BA notice", async () => {
    const id = await participation();
    await call(app, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: "online_self",
      version: 0,
    });
    await call(app, "record_asu_registration", {
      context: pl,
      participationId: id,
      id: randomUUID(),
      registeredOn: await daysAgo(3),
      routeVersion: 1,
      customerNumber: "123A456789",
      attestationSource: "ba_online_account_inspected",
      key,
      keyId,
    });
    const registration = await one("select * from asu_registration where participation_id = $1", [
      id,
    ]);
    await signed(id);
    const withdrawalId = await withdraw(id, await today(), asConsultant);
    expect((await consentsOf(id)).map((c) => c.end_reason)).toEqual(["revoked"]);
    expect(await one("select * from asu_registration where participation_id = $1", [id])).toEqual(
      registration,
    );
    await expect(notice(id, withdrawalId, await daysAgo(1))).rejects.toMatchObject(
      failsWith("notified_before_receipt"),
    );
    await expect(notice(id, withdrawalId, await daysAgo(-1))).rejects.toMatchObject(
      failsWith("notified_on_in_future"),
    );
    await notice(id, withdrawalId, await today());
    await expect(notice(id, withdrawalId, await today())).rejects.toMatchObject(
      failsWith("ba_notice_recorded"),
    );
    expect(
      await events(id, [
        "consent_ended",
        "declaration_withdrawal_recorded",
        "declaration_withdrawal_ba_notified",
      ]),
    ).toEqual([
      {
        type: "consent_ended",
        reason: "revoked",
        details: expect.objectContaining({
          purpose: "kug200b_profile_access",
          source: "paper_form",
        }),
      },
      {
        type: "declaration_withdrawal_recorded",
        details: expect.objectContaining({ withdrawalId, receivedOn: await today() }),
      },
      {
        type: "declaration_withdrawal_ba_notified",
        details: { withdrawalId, notifiedOn: await today() },
      },
    ]);
  });

  it("refuses an ended or unknown record, a date before the paper's, and is recorded after the end too", async () => {
    const id = await participation();
    await expect(withdraw(id, await today())).rejects.toMatchObject(failsWith("consent_not_found"));
    await signed(id);
    await expect(withdraw(id, await daysAgo(1))).rejects.toMatchObject(
      failsWith("received_before_consent"),
    );
    await expect(withdraw(id, await daysAgo(-1))).rejects.toMatchObject(
      failsWith("received_on_in_future"),
    );
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: await today(),
    });
    const withdrawalId = await withdraw(id, await today());
    await notice(id, withdrawalId, await today());
    await expect(withdraw(id, await today(), asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
  });
});

describe("the export link (data-protection.md, exports)", () => {
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
  const create = (context: string, documentIds: string[], sessionHash: string, linkHash = hex()) =>
    call<string>(app, "create_export_link", {
      context,
      kind: "kug200b_print",
      documentIds,
      sessionHash,
      linkHash,
    });
  const content = async (context: string, linkHash: string, sessionHash: string) =>
    (
      await app.query(
        `select document_id, document_type::text from export_link_content(
           p_context => $1::audit_context, p_link_hash => $2, p_session_hash => $3)`,
        [context, linkHash, sessionHash],
      )
    ).rows;
  const exportEvents = () =>
    all(
      `select event_type::text as type, participation_id, details from audit_event
       where event_type::text in ('export_created', 'export_downloaded') order by seq`,
    );

  it("is created for the asking session, re-authorized at the download, audited, no file", async () => {
    const forms = [await generate(await participation()), await generate(await participation())];
    const hash = await session(projectLead);
    const linkHash = hex();
    await create(pl, forms, hash, linkHash);
    expect((await content(pl, linkHash, hash)).map((row) => row.document_id)).toEqual(forms);
    // Another session, another user or a wrong link: nothing.
    const otherHash = await session(projectLead);
    for (const [context, link, s] of [
      [pl, linkHash, otherHash],
      [asConsultant, linkHash, hash],
      [pl, hex(), hash],
    ] as const) {
      await expect(content(context, link, s)).rejects.toMatchObject(
        failsWith("export_link_invalid"),
      );
    }
    expect(await exportEvents()).toEqual([
      {
        type: "export_created",
        participation_id: null,
        details: { exportKind: "kug200b_print", count: 2 },
      },
      {
        type: "export_downloaded",
        participation_id: null,
        details: { exportKind: "kug200b_print", count: 2 },
      },
    ]);
    // The link holds no file and the runtime role can't read it.
    await expect(app.query("select * from export_link")).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a quarantined document at the download (stale) and at the request", async () => {
    const id = await participation();
    const form = await generate(id);
    const hash = await session(projectLead);
    const linkHash = hex();
    await create(pl, [form], hash, linkHash);
    await owner.query(
      `update document set quarantine_reason = 'suspected_wrong_person', quarantined_by = $2,
         quarantined_at = now() where id = $1`,
      [form, projectLead],
    );
    await expect(content(pl, linkHash, hash)).rejects.toMatchObject(failsWith("export_stale"));
    await expect(create(pl, [form], hash)).rejects.toMatchObject(failsWith("document_quarantined"));
    expect((await exportEvents()).map((e) => e.type)).toEqual(["export_created"]);
  });

  it("refuses at the download once the user may no longer open the form (assignment ended)", async () => {
    const id = await participation();
    const form = await generate(id);
    const hash = await session(consultant);
    const linkHash = hex();
    await create(asConsultant, [form], hash, linkHash);
    await call(app, "unassign_participation", {
      participationId: id,
      staffUserId: consultant,
      context: pl,
    });
    await expect(content(asConsultant, linkHash, hash)).rejects.toMatchObject(
      failsWith("export_stale"),
    );
  });

  it("takes only live generated Kug 200b forms of one project the user may open", async () => {
    const id = await participation();
    const hash = await session(projectLead);
    const scanId = await scan(id, "external_paper");
    await expect(create(pl, [scanId], hash)).rejects.toMatchObject(failsWith("document_not_found"));
    await expect(
      create(asBackOffice, [await generate(id)], await session(backOffice)),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(create(pl, [await generate(id)], hex())).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await expect(create(pl, [], hash)).rejects.toMatchObject(failsWith("invalid_argument"));
  });
});
