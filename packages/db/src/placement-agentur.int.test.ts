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
} from "./testing";

// Q139 (regional-variation.md, "Placement Agentur"): set_placement_agentur sets the key of a
// participation that isn't terminal, for the PL or back office of its project, and pins a template
// version in the same transaction when the API passes one.
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner });
const app = new Client({ connectionString: urls.app });

beforeAll(() => Promise.all([owner.connect(), app.connect()]));
afterAll(() => Promise.all([owner.end(), app.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const { werkNord, lagerSued } = seedProjectIds;
const staff = (staffUserId: string) => auditContext({ actorType: "user", staffUserId });
const backOffice = staff(seedStaffUserIds.backOffice);

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const template = (agenturKey = "test-agentur", version = 1) => ({
  kind: "regional_template",
  id: agenturKey,
  agenturKey,
  version,
  label: { de: "Test" },
});
const pinArgs = (agenturKey = "test-agentur", version = 1) => ({
  pinVersion: version,
  pinContent: template(agenturKey, version),
  pinSha256: "a".repeat(64),
});

const place = (participationId: string, args: Record<string, unknown> = {}) =>
  call(app, "set_placement_agentur", {
    participationId,
    agenturKey: "test-agentur",
    baseDefaultsVersion: 1,
    context: pl,
    ...args,
  });

const placementOf = async (id: string) =>
  (
    await owner.query(
      "select placement_agentur_key as key, placement_agentur_set_at is not null as set from participation where id = $1",
      [id],
    )
  ).rows[0] as { key: string | null; set: boolean };

const pinsOf = async (projectId: string) =>
  (
    await owner.query(
      "select agentur_key, version from project_template_pin where project_id = $1 order by seq",
      [projectId],
    )
  ).rows;

const auditOf = async (projectId: string, type: string) =>
  (
    await owner.query(
      "select participation_id, actor_staff_user_id, details from audit_event where project_id = $1 and event_type = $2 order by seq",
      [projectId, type],
    )
  ).rows;

describe("set_placement_agentur (Q139)", () => {
  it("pins a template version and sets the key in one transaction, audited", async () => {
    const id = await informedParticipation(app);
    await place(id, pinArgs());
    expect(await placementOf(id)).toEqual({ key: "test-agentur", set: true });
    expect(await pinsOf(werkNord)).toEqual([{ agentur_key: "test-agentur", version: 1 }]);
    expect(await auditOf(werkNord, "config_template_pinned")).toEqual([
      {
        participation_id: null,
        actor_staff_user_id: seedStaffUserIds.projectLead,
        details: { agenturKey: "test-agentur", version: 1, baseDefaultsVersion: 1 },
      },
    ]);
    expect(await auditOf(werkNord, "placement_agentur_set")).toEqual([
      {
        participation_id: id,
        actor_staff_user_id: seedStaffUserIds.projectLead,
        details: { agenturKey: "test-agentur", baseDefaultsVersion: 1 },
      },
    ]);
  });

  it("sets a key without a pin (a pinned Agentur or none in the catalog), naming the replaced key", async () => {
    const id = await informedParticipation(app);
    await place(id, { agenturKey: "ohne-vorlage" });
    await place(id, { context: backOffice });
    expect(await placementOf(id)).toEqual({ key: "test-agentur", set: true });
    expect(await pinsOf(werkNord)).toEqual([]);
    expect((await auditOf(werkNord, "placement_agentur_set")).map((e) => e.details)).toEqual([
      { agenturKey: "ohne-vorlage", baseDefaultsVersion: 1 },
      { agenturKey: "test-agentur", previousAgenturKey: "ohne-vorlage", baseDefaultsVersion: 1 },
    ]);
  });

  it("works in a draft project too", async () => {
    const id = await call(app, "create_participation", { projectId: lagerSued, context: pl });
    await place(id, pinArgs());
    expect(await placementOf(id)).toEqual({ key: "test-agentur", set: true });
    expect(await pinsOf(lagerSued)).toHaveLength(1);
  });

  it("refuses the pin of an Agentur the project has pinned, and writes nothing", async () => {
    const id = await informedParticipation(app);
    const other = await informedParticipation(app);
    await place(id, pinArgs());
    expect(await refusal(place(other, pinArgs()))).toBe("template_already_pinned");
    expect(await placementOf(other)).toEqual({ key: null, set: false });
    expect(await auditOf(werkNord, "placement_agentur_set")).toHaveLength(1);
  });

  it("rolls the pin back with a refused key (content and hash checked as for every pin)", async () => {
    const first = await informedParticipation(app, { projectId: werkNord });
    await place(first, pinArgs());
    const id = await call(app, "create_participation", { projectId: lagerSued, context: pl });
    const changed = { ...pinArgs(), pinSha256: "c".repeat(64) };
    expect(await refusal(place(id, changed))).toBe("template_version_changed");
    expect(await pinsOf(lagerSued)).toEqual([]);
    expect(await placementOf(id)).toEqual({ key: null, set: false });
  });

  it("refuses a terminal participation and the same key again", async () => {
    const id = await informedParticipation(app);
    await place(id);
    expect(await refusal(place(id))).toBe("placement_agentur_unchanged");
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-10-21",
    });
    expect(await refusal(place(id, { agenturKey: "andere" }))).toBe("participation_closed");
    expect(await placementOf(id)).toEqual({ key: "test-agentur", set: true });
  });

  it.each([
    ["the consultant", staff(seedStaffUserIds.consultant), "actor_not_allowed"],
    ["the admin (an org role)", staff(seedStaffUserIds.admin), "actor_not_allowed"],
    [
      "the regional operations manager",
      staff(seedStaffUserIds.regionalOperationsManager),
      "actor_not_allowed",
    ],
    ["the system", auditContext({ actorType: "system", systemJob: "seed" }), "actor_not_allowed"],
  ])("refuses %s", async (_label, context, code) => {
    const id = await informedParticipation(app);
    expect(await refusal(place(id, { context }))).toBe(code);
    expect(await placementOf(id)).toEqual({ key: null, set: false });
  });

  it("refuses assisted mode and a deactivated member", async () => {
    const id = await informedParticipation(app);
    const assisted = auditContext({
      actorType: "user",
      staffUserId: seedStaffUserIds.projectLead,
      onBehalfOf: id,
    });
    expect(await refusal(place(id, { context: assisted }))).toBe("invalid_actor");
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [
      seedStaffUserIds.backOffice,
    ]);
    expect(await refusal(place(id, { context: backOffice }))).toBe("actor_not_allowed");
  });

  it.each([
    ["a malformed key", { agenturKey: "Agentur Nord" }],
    ["no key", { agenturKey: null }],
    ["no base-defaults version", { baseDefaultsVersion: null }],
    ["a partial pin", { pinVersion: 1, pinContent: template() }],
  ])("refuses %s (invalid_argument)", async (_label, args) => {
    const id = await informedParticipation(app);
    expect(await refusal(place(id, args))).toBe("invalid_argument");
  });

  it("refuses an unknown participation", async () => {
    expect(await refusal(place("00000000-0000-4000-8000-0000000000ff"))).toBe(
      "participation_not_found",
    );
  });

  it("is the only writer: the runtime role can't update the columns or record the event", async () => {
    const id = await informedParticipation(app);
    expect(
      await refusal(
        app.query("update participation set placement_agentur_key = 'x' where id = $1", [id]),
      ),
    ).toBe("42501");
    expect(
      await refusal(
        call(app, "record_audit_event", {
          projectId: werkNord,
          participationId: id,
          eventType: "placement_agentur_set",
          context: pl,
        }),
      ),
    ).toBe("event_type_reserved");
  });

  it("keeps the key and its time together and the key in the template key format", async () => {
    const id = await informedParticipation(app);
    expect(
      await refusal(
        owner.query("update participation set placement_agentur_key = 'nord' where id = $1", [id]),
      ),
    ).toBe("23514");
    expect(
      await refusal(
        owner.query(
          "update participation set placement_agentur_key = 'Nord', placement_agentur_set_at = now() where id = $1",
          [id],
        ),
      ),
    ).toBe("23514");
  });
});
