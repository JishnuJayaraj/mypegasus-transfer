import { describe, expect, it } from "vitest";
import { migrationPreview, withReviewedSetting } from "./migration";
import type { BaseDefaults, ProjectOverride, RegionalTemplate } from "./model";

// Slice 2 plan 5.8 (PR 2e-2, AC-19; Q36, Q93, R15): what a template migration changes and the
// review of the Agentur-scoped setting. Fictional Agenturen and staff ids only (D8).
const staffId = "00000000-0000-4000-8000-000000000003";
const nord = "beispielstadt-nord";
const sued = "beispielstadt-sued";

const base: BaseDefaults = {
  schemaVersion: 1,
  kind: "base_defaults",
  version: 1,
  nationwide: {
    asuDueDate: { monthsBeforeEnd: 3, daysAfterKnowledge: 3 },
    profilingExceptionDeadlineMonths: 1,
    kug200bConfirmationFollowUpDays: 14,
    tl407EscalationDaysAfterTgStart: 14,
    cutoffWarningDays: 14,
    cutoffFinalReminderDays: 3,
  },
  rules: {
    data_collection: [
      { id: "base-name", kind: "required", field: "lastName", basis: "operational_default" },
    ],
  },
};
const field = (label: string) =>
  ({
    type: "string",
    maxLength: 40,
    "x-dataClass": "confidential",
    "x-retentionClass": "participation_record",
    "x-label": { de: label },
  }) as const;
const template = (version: number, rest: Partial<RegionalTemplate>): RegionalTemplate => ({
  schemaVersion: 1,
  kind: "regional_template",
  id: nord,
  version,
  agenturKey: nord,
  label: { de: "Nord" },
  ...rest,
});
const v1 = template(1, {
  settings: {
    asu_registration: { defaultChannel: "kug_200b", batchSubmissionChannel: "scan_email" },
    agentur_submission: { submissionChannel: "upload", leadTimeDays: 10 },
  },
  fields: { "custom.alt": field("Alt"), "custom.nachweis": field("Nachweis") },
  rules: {
    data_collection: [
      { id: "nord-alt", kind: "required", field: "custom.alt", basis: "operational_default" },
      { id: "nord-nachweis", kind: "required", field: "custom.nachweis" },
      { id: "nord-phone", kind: "required", field: "phone", basis: "operational_default" },
    ],
  },
});
const v2 = template(2, {
  settings: {
    asu_registration: { batchSubmissionChannel: "upload", defaultChannel: "kug_200b" },
    agentur_submission: { submissionChannel: "upload", leadTimeDays: 14, originalRequired: false },
  },
  // The same field with its keys in another order is no change; another label is.
  fields: {
    "custom.nachweis": Object.fromEntries(
      Object.entries(field("Nachweis")).toReversed(),
    ) as ReturnType<typeof field>,
    "custom.neu": field("Neu"),
  },
  rules: {
    data_collection: [
      { id: "nord-nachweis", kind: "required", field: "custom.nachweis", basis: "ba_form" },
      { id: "nord-phone", kind: "required", field: "phone", basis: "operational_default" },
    ],
    profiling: [{ id: "nord-mobile", kind: "required", field: "mobile" }],
  },
});
const scoped = (settings: object) => ({
  settings,
  source: "email_agentur",
  confirmedBy: staffId,
  confirmedOn: "2026-10-01",
});
const override = (agenturSettings: object, rest: object = {}) =>
  ({
    schemaVersion: 1,
    kind: "project_override",
    agenturSettings,
    ...rest,
  }) as ProjectOverride;
const preview = (current: ProjectOverride | undefined, target = v2, from = v1) =>
  migrationPreview({
    base,
    templatesByAgentur: { [nord]: from, [sued]: template(1, { id: sued, agenturKey: sued }) },
    agenturKey: nord,
    target,
    override: current,
    projectType: "ta_tg",
  });

