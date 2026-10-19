import {
  auditEvent,
  eq,
  importColumnMapping,
  participantDetails,
  participantIdentity,
  participation,
  project,
  projectConfigOverride,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { ImportResult, Project } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import {
  app,
  logs,
  owner,
  auth,
  werkNord,
  verwaltung,
  bytesOf,
  fixture,
  firstFiveColumns,
  suggestionOfFirstColumn,
  noDecisions,
  preview,
  confirm,
  previewOf,
  suggested,
  importFile,
  counts,
  codes,
  waveOf,
  identities,
} from "./import-testing";
import { jsonRequest, readJson } from "../testing";
import { loadRelease } from "../projects/template-pins";

// Slice 2 plan 5.11 (PR 2g-1): the confirm, decisions, stale previews, access, logs and saved mappings (AC-25 to AC-27, AC-30, AC-31).

describe("the confirm (AC-26, AC-27)", () => {
  it("creates the participations through the creation edge, with their data and audit events", async () => {
    const res = await importFile(fixture("teilnehmer-beispiel.csv"));
    expect(res.status).toBe(200);
    expect(await readJson(res, ImportResult)).toEqual({
      created: 12,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      mappingSaved: true,
    });
    const people = await identities();
    expect(people).toHaveLength(12);
    expect(people[0]).toMatchObject({
      personnelNumber: "BSP-0001",
      lastName: "Mustermann",
      firstName: "Erika",
      birthDate: "1965-01-01",
    });
    const [details] = await owner
      .select()
      .from(participantDetails)
      .where(eq(participantDetails.participationId, people[0]!.participationId));
    expect(details).toMatchObject({
      addressStreet: "Musterstraße 1",
      addressPostalCode: "99999",
      addressCity: "Beispielstadt",
      addressCountry: "DE",
      oldEmploymentEndDate: "2026-12-31",
      privateEmail: "teilnehmer-0001@example.org",
    });
    const events = await owner
      .select({
        type: auditEvent.eventType,
        requestId: auditEvent.requestId,
        details: auditEvent.details,
      })
      .from(auditEvent)
      .where(eq(auditEvent.projectId, werkNord));
    const count = (type: string) => events.filter((e) => e.type === type).length;
    expect(count("participation_created")).toBe(12);
    expect(count("participant_data_changed")).toBe(12);
    const confirmed = events.filter((e) => e.type === "import_confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.details).toEqual({
      created: 12,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      baseDefaultsVersion: loadRelease(undefined).baseDefaults.version,
    });
    // One request correlates every event of the import.
    const correlated = events.filter((e) => e.requestId !== null);
    expect(new Set(correlated.map((e) => e.requestId)).size).toBe(1);
    expect(correlated.length).toBeGreaterThanOrEqual(12 * 2 + 1);
  });

  it("puts new participations into the chosen wave", async () => {
    const id = await waveOf(werkNord);
    await importFile(fixture("teilnehmer-beispiel.csv"), { extra: { waveId: id } });
    const waves = await owner.select({ w: participation.entryWaveId }).from(participation);
    expect(new Set(waves.map((r) => r.w))).toEqual(new Set([id]));
  });

  it("updates instead of duplicating on a re-import, showing old and new values, and counts what is missing", async () => {
    await importFile(fixture("teilnehmer-beispiel.csv"));
    const file = fixture("teilnehmer-aktualisiert.csv");
    const mapping = await suggested(werkNord, { file });
    const shown = await previewOf(werkNord, { file, mapping });
    expect(shown.report?.counts).toMatchObject({
      create: 1,
      update: 2,
      unchanged: 9,
      missing: 1,
      error: 0,
    });
    const updates = shown.report!.rows.filter((r) => r.outcome === "update");
    expect(updates.map((r) => [r.personnelNumber, r.changes])).toEqual([
      [
        "BSP-0001",
        [{ target: "addressStreet", old: "Musterstraße 1", new: "Neue Musterstraße 100" }],
      ],
      ["BSP-0002", [{ target: "phone", old: "030 23125 002", new: "030 23125 900" }]],
    ]);
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions: noDecisions,
      previewToken: shown.previewToken,
    });
    expect(await readJson(res, ImportResult)).toEqual({
      created: 1,
      updated: 2,
      unchanged: 9,
      skipped: 0,
      mappingSaved: true,
    });
    expect(await identities()).toHaveLength(13);
    const [moved] = await owner
      .select({ street: participantDetails.addressStreet })
      .from(participantDetails)
      .innerJoin(
        participantIdentity,
        eq(participantIdentity.participationId, participantDetails.participationId),
      )
      .where(eq(participantIdentity.personnelNumber, "BSP-0001"));
    expect(moved!.street).toBe("Neue Musterstraße 100");
    // The participation of the missing person is untouched.
    expect((await identities()).some((p) => p.personnelNumber === "BSP-0012")).toBe(true);
  });

  it("keeps a stored value for an empty cell and shows it", async () => {
    await importFile(fixture("teilnehmer-beispiel.csv"));
    const csv = bytesOf("teilnehmer-beispiel.csv").toString("utf8").split("\r\n");
    csv[1] = csv[1]!.replace("030 23125 001", "");
    const file = Buffer.from(csv.join("\r\n")).toString("base64");
    const shown = await previewOf(werkNord, { file, mapping: await suggested(werkNord, { file }) });
    const row = shown.report!.rows.find((r) => r.personnelNumber === "BSP-0001")!;
    expect(row).toMatchObject({
      outcome: "unchanged",
      kept: [{ target: "phone", value: "030 23125 001" }],
    });
    expect(row.issues.map((i) => i.code)).toEqual(["kept_existing"]);
  });

  it("refuses a file with errors, whatever the decisions", async () => {
    const file = fixture("teilnehmer-fehler.csv");
    const mapping = await suggested(werkNord, { file });
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions: noDecisions,
      previewToken: "0".repeat(64),
    });
    expect(await codes(res)).toEqual(["import_has_errors"]);
    expect(await identities()).toHaveLength(0);
  });

  it("is atomic: a failure on the last row leaves nothing behind", async () => {
    await owner.execute(
      sql`alter table participant_details add constraint test_failstadt check (address_city <> 'Failstadt')`,
    );
    const before = await counts();
    try {
      const csv = bytesOf("teilnehmer-beispiel.csv").toString("utf8").trimEnd().split("\r\n");
      csv[12] = csv[12]!.replace("Beispielstadt", "Failstadt");
      const file = Buffer.from(csv.join("\r\n")).toString("base64");
      const res = await importFile(file);
      expect(res.status).toBe(500);
      expect(await counts()).toEqual(before);
      // The database's message names the failing row; the error log keeps frames only.
      expect(logs.join("\n")).not.toMatch(/Failstadt|Mustermann|BSP-/);
    } finally {
      await owner.execute(sql`alter table participant_details drop constraint test_failstadt`);
    }
  });
});

