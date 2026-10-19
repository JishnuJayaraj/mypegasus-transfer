import { describe, expect, it } from "vitest";
import {
  checkMigrationDecisions,
  MigrateTemplateInput,
  MigrationPreviewInput,
  migrationTargets,
  planTemplateMigration,
  TemplateMigrationPreview,
} from "./migration";

// Slice 2 plan 5.8 (PR 2e-2; Q36, Q93, R15): a pinned Agentur moves to a newer catalog version
// only through a migration with review. Fictional Agenturen only (D8).
const catalog = [
  { agenturKey: "nord", version: 1 },
  { agenturKey: "nord", version: 2 },
  { agenturKey: "nord", version: 3 },
  { agenturKey: "sued", version: 1 },
];

describe("migrationTargets (5.8)", () => {
  it("lists the newer catalog versions of the pinned Agentur, ascending", () => {
    expect(migrationTargets(catalog.toReversed(), { agenturKey: "nord", version: 1 })).toEqual([
      2, 3,
    ]);
    expect(migrationTargets(catalog, { agenturKey: "nord", version: 3 })).toEqual([]);
    expect(migrationTargets(catalog, { agenturKey: "sued", version: 1 })).toEqual([]);
  });
});

/** A confirm whose review was made on version 1, with the Agentur pinned at `pinned` now. */
const confirm = (version: number, pinned: number) =>
  planTemplateMigration({
    catalog,
    pin: { agenturKey: "nord", version: pinned },
    version,
    fromVersion: 1,
  });

describe("planTemplateMigration (5.8)", () => {
  const pin = { agenturKey: "nord", version: 2 };
  const plan = (version: number) => planTemplateMigration({ catalog, pin, version });

  it("moves a pinned Agentur to a newer catalog version", () => {
    expect(plan(3)).toEqual({ fromVersion: 2 });
  });

  it("is nothing for an Agentur the project hasn't pinned (the route's 404)", () => {
    expect(planTemplateMigration({ catalog, pin: undefined, version: 3 })).toBeNull();
  });

  it("refuses a version outside the catalog, the pinned one and an older one, at /version", () => {
    expect(plan(4)).toEqual({ issues: [{ code: "template_not_in_catalog", field: "version" }] });
    expect(plan(2)).toEqual({ issues: [{ code: "template_already_pinned", field: "version" }] });
    expect(plan(1)).toEqual({
      issues: [{ code: "template_version_not_newer", field: "version" }],
    });
  });

  // Round 31: a confirm is checked against the version its review was made on; a pin that moved
  // since is stale (409), whether another migration reached the target or went beyond it.
  describe("a confirm with the version its review was made on", () => {
    it("moves on when the pin is still that version", () => {
      expect(confirm(2, 1)).toEqual({ fromVersion: 1 });
    });

    it("is stale when another migration reached the target or went beyond it", () => {
      expect(confirm(2, 2)).toEqual({ stale: true });
      expect(confirm(2, 3)).toEqual({ stale: true });
    });

    it("checks the target against the declared version first (422 before 409)", () => {
      expect(confirm(1, 3)).toEqual({
        issues: [{ code: "template_already_pinned", field: "version" }],
      });
      expect(confirm(4, 3)).toEqual({
        issues: [{ code: "template_not_in_catalog", field: "version" }],
      });
      const older = planTemplateMigration({
        catalog,
        pin: { agenturKey: "nord", version: 3 },
        version: 1,
        fromVersion: 2,
      });
      expect(older).toEqual({ issues: [{ code: "template_version_not_newer", field: "version" }] });
    });
  });
});

describe("checkMigrationDecisions (R15, AC-19)", () => {
  const keys = ["agentur_submission.leadTimeDays", "asu_registration.batchSubmissionChannel"];
  const incomplete = [{ code: "review_incomplete", field: "decisions" }];

  it("needs keep or remove for exactly the review's keys", () => {
    const decisions = {
      "agentur_submission.leadTimeDays": "remove",
      "asu_registration.batchSubmissionChannel": "keep",
    } as const;
    expect(checkMigrationDecisions(keys, decisions)).toEqual([]);
    expect(checkMigrationDecisions([], {})).toEqual([]);
  });

  it("refuses a missing, an extra or a replaced key", () => {
    expect(checkMigrationDecisions(keys, { "agentur_submission.leadTimeDays": "keep" })).toEqual(
      incomplete,
    );
    expect(checkMigrationDecisions([], { "agentur_submission.leadTimeDays": "keep" })).toEqual(
      incomplete,
    );
    expect(
      checkMigrationDecisions(keys, {
        "agentur_submission.leadTimeDays": "keep",
        "agentur_submission.submissionChannel": "keep",
      }),
    ).toEqual(incomplete);
  });
});

describe("the migration's inputs and preview", () => {
  it("are strict", () => {
    expect(MigrationPreviewInput.safeParse({ version: 2 }).success).toBe(true);
    expect(MigrationPreviewInput.safeParse({ version: 2, content: {} }).success).toBe(false);
    const input = {
      fromVersion: 1,
      version: 2,
      expectedVersion: 0,
      decisions: { "agentur_submission.leadTimeDays": "remove" },
    };
    expect(MigrateTemplateInput.parse(input)).toEqual(input);
    expect(MigrateTemplateInput.safeParse({ ...input, sha256: "0" }).success).toBe(false);
    const decisions = { "agentur_submission.leadTimeDays": "drop" };
    expect(MigrateTemplateInput.safeParse({ ...input, decisions }).success).toBe(false);
    const key = { "leadTimeDays=7": "keep" };
    expect(MigrateTemplateInput.safeParse({ ...input, decisions: key }).success).toBe(false);
  });

  it("describes what the new version changes and the review", () => {
    const preview = {
      agenturKey: "nord",
      fromVersion: 1,
      version: 2,
      expectedVersion: 1,
      settings: [{ key: "agentur_submission.leadTimeDays", from: 10, to: 14 }],
      rules: {
        added: [{ id: "nord-mobile", step: "data_collection", basis: "operational_default" }],
        removed: [],
        changed: [],
      },
      fields: { added: [], removed: ["custom.nachweis"], changed: [] },
      overrideIssues: [],
      review: [{ key: "agentur_submission.leadTimeDays", value: 12, from: 10, to: 14 }],
    };
    expect(TemplateMigrationPreview.parse(preview)).toEqual(preview);
    const step = { ...preview, rules: { ...preview.rules, removed: [{ id: "x", step: "x" }] } };
    expect(TemplateMigrationPreview.safeParse(step).success).toBe(false);
    // The Agentur is a key, as everywhere else (round 31).
    const key = { ...preview, agenturKey: "Agentur Nord" };
    expect(TemplateMigrationPreview.safeParse(key).success).toBe(false);
  });
});