describe("migrationPreview (5.8, AC-19)", () => {
  it("lists the settings that differ, with the old and new template value", () => {
    expect(preview(undefined).settings).toEqual([
      { key: "agentur_submission.leadTimeDays", from: 10, to: 14 },
      { key: "agentur_submission.originalRequired", from: null, to: false },
      { key: "asu_registration.batchSubmissionChannel", from: "scan_email", to: "upload" },
    ]);
    const none = template(2, {});
    expect(preview(undefined, none).settings.map(({ to }) => to)).toEqual([null, null, null, null]);
  });

  it("lists the rules added, removed and changed, with their steps and bases", () => {
    expect(preview(undefined).rules).toEqual({
      added: [{ id: "nord-mobile", step: "profiling" }],
      removed: [{ id: "nord-alt", step: "data_collection", basis: "operational_default" }],
      changed: [{ id: "nord-nachweis", step: "data_collection", basis: "ba_form" }],
    });
  });

  it("lists the custom fields added, removed and changed, never by key order alone", () => {
    expect(preview(undefined).fields).toEqual({
      added: ["custom.neu"],
      removed: ["custom.alt"],
      changed: [],
    });
    const renamed = template(2, { fields: { "custom.nachweis": field("Anders") } });
    expect(preview(undefined, renamed).fields).toEqual({
      added: [],
      removed: ["custom.alt"],
      changed: ["custom.nachweis"],
    });
    expect(preview(undefined, template(3, {}), template(2, {})).fields).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("names the issues the current override would have with the new version (AC-16)", () => {
    expect(preview(undefined).overrideIssues).toEqual([]);
    // Valid with version 1, but version 2 brings a rule of the same id (round 15).
    const own = override(
      {},
      {
        rules: {
          data_collection: [{ id: "nord-mobile", kind: "required", field: "mobile" }],
        },
      },
    );
    expect(preview(own, v1, v1).overrideIssues).toEqual([]);
    expect(preview(own).overrideIssues).toEqual(["rule_redefined"]);
  });

  it("reviews every key of the Agentur's scoped setting with the old and new template value", () => {
    const current = override({
      [nord]: scoped({
        agentur_submission: { leadTimeDays: 12, rejectsOutdatedFormVersions: true },
        asu_registration: { batchSubmissionChannel: "paper_post" },
      }),
      [sued]: scoped({ agentur_submission: { leadTimeDays: 3 } }),
    });
    expect(preview(current).review).toEqual([
      { key: "agentur_submission.leadTimeDays", value: 12, from: 10, to: 14 },
      { key: "agentur_submission.rejectsOutdatedFormVersions", value: true, from: null, to: null },
      {
        key: "asu_registration.batchSubmissionChannel",
        value: "paper_post",
        from: "scan_email",
        to: "upload",
      },
    ]);
    // Another Agentur's setting isn't reviewed; without one there is nothing to review.
    expect(preview(override({ [sued]: scoped({}) })).review).toEqual([]);
    expect(preview(undefined).review).toEqual([]);
  });
});

describe("withReviewedSetting (R15)", () => {
  const current = override(
    {
      [nord]: scoped({
        agentur_submission: { leadTimeDays: 12, submissionChannel: "email" },
        asu_registration: { batchSubmissionChannel: "paper_post" },
      }),
      [sued]: scoped({ agentur_submission: { leadTimeDays: 3 } }),
    },
    { relax: [] },
  );

  it("removes the keys decided remove and keeps the rest with its confirmation", () => {
    const next = withReviewedSetting(current, nord, {
      "agentur_submission.leadTimeDays": "remove",
      "agentur_submission.submissionChannel": "keep",
      "asu_registration.batchSubmissionChannel": "remove",
    });
    expect(next).toEqual(
      override(
        {
          [nord]: scoped({ agentur_submission: { submissionChannel: "email" } }),
          [sued]: scoped({ agentur_submission: { leadTimeDays: 3 } }),
        },
        { relax: [] },
      ),
    );
  });

  it("removes the setting once no key is left", () => {
    const next = withReviewedSetting(current, nord, {
      "agentur_submission.leadTimeDays": "remove",
      "agentur_submission.submissionChannel": "remove",
      "asu_registration.batchSubmissionChannel": "remove",
    });
    expect(next).toEqual(
      override({ [sued]: scoped({ agentur_submission: { leadTimeDays: 3 } }) }, { relax: [] }),
    );
  });

  it("is null when nothing is removed or there is no setting to review", () => {
    const keep = { "agentur_submission.leadTimeDays": "keep" } as const;
    expect(withReviewedSetting(current, nord, keep)).toBeNull();
    expect(withReviewedSetting(current, nord, {})).toBeNull();
    const remove = { "agentur_submission.leadTimeDays": "remove" } as const;
    expect(withReviewedSetting(undefined, nord, remove)).toBeNull();
    expect(withReviewedSetting(override({}), nord, remove)).toBeNull();
  });
});