describe("an approved relaxation (R6, Q75)", () => {
  it("lets the address, but nothing else, go missing, and takes effect for the next preview", async () => {
    const csv = bytesOf("teilnehmer-beispiel.csv")
      .toString("utf8")
      .trimEnd()
      .split("\r\n")
      .map(firstFiveColumns);
    const file = Buffer.from(csv.join("\r\n")).toString("base64");
    const mapping = await suggested(werkNord, { file });
    expect((await previewOf(werkNord, { file, mapping })).missingTargets).toEqual(["address"]);
    await owner.insert(projectConfigOverride).values({
      projectId: werkNord,
      version: 1,
      createdBy: seedStaffUserIds.projectLead,
      content: {
        schemaVersion: 1,
        kind: "project_override",
        relax: [
          {
            ruleId: "base-import-address",
            reasonCode: "source_data_not_provided",
            approvedBy: seedStaffUserIds.regionalOperationsManager,
            approvedOn: "2026-10-01",
          },
        ],
      },
    });
    const shown = await previewOf(werkNord, { file, mapping });
    expect(shown.missingTargets).toEqual([]);
    expect(shown.report?.counts).toMatchObject({ create: 12, error: 0 });
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions: noDecisions,
      previewToken: shown.previewToken,
    });
    expect((await readJson(res, ImportResult)).created).toBe(12);
    expect(await owner.select().from(participantDetails)).toHaveLength(12);
    const cities = await owner
      .select({ city: participantDetails.addressCity })
      .from(participantDetails);
    expect(cities.every(({ city }) => city === null)).toBe(true);
  });
});

