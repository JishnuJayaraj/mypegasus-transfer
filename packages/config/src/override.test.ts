import { describe, expect, it } from "vitest";
import type { BaseDefaults, ProjectOverride, RegionalTemplate } from "./model";
import {
  RelaxationReasonCode,
  relaxableRules,
  validateProjectOverride,
  withAgenturSetting,
  withRelaxation,
} from "./override";

// Slice 2 plan 5.9 (PR 2d-1, AC-13): the override against the base-only chain and every pinned
// Agentur chain (round 15, R16). Fictional Agenturen and staff ids only (D8).
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
      { id: "base-birth", kind: "required", field: "birthDate", basis: "ba_form" },
    ],
    project_checklist: [
      {
        id: "base-check",
        kind: "required",
        field: "personnelNumber",
        basis: "operational_default",
      },
    ],
  },
};
const customField = {
  type: "string",
  maxLength: 40,
  "x-dataClass": "confidential",
  "x-retentionClass": "participation_record",
  "x-label": { de: "Nachweis" },
} as const;
const nordTemplate: RegionalTemplate = {
  schemaVersion: 1,
  kind: "regional_template",
  id: nord,
  version: 1,
  agenturKey: nord,
  label: { de: "Nord" },
  fields: { "custom.nachweis": customField },
  rules: {
    data_collection: [
      { id: "nord-mobile", kind: "required", field: "mobile", basis: "operational_default" },
    ],
  },
};
const suedTemplate: RegionalTemplate = { ...nordTemplate, id: sued, agenturKey: sued };
delete (suedTemplate as { rules?: unknown }).rules;
delete (suedTemplate as { fields?: unknown }).fields;
const both = { [nord]: nordTemplate, [sued]: suedTemplate };

const relaxation = (ruleId: string, reasonCode = "source_data_not_provided") => ({
  ruleId,
  reasonCode,
  approvedBy: staffId,
  approvedOn: "2026-10-16",
});
const empty: ProjectOverride = { schemaVersion: 1, kind: "project_override" };
const validate = (override: object, templatesByAgentur: Record<string, RegionalTemplate> = both) =>
  validateProjectOverride({ base, templatesByAgentur, override, projectType: "ta_tg" });