describe("possible duplicates and warnings (AC-25, AC-26)", () => {
  const sample = bytesOf("teilnehmer-beispiel.csv").toString("utf8").split("\r\n");
  // A new Personalnummer for the person of row 4 (BSP-0003) and a 16-year-old at the Austrittsdatum.
  const extraRows = (...rows: string[]) =>
    Buffer.from([...sample.slice(0, 13), ...rows].join("\r\n")).toString("base64");
  const duplicate = sample[3]!.replace("BSP-0003", "BSP-0777");

  async function previewDuplicate() {
    await importFile(fixture("teilnehmer-beispiel.csv"));
    const file = extraRows(duplicate);
    const mapping = await suggested(werkNord, { file });
    const shown = await previewOf(werkNord, { file, mapping });
    return { file, mapping, shown };
  }

  it("needs a decision for the duplicate, and none for any other row", async () => {
    const { file, mapping, shown } = await previewDuplicate();
    expect(shown.report!.rows.map((r) => [r.row, r.outcome, r.issues.map((i) => i.code)])).toEqual([
      [14, "create", ["possible_duplicate"]],
    ]);
    const body = { file, mapping, previewToken: shown.previewToken };
    expect(await codes(await confirm(werkNord, { ...body, decisions: noDecisions }))).toEqual([
      "decisions_invalid",
      "duplicate_undecided",
    ]);
    const stray = { confirmWarnings: false, possibleDuplicates: { "14": "create", "3": "skip" } };
    expect(await codes(await confirm(werkNord, { ...body, decisions: stray }))).toEqual([
      "decisions_invalid",
      "decision_without_duplicate",
    ]);
    expect(await identities()).toHaveLength(12);
  });

  it("creates a duplicate the PL accepts, and audits the confirmed warning", async () => {
    const { file, mapping, shown } = await previewDuplicate();
    const decisions = { confirmWarnings: false, possibleDuplicates: { "14": "create" } };
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions,
      previewToken: shown.previewToken,
    });
    expect(await readJson(res, ImportResult)).toMatchObject({ created: 1, unchanged: 12 });
    const warned = await owner
      .select({ reason: auditEvent.reasonCode, participationId: auditEvent.participationId })
      .from(auditEvent)
      .where(eq(auditEvent.eventType, "warning_confirmed"));
    expect(warned).toHaveLength(1);
    expect(warned[0]!.reason).toBe("possible_duplicate");
    expect(warned[0]!.participationId).not.toBeNull();
  });

  it("skips a duplicate the PL declines, and audits no warning for it", async () => {
    const { file, mapping, shown } = await previewDuplicate();
    const decisions = { confirmWarnings: false, possibleDuplicates: { "14": "skip" } };
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions,
      previewToken: shown.previewToken,
    });
    expect(await readJson(res, ImportResult)).toMatchObject({ created: 0, skipped: 1 });
    expect(await identities()).toHaveLength(12);
    expect(
      await owner.select().from(auditEvent).where(eq(auditEvent.eventType, "warning_confirmed")),
    ).toHaveLength(0);
  });

  it("needs the other warnings confirmed", async () => {
    // Austrittsdatum 31.12.2026 against a birth date in 2012: age 14, implausible.
    const young = sample[1]!.replace("01.01.1965", "01.01.2012").replace("BSP-0001", "BSP-0888");
    const file = Buffer.from([...sample.slice(0, 1), young].join("\r\n")).toString("base64");
    const mapping = await suggested(werkNord, { file });
    const shown = await previewOf(werkNord, { file, mapping });
    expect(shown.report!.counts).toMatchObject({ warnings: 1, create: 1 });
    const body = { file, mapping, previewToken: shown.previewToken };
    expect(await codes(await confirm(werkNord, { ...body, decisions: noDecisions }))).toEqual([
      "decisions_invalid",
      "warnings_unconfirmed",
    ]);
    const decisions = { confirmWarnings: true, possibleDuplicates: {} };
    expect((await confirm(werkNord, { ...body, decisions })).status).toBe(200);
    const warned = await owner
      .select({ reason: auditEvent.reasonCode })
      .from(auditEvent)
      .where(eq(auditEvent.eventType, "warning_confirmed"));
    expect(warned).toEqual([{ reason: "age_implausible" }]);
  });
});

describe("a stale or foreign preview (AC-26)", () => {
  it("refuses a confirm whose plan changed since the preview with 409, writing nothing", async () => {
    const file = fixture("teilnehmer-beispiel.csv");
    const mapping = await suggested(werkNord, { file });
    const shown = await previewOf(werkNord, { file, mapping });
    // Someone else imports the same file first.
    expect((await importFile(file)).status).toBe(200);
    const before = await counts();
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions: noDecisions,
      previewToken: shown.previewToken,
    });
    expect(await codes(res, 409)).toEqual(["import_preview_stale"]);
    expect(await counts()).toEqual(before);
  });

  it("binds the token to the file, the mapping, the country, the wave and the header row", async () => {
    const file = fixture("teilnehmer-beispiel.csv");
    const mapping = await suggested(werkNord, { file });
    const shown = await previewOf(werkNord, { file, mapping });
    const body = { file, mapping, decisions: noDecisions, previewToken: shown.previewToken };
    const other = fixture("teilnehmer-aktualisiert.csv");
    for (const changed of [
      { file: other },
      { mapping: mapping.filter((m) => m.target !== "phone") },
      { headerRow: 2 },
    ]) {
      const res = await confirm(werkNord, { ...body, ...changed });
      expect([409, 422]).toContain(res.status);
      expect(await identities()).toHaveLength(0);
    }
    expect(
      await codes(await confirm(werkNord, { ...body, previewToken: "f".repeat(64) }), 409),
    ).toEqual(["import_preview_stale"]);
    // A token of another project is no token here.
    expect((await confirm(verwaltung, body)).status).toBe(409);
  });

  it("serialises two concurrent confirms of one project: one wins, the other re-plans and is stale", async () => {
    const file = fixture("teilnehmer-beispiel.csv");
    const mapping = await suggested(werkNord, { file });
    const shown = await previewOf(werkNord, { file, mapping });
    const body = { file, mapping, decisions: noDecisions, previewToken: shown.previewToken };
    const statuses = (await Promise.all([confirm(werkNord, body), confirm(werkNord, body)])).map(
      (r) => r.status,
    );
    expect(statuses.toSorted()).toEqual([200, 409]);
    expect(await identities()).toHaveLength(12);
  });

  it("refuses a mapping that lacks required targets at the confirm, before it looks at the token", async () => {
    const csv = bytesOf("teilnehmer-beispiel.csv")
      .toString("utf8")
      .split("\r\n")
      .map((line) => line.split(";").slice(0, 3).join(";"))
      .join("\r\n");
    const file = Buffer.from(csv).toString("base64");
    const mapping = await suggested(werkNord, { file });
    // Without birth date, Austrittsdatum and address the mapping is incomplete (no relaxation).
    expect((await previewOf(werkNord, { file, mapping })).missingTargets).toContain("birthDate");
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions: noDecisions,
      previewToken: "a".repeat(64),
    });
    expect(await codes(res)).toContain("mapping_invalid");
  });
});