describe("validateProjectOverride (AC-13)", () => {
  it("accepts an empty override and Agentur-scoped settings, also of an Agentur without a template", () => {
    expect(validate(empty)).toEqual({ ok: true, override: empty });
    const scoped = {
      ...empty,
      agenturSettings: {
        "beispielstadt-ost": {
          settings: { agentur_submission: { leadTimeDays: 7 } },
          source: "email_agentur",
          confirmedBy: staffId,
          confirmedOn: "2026-10-16",
        },
      },
    };
    expect(validate(scoped)).toEqual({ ok: true, override: scoped });
  });

  it("fails an override that isn't a valid override layer on its own", () => {
    expect(validate({ ...empty, settings: {} })).toEqual({
      ok: false,
      layer: "override",
      issues: [{ code: "project_wide_setting", path: [], key: "settings" }],
    });
    expect(validate(nordTemplate)).toEqual({
      ok: false,
      layer: "override",
      issues: [{ code: "wrong_layer_kind", path: ["kind"] }],
    });
  });

  it("fails a rule on a custom field that only one template declares (round 15)", () => {
    const rule = { id: "o-nachweis", kind: "required", field: "custom.nachweis" };
    const result = validate({ ...empty, rules: { data_collection: [rule] } });
    expect(result).toMatchObject({
      ok: false,
      layer: "override",
      issues: [{ code: "unknown_field", key: "custom.nachweis" }],
    });
  });

  it("fails an override field that a pinned template declares too, in that chain", () => {
    const result = validate({ ...empty, fields: { "custom.nachweis": customField } });
    expect(result).toEqual({
      ok: false,
      layer: "override",
      issues: [
        { code: "field_redefined", path: ["fields", "custom.nachweis"], key: "custom.nachweis" },
      ],
    });
    // Without that pin the same override is valid.
    expect(
      validate({ ...empty, fields: { "custom.nachweis": customField } }, { [sued]: suedTemplate }),
    ).toMatchObject({ ok: true });
  });

  it("accepts relaxations matching a base rule, a project rule or one pinned chain's rule", () => {
    const relax = [relaxation("base-name"), relaxation("base-check"), relaxation("nord-mobile")];
    expect(validate({ ...empty, relax })).toMatchObject({ ok: true });
  });

  it("fails a relaxation that matches no chain (relaxation_unmatched)", () => {
    const relax = [relaxation("nord-mobile"), relaxation("nord-mobil")];
    expect(validate({ ...empty, relax })).toEqual({
      ok: false,
      layer: "override",
      issues: [{ code: "relaxation_unmatched", path: ["relax", 1, "ruleId"], key: "nord-mobil" }],
    });
    // Nord's rule exists only while Nord is pinned.
    expect(
      validate({ ...empty, relax: [relaxation("nord-mobile")] }, { [sued]: suedTemplate }),
    ).toMatchObject({ ok: false, issues: [{ code: "relaxation_unmatched" }] });
  });

  it("fails a relaxation of a locked rule (relaxation_locked)", () => {
    expect(validate({ ...empty, relax: [relaxation("base-birth")] })).toEqual({
      ok: false,
      layer: "override",
      issues: [{ code: "relaxation_locked", path: ["relax", 0, "ruleId"], key: "base-birth" }],
    });
  });

  // Round 28: a rule for another project type is never relaxed, also by a direct request.
  it.each([
    ["ta_only", "ta_tg"],
    ["ta_tg", "ta_only"],
  ] as const)(
    "fails a relaxation of a %s-only rule in a %s project (relaxation_unmatched)",
    (ruleType, projectType) => {
      const typed = structuredClone(base);
      typed.rules!.data_collection![0] = {
        ...typed.rules!.data_collection![0]!,
        projectTypes: [ruleType],
      };
      const override = { ...empty, relax: [relaxation("base-name")] };
      const run = (type: typeof projectType | typeof ruleType) =>
        validateProjectOverride({
          base: typed,
          templatesByAgentur: both,
          override,
          projectType: type,
        });
      expect(run(projectType)).toEqual({
        ok: false,
        layer: "override",
        issues: [{ code: "relaxation_unmatched", path: ["relax", 0, "ruleId"], key: "base-name" }],
      });
      expect(run(ruleType)).toMatchObject({ ok: true });
    },
  );

  it("fails a reason code outside the controlled list (reason_code_unknown)", () => {
    expect(RelaxationReasonCode.options).toEqual([
      "source_data_not_provided",
      "not_needed_for_project_measures",
      "collected_outside_platform",
      "agentur_confirmed_not_required",
    ]);
    expect(validate({ ...empty, relax: [relaxation("base-name", "too_much_work")] })).toEqual({
      ok: false,
      layer: "override",
      issues: [{ code: "reason_code_unknown", path: ["relax", 0, "reasonCode"] }],
    });
  });

  it("rethrows anything that isn't a configuration error", () => {
    expect(() =>
      validateProjectOverride({
        base: null as never,
        templatesByAgentur: {},
        override: empty,
        projectType: "ta_only",
      }),
    ).toThrow(TypeError);
  });
});

describe("withAgenturSetting (5.9)", () => {
  const setting = {
    settings: { agentur_submission: { leadTimeDays: 7 } },
    source: "phone_call_agentur",
    confirmedBy: staffId,
    confirmedOn: "2026-10-16",
  } as const;

  it("adds a setting to a missing or existing override, keeping everything else", () => {
    expect(withAgenturSetting(undefined, nord, setting)).toEqual({
      ...empty,
      agenturSettings: { [nord]: setting },
    });
    const current = {
      ...empty,
      relax: [relaxation("base-name")],
      agenturSettings: { [sued]: setting },
    };
    expect(withAgenturSetting(current, nord, setting)).toEqual({
      ...current,
      agenturSettings: { [sued]: setting, [nord]: setting },
    });
  });

  it("removes a setting, and the empty map with the last one", () => {
    const current = { ...empty, agenturSettings: { [nord]: setting, [sued]: setting } };
    expect(withAgenturSetting(current, nord, null)).toEqual({
      ...empty,
      agenturSettings: { [sued]: setting },
    });
    expect(
      withAgenturSetting({ ...empty, agenturSettings: { [nord]: setting } }, nord, null),
    ).toEqual(empty);
  });
});

describe("withRelaxation (5.9, PR 2d-2)", () => {
  it("appends an approved relaxation to a missing or existing override, keeping everything else", () => {
    expect(
      withRelaxation(undefined, { ruleId: "base-name", relaxation: relaxation("base-name") }),
    ).toEqual({ ...empty, relax: [relaxation("base-name")] });
    const current = { ...empty, relax: [relaxation("base-check")], agenturSettings: {} };
    expect(
      withRelaxation(current, { ruleId: "nord-mobile", relaxation: relaxation("nord-mobile") }),
    ).toEqual({ ...current, relax: [relaxation("base-check"), relaxation("nord-mobile")] });
  });

  it("removes a relaxation, and the empty list with the last one", () => {
    const current = { ...empty, relax: [relaxation("base-check"), relaxation("nord-mobile")] };
    expect(withRelaxation(current, { ruleId: "base-check", relaxation: null })).toEqual({
      ...empty,
      relax: [relaxation("nord-mobile")],
    });
    expect(
      withRelaxation(
        { ...empty, relax: [relaxation("base-check")] },
        {
          ruleId: "base-check",
          relaxation: null,
        },
      ),
    ).toEqual(empty);
  });
});

const rules = (
  override?: ProjectOverride,
  templatesByAgentur: Record<string, RegionalTemplate> = both,
  projectType = "ta_tg",
) =>
  relaxableRules({
    base,
    templatesByAgentur,
    override,
    projectType: projectType as "ta_tg",
  });

describe("relaxableRules (5.9, PR 2d-2)", () => {
  it("lists the operational_default rules of every chain, project steps included, by id", () => {
    expect(rules()).toEqual([
      { ruleId: "base-check", step: "project_checklist" },
      { ruleId: "base-name", step: "data_collection" },
      { ruleId: "nord-mobile", step: "data_collection" },
    ]);
    // Nord's rule only while Nord is pinned.
    expect(rules(undefined, { [sued]: suedTemplate }).map((r) => r.ruleId)).toEqual([
      "base-check",
      "base-name",
    ]);
  });

  it("leaves out relaxed rules, the override's own rules and rules for another project type", () => {
    const override = {
      ...empty,
      relax: [relaxation("base-name")],
      rules: {
        data_collection: [
          { id: "o-own", kind: "required", field: "phone", basis: "operational_default" },
        ],
      },
    } as ProjectOverride;
    expect(rules(override).map((r) => r.ruleId)).toEqual(["base-check", "nord-mobile"]);
    const typed = structuredClone(base);
    typed.rules!.data_collection![0] = {
      ...typed.rules!.data_collection![0]!,
      projectTypes: ["ta_only"],
    };
    expect(
      relaxableRules({
        base: typed,
        templatesByAgentur: {},
        override: undefined,
        projectType: "ta_tg",
      }),
    ).toEqual([{ ruleId: "base-check", step: "project_checklist" }]);
  });

  it("leaves out a rule another chain locks", () => {
    const locked: RegionalTemplate = {
      ...suedTemplate,
      rules: {
        data_collection: [
          { id: "nord-mobile", kind: "required", field: "mobile", basis: "ba_form" },
        ],
      },
    };
    expect(rules(undefined, { [nord]: nordTemplate, [sued]: locked }).map((r) => r.ruleId)).toEqual(
      ["base-check", "base-name"],
    );
  });
});