describe("access, logs and saved mappings (AC-30, AC-31)", () => {
  it("lets only the project's PL preview and confirm", async () => {
    const body = { file: fixture("teilnehmer-beispiel.csv") };
    for (const user of ["consultant", "backOffice", "admin", "regionalOperationsManager"]) {
      expect((await preview(werkNord, body, user)).status).toBe(403);
      expect(
        (
          await confirm(
            werkNord,
            {
              ...body,
              mapping: [{ column: 0, target: "phone" }],
              decisions: noDecisions,
              previewToken: "a".repeat(64),
            },
            user,
          )
        ).status,
      ).toBe(403);
    }
    // A project the user can't see is a 404 (a member of another project only).
    const created = await readJson(
      await app.request(
        "/api/v1/projects",
        jsonRequest(
          "POST",
          { name: "Fremd", customerName: "Andere GmbH", type: "ta_only" },
          auth.projectLead,
        ),
      ),
      Project,
    );
    expect((await preview(created.id, body, "consultant")).status).toBe(404);
    expect((await preview(crypto.randomUUID(), body)).status).toBe(404);
  });

  it("logs no file name, header or value", async () => {
    await importFile(fixture("teilnehmer-beispiel.csv"));
    await preview(werkNord, { file: fixture("teilnehmer-fehler.csv") });
    const text = logs.join("\n");
    expect(text).toContain("import confirmed");
    for (const secret of [
      "Mustermann",
      "Personalnummer",
      "BSP-0001",
      "teilnehmer",
      "example.org",
      "23125",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("returns codes and rows only in problem bodies", async () => {
    const res = await preview(werkNord, {
      file: fixture("teilnehmer-beispiel.csv"),
      sheet: "Mustermann",
    });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("Mustermann");
  });

  it("saves only keyed hashes of the headers and suggests them to the next file of the customer", async () => {
    // A header no built-in synonym covers: the PL maps it by hand.
    const sample = bytesOf("teilnehmer-beispiel.csv")
      .toString("utf8")
      .replace("Personalnummer", "Kennzahl");
    const file = Buffer.from(sample).toString("base64");
    const unmapped = await previewOf(werkNord, { file });
    expect(unmapped.suggestedMapping.some((s) => s.column === 0)).toBe(false);
    expect(unmapped.missingTargets).toEqual(["personnelNumber"]);
    const mapping = [
      ...unmapped.suggestedMapping.map(({ column, target }) => ({ column, target })),
      { column: 0, target: "personnelNumber" as const },
    ];
    const shown = await previewOf(werkNord, { file, mapping });
    // A preview stores nothing (AC-31).
    expect(await owner.select().from(importColumnMapping)).toHaveLength(0);
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions: noDecisions,
      previewToken: shown.previewToken,
    });
    expect(res.status).toBe(200);
    const saved = await owner.select().from(importColumnMapping);
    expect(saved).toHaveLength(12);
    for (const row of saved) expect(row.headerHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(saved)).not.toMatch(/Kennzahl|Nachname|Vorname/);
    expect(suggestionOfFirstColumn(await previewOf(werkNord, { file }))).toEqual({
      column: 0,
      target: "personnelNumber",
      source: "project",
    });
    // Another project of the same customer (trimmed, case-folded) gets it as the customer's.
    const customer = (
      await owner
        .select({ name: project.customerName })
        .from(project)
        .where(eq(project.id, werkNord))
    )[0]!.name;
    const second = await readJson(
      await app.request(
        "/api/v1/projects",
        jsonRequest(
          "POST",
          { name: "Zweites Projekt", customerName: `${customer.toUpperCase()}`, type: "ta_only" },
          auth.projectLead,
        ),
      ),
      Project,
    );
    expect(suggestionOfFirstColumn(await previewOf(second.id, { file }))).toEqual({
      column: 0,
      target: "personnelNumber",
      source: "customer",
    });
    // Nothing else is stored by a preview.
    expect(await owner.select().from(importColumnMapping)).toHaveLength(12);
  });

  it("saves a header that two mapped columns share once, for the first column", async () => {
    // "Mobil" renamed: two "Telefon" columns, mapped to phone and mobile by hand.
    const sample = bytesOf("teilnehmer-beispiel.csv")
      .toString("utf8")
      .replace("Telefon;Mobil", "Telefon;Telefon");
    const file = Buffer.from(sample).toString("base64");
    const mapping = [
      ...(await suggested(werkNord, { file })),
      { column: 10, target: "mobile" as const },
    ];
    const shown = await previewOf(werkNord, { file, mapping });
    const res = await confirm(werkNord, {
      file,
      mapping,
      decisions: noDecisions,
      previewToken: shown.previewToken,
    });
    expect(res.status).toBe(200);
    expect(await owner.select().from(importColumnMapping)).toHaveLength(11);
    const next = await previewOf(werkNord, { file });
    expect(next.suggestedMapping.filter((s) => s.column >= 9 && s.column <= 10)).toEqual([
      { column: 9, target: "phone", source: "project" },
    ]);
  });
});
