import type { CompletenessRule } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import type { BaseDefaults, ProjectOverride, RegionalTemplate } from "./model";
import {
  resolveForParticipation,
  resolveForProject,
  type LayerRef,
  type ParticipationResolveInput,
} from "./resolve";
import { ConfigError } from "./validate";

// Fictional Agenturen and staff ids only (D8).
const staffId = "00000000-0000-4000-8000-000000000001";
const nord = "beispielstadt-nord";
const sued = "beispielstadt-sued";
const ost = "beispielstadt-ost"; // has no template

const nationwide = {
  asuDueDate: { monthsBeforeEnd: 3, daysAfterKnowledge: 3 },
  profilingExceptionDeadlineMonths: 1,
  kug200bConfirmationFollowUpDays: 14,
  tl407EscalationDaysAfterTgStart: 14,
  cutoffWarningDays: 14,
  cutoffFinalReminderDays: 3,
};
const rule = {
  asu: {
    id: "base-asu",
    kind: "documentPresent",
    documentType: "asu_proof",
    accepted: true,
    basis: "statutory",
    projectTypes: ["ta_tg"],
  },
  name: { id: "base-name", kind: "required", field: "lastName", basis: "operational_default" },
  birth: { id: "base-birth", kind: "required", field: "birthDate", basis: "ba_form" },
  mobile: { id: "base-mobile", kind: "required", field: "mobile" }, // unclassified: locked
  check: {
    id: "base-check",
    kind: "required",
    field: "personnelNumber",
    basis: "operational_default",
  },
} satisfies Record<string, CompletenessRule>;
const base: BaseDefaults = {
  schemaVersion: 1,
  kind: "base_defaults",
  version: 1,
  nationwide,
  rules: {
    asu_registration: [rule.asu],
    data_collection: [rule.name, rule.birth, rule.mobile],
    project_checklist: [rule.check],
  },
  helpTexts: {
    de: { "data_collection.intro": "Basis", "dsv.intro": "Basis DSV" },
    en: { "data_collection.intro": "Base" },
  },
};
const settings = {
  asu_registration: { defaultChannel: "kug_200b", batchSubmissionChannel: "scan_email" },
  agentur_submission: {
    submissionChannel: "upload",
    originalRequired: false,
    leadTimeDays: 10,
    rejectsOutdatedFormVersions: true,
  },
} as const;
const customField = {
  type: "string",
  maxLength: 40,
  "x-dataClass": "confidential",
  "x-retentionClass": "participation_record",
  "x-label": { de: "Nachweis" },
} as const;

const template = (key: string, extra: Partial<RegionalTemplate> = {}): RegionalTemplate => ({
  schemaVersion: 1,
  kind: "regional_template",
  id: key,
  version: 1,
  agenturKey: key,
  label: { de: `Agentur ${key} (Beispiel)` },
  settings,
  ...extra,
});
const nordTemplate = template(nord, {
  fields: { "custom.nord_nr": customField },
  rules: {
    data_collection: [
      { id: "nord-nr", kind: "required", field: "custom.nord_nr", basis: "operational_default" },
    ],
  },
  helpTexts: { de: { "data_collection.intro": "Nord" } },
});
const suedTemplate = template(sued, {
  settings: { agentur_submission: { ...settings.agentur_submission, leadTimeDays: 7 } },
  rules: {
    data_collection: [{ id: "sued-mail", kind: "required", field: "privateEmail" }],
    project_checklist: [{ id: "sued-check", kind: "required", field: "address" }],
  },
  helpTexts: { de: { "project_checklist.intro": "Süd" } },
});
const templatesByAgentur = { [nord]: nordTemplate, [sued]: suedTemplate };
const override = (extra: Partial<ProjectOverride> = {}): ProjectOverride => ({
  schemaVersion: 1,
  kind: "project_override",
  ...extra,
});
const temporary = {
  settings: { agentur_submission: { submissionChannel: "email", leadTimeDays: 21 } },
  source: "phone_call_agentur",
  confirmedBy: staffId,
  confirmedOn: "2027-01-12",
} as const;

const input = (extra: Partial<ParticipationResolveInput> = {}): ParticipationResolveInput => ({
  base,
  templatesByAgentur,
  projectType: "ta_tg",
  projectAgenturKey: nord,
  placementAgenturKey: nord,
  ...extra,
});

const B: LayerRef = { layer: "base" };
const O: LayerRef = { layer: "override" };
const T = (key: string): LayerRef => ({ layer: `template:${key}@1` });
const ids = (rules: readonly { id: string }[] | undefined) => rules?.map((r) => r.id);

/** The codes, paths and keys of a ConfigError, for compact expectations. */
function failure(resolve: () => unknown) {
  try {
    resolve();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return {
      layer: error.layer,
      issues: error.issues.map(({ code, path, key }) => ({ code, path: path.join("/"), key })),
    };
  }
  throw new Error("resolved");
}

describe("resolution order and provenance (AC-32)", () => {
  const result = resolveForParticipation(
    input({
      override: override({
        fields: { "custom.projekt_code": customField },
        rules: {
          data_collection: [
            {
              id: "override-code",
              kind: "requiredIf",
              field: "custom.projekt_code",
              when: { field: "custom.nord_nr", exists: true },
            },
          ],
        },
        helpTexts: { en: { "data_collection.intro": "Project" } },
      }),
    }),
  );

  it("merges base defaults → template → project override", () => {
    expect(result.config).toEqual({
      nationwide,
      settings,
      fields: { "custom.nord_nr": customField, "custom.projekt_code": customField },
      rules: {
        asu_registration: [rule.asu],
        data_collection: [
          rule.name,
          rule.birth,
          rule.mobile,
          nordTemplate.rules?.data_collection?.[0],
          expect.objectContaining({ id: "override-code" }),
        ],
        project_checklist: [rule.check],
      },
      relaxed: [],
      // the later layer wins per language and key
      helpTexts: {
        de: { "data_collection.intro": "Nord", "dsv.intro": "Basis DSV" },
        en: { "data_collection.intro": "Project" },
      },
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("names the layer of every setting, field, rule and help text", () => {
    expect(result.provenance).toEqual({
      "nationwide.asuDueDate.monthsBeforeEnd": B,
      "nationwide.asuDueDate.daysAfterKnowledge": B,
      "nationwide.profilingExceptionDeadlineMonths": B,
      "nationwide.kug200bConfirmationFollowUpDays": B,
      "nationwide.tl407EscalationDaysAfterTgStart": B,
      "nationwide.cutoffWarningDays": B,
      "nationwide.cutoffFinalReminderDays": B,
      "rules.asu_registration.base-asu": B,
      "rules.data_collection.base-name": B,
      "rules.data_collection.base-birth": B,
      "rules.data_collection.base-mobile": B,
      "rules.project_checklist.base-check": B,
      "helpTexts.de.data_collection.intro": T(nord),
      "helpTexts.de.dsv.intro": B,
      "helpTexts.en.data_collection.intro": O,
      "fields.custom.nord_nr": T(nord),
      "rules.data_collection.nord-nr": T(nord),
      "settings.asu_registration.defaultChannel": T(nord),
      "settings.asu_registration.batchSubmissionChannel": T(nord),
      "settings.agentur_submission.submissionChannel": T(nord),
      "settings.agentur_submission.originalRequired": T(nord),
      "settings.agentur_submission.leadTimeDays": T(nord),
      "settings.agentur_submission.rejectsOutdatedFormVersions": T(nord),
      "fields.custom.projekt_code": O,
      "rules.data_collection.override-code": O,
    });
  });

  it("keeps basis and projectTypes on the rules, for every project type (Q89)", () => {
    const taOnly = resolveForParticipation(input({ projectType: "ta_only" }));
    expect(taOnly.config.rules.asu_registration).toEqual([rule.asu]);
    expect(taOnly.config.rules.data_collection?.[1]?.basis).toBe("ba_form");
  });
});

describe("two levels (Q15, provisional)", () => {
  const twoAgenturen = input({ placementAgenturKey: nord, projectAgenturKey: sued });

  it("participant steps use the Placement Agentur, project steps the Project Agentur", () => {
    const { config, provenance } = resolveForParticipation(twoAgenturen);
    expect(ids(config.rules.data_collection)).toEqual([
      "base-name",
      "base-birth",
      "base-mobile",
      "nord-nr",
    ]);
    expect(ids(config.rules.project_checklist)).toEqual(["base-check", "sued-check"]);
    expect(provenance["rules.project_checklist.sued-check"]).toEqual(T(sued));
    expect(provenance["rules.data_collection.sued-mail"]).toBeUndefined();
    // settings, custom fields and help texts belong to the participant
    expect(config.settings).toEqual(settings);
    expect(Object.keys(config.fields)).toEqual(["custom.nord_nr"]);
    expect(config.helpTexts.de["project_checklist.intro"]).toBeUndefined();
  });

  it("a project resolves only its project steps, without regional settings", () => {
    const { config, provenance } = resolveForProject(twoAgenturen);
    expect(config.rules).toEqual({
      project_checklist: [rule.check, suedTemplate.rules?.project_checklist?.[0]],
    });
    expect(config.settings).toEqual({});
    expect(config.fields).toEqual({});
    expect(config.helpTexts.de).toEqual({
      "data_collection.intro": "Basis",
      "dsv.intro": "Basis DSV",
      "project_checklist.intro": "Süd",
    });
    expect(Object.keys(provenance).filter((key) => key.startsWith("settings."))).toEqual([]);
  });
});

const relax = (ruleId: string) => ({
  ruleId,
  reasonCode: "collected_elsewhere",
  approvedBy: staffId,
  approvedOn: "2027-01-12",
});

describe("rules are merged by id (Q75)", () => {
  it("templates only add", () => {
    const redefining = template(sued, {
      rules: { profiling: [{ ...rule.name, basis: "ba_form" }] },
    });
    expect(
      failure(() =>
        resolveForParticipation(
          input({ templatesByAgentur: { [sued]: redefining }, placementAgenturKey: sued }),
        ),
      ),
    ).toEqual({
      layer: `template:${sued}@1`,
      issues: [{ code: "rule_redefined", path: "rules/profiling/0/id", key: "base-name" }],
    });
  });

  it("an override adds rules but redefines none, at either level", () => {
    const redefining = override({
      rules: { dsv: [{ ...nordTemplate.rules!.data_collection![0]! }] },
    });
    expect(failure(() => resolveForParticipation(input({ override: redefining })))).toEqual({
      layer: "override",
      issues: [{ code: "rule_redefined", path: "rules/dsv/0/id", key: "nord-nr" }],
    });
    // ids are unique across all steps, so a participant-step id counts at the project level too
    const checklist = override({
      rules: { project_checklist: [{ ...rule.check, id: "base-name" }] },
    });
    expect(failure(() => resolveForProject(input({ override: checklist }))).issues).toEqual([
      { code: "rule_redefined", path: "rules/project_checklist/0/id", key: "base-name" },
    ]);
  });

  it("an override relaxes only operational_default rules", () => {
    const { config, provenance } = resolveForParticipation(
      input({ override: override({ relax: [relax("base-name"), relax("base-check")] }) }),
    );
    expect(ids(config.rules.data_collection)).toEqual(["base-birth", "base-mobile", "nord-nr"]);
    expect(config.rules.project_checklist).toEqual([]);
    expect(config.relaxed).toEqual([
      { ...relax("base-name"), step: "data_collection" },
      { ...relax("base-check"), step: "project_checklist" },
    ]);
    expect(provenance["relax.base-name"]).toEqual(O);
    expect(provenance["relax.base-check"]).toEqual(O);
    expect(provenance["rules.data_collection.base-name"]).toBeUndefined();
  });

  it.each([
    ["statutory", "base-asu"],
    ["ba_form", "base-birth"],
    ["unclassified", "base-mobile"],
  ])("relaxing a %s rule is invalid", (_basis, ruleId) => {
    expect(
      failure(() => resolveForProject(input({ override: override({ relax: [relax(ruleId)] }) }))),
    ).toEqual({
      layer: "override",
      issues: [{ code: "relaxation_locked", path: "relax/0/ruleId", key: ruleId }],
    });
  });

  it("relaxes a rule once, and only a rule of the layers below", () => {
    expect(
      failure(() =>
        resolveForParticipation(
          input({ override: override({ relax: [relax("base-name"), relax("base-name")] }) }),
        ),
      ).issues,
    ).toEqual([{ code: "duplicate_id", path: "relax/1/ruleId", key: "base-name" }]);
    // another Agentur's rule: the relaxation applies where that rule exists
    const own = {
      id: "own-1",
      kind: "required",
      field: "mobile",
      basis: "operational_default",
    } as const;
    const { config } = resolveForParticipation(
      input({
        override: override({
          rules: { profiling: [own] },
          relax: [relax("sued-mail"), relax("own-1")],
        }),
      }),
    );
    expect(config.relaxed).toEqual([]);
    expect(config.rules.profiling).toEqual([own]);
  });
});

describe("custom fields", () => {
  it("an override can't redefine a field of a layer below", () => {
    const redefining = override({
      fields: { "custom.nord_nr": { ...customField, maxLength: 10 } },
    });
    expect(failure(() => resolveForParticipation(input({ override: redefining })))).toEqual({
      layer: "override",
      issues: [{ code: "field_redefined", path: "fields/custom.nord_nr", key: "custom.nord_nr" }],
    });
  });

  it("an override can use one Agentur's field only where that template is resolved", () => {
    const usesNord = override({
      rules: { profiling: [{ id: "o-1", kind: "required", field: "custom.nord_nr" }] },
    });
    expect(() => resolveForProject(input({ override: usesNord }))).not.toThrow();
    expect(
      failure(() => resolveForProject(input({ override: usesNord, projectAgenturKey: sued }))),
    ).toEqual({
      layer: "override",
      issues: [{ code: "unknown_field", path: "rules/profiling/0/field", key: "custom.nord_nr" }],
    });
  });
});

describe("invalid layers", () => {
  it("validates every layer with parseLayer", () => {
    const withNationwide = { ...nordTemplate, nationwide } as unknown as RegionalTemplate;
    expect(
      failure(() => resolveForProject(input({ templatesByAgentur: { [nord]: withNationwide } }))),
    ).toEqual({
      layer: `template:${nord}@1`,
      issues: [{ code: "nationwide_setting", path: "", key: "nationwide" }],
    });
  });

  it("needs each layer in its place", () => {
    const notBase = template(nord) as unknown as BaseDefaults;
    expect(failure(() => resolveForProject(input({ base: notBase })))).toEqual({
      layer: "base",
      issues: [{ code: "wrong_layer_kind", path: "kind", key: undefined }],
    });
    const notOverride = template(nord) as unknown as ProjectOverride;
    expect(failure(() => resolveForProject(input({ override: notOverride }))).issues).toEqual([
      { code: "wrong_layer_kind", path: "kind", key: undefined },
    ]);
  });

  it("finds a template under its own Agentur key", () => {
    expect(
      failure(() => resolveForProject(input({ templatesByAgentur: { [nord]: suedTemplate } }))),
    ).toEqual({
      layer: `template:${sued}@1`,
      issues: [{ code: "template_key_mismatch", path: "agenturKey", key: nord }],
    });
    // never an inherited property
    const { blockers } = resolveForProject(input({ projectAgenturKey: "constructor" }));
    expect(blockers).toEqual([{ code: "project_activation_blocked", agenturKey: "constructor" }]);
  });
});

describe("Agentur-scoped temporary settings (AC-33)", () => {
  const withOst = override({ agenturSettings: { [ost]: temporary } });
  const ostRef: LayerRef = {
    layer: `override:agentur:${ost}`,
    source: "phone_call_agentur",
    confirmedBy: staffId,
    confirmedOn: "2027-01-12",
  };

  it("apply when resolving for their Agentur, with source, confirmer and date", () => {
    const { config, provenance } = resolveForParticipation(
      input({ override: withOst, placementAgenturKey: ost }),
    );
    expect(config.settings).toEqual(temporary.settings);
    expect(provenance["settings.agentur_submission.submissionChannel"]).toEqual(ostRef);
    expect(provenance["settings.agentur_submission.leadTimeDays"]).toEqual(ostRef);
  });

  it("never apply to another Agentur", () => {
    const { config, provenance } = resolveForParticipation(input({ override: withOst }));
    expect(config.settings).toEqual(settings);
    expect(Object.values(provenance)).not.toContainEqual(ostRef);
    expect(
      resolveForProject(input({ override: withOst, projectAgenturKey: ost })).config.settings,
    ).toEqual({});
  });

  it("win over their Agentur's pinned template only for the keys they supply (Q93)", () => {
    const partial = template(nord, {
      settings: {
        agentur_submission: {
          originalRequired: true,
          leadTimeDays: 10,
          rejectsOutdatedFormVersions: false,
        },
      },
    });
    const { config, provenance, blockers } = resolveForParticipation(
      input({
        templatesByAgentur: { [nord]: partial },
        override: override({ agenturSettings: { [nord]: temporary } }),
        projectType: "ta_only",
      }),
    );
    expect(config.settings).toEqual({
      agentur_submission: {
        originalRequired: true,
        rejectsOutdatedFormVersions: false,
        submissionChannel: "email",
        leadTimeDays: 21,
      },
    });
    expect(provenance["settings.agentur_submission.originalRequired"]).toEqual(T(nord));
    expect(provenance["settings.agentur_submission.leadTimeDays"]).toMatchObject({
      layer: `override:agentur:${nord}`,
    });
    expect(blockers).toEqual([]);
  });
});

describe("blockers (Q76)", () => {
  it("no Project-Agentur template blocks project activation, with a warning (Q90)", () => {
    for (const projectAgenturKey of [ost, null]) {
      const blocker = { code: "project_activation_blocked", agenturKey: projectAgenturKey };
      // a temporary setting doesn't replace the template here
      const project = resolveForProject(
        input({ projectAgenturKey, override: override({ agenturSettings: { [ost]: temporary } }) }),
      );
      expect(project.blockers).toEqual([blocker]);
      expect(project.warnings).toEqual([blocker]);
      expect(project.config.rules).toEqual({ project_checklist: [rule.check] });
      expect(resolveForParticipation(input({ projectAgenturKey })).blockers).toEqual([blocker]);
    }
  });

  it("a missing submission setting blocks that submission; the other steps resolve", () => {
    const { config, blockers, warnings } = resolveForParticipation(
      input({ placementAgenturKey: ost }),
    );
    const expected = [
      {
        code: "agentur_submission_blocked",
        step: "asu_registration",
        agenturKey: ost,
        missing: ["batchSubmissionChannel"],
      },
      {
        code: "agentur_submission_blocked",
        step: "agentur_submission",
        agenturKey: ost,
        missing: [
          "submissionChannel",
          "originalRequired",
          "leadTimeDays",
          "rejectsOutdatedFormVersions",
        ],
      },
    ];
    expect(blockers).toEqual(expected);
    expect(warnings).toEqual(expected);
    expect(ids(config.rules.data_collection)).toEqual(["base-name", "base-birth", "base-mobile"]);
    expect(config.settings).toEqual({});
  });

  it("names exactly the missing settings; a participation without a placement Agentur is blocked", () => {
    const partial = override({ agenturSettings: { [ost]: temporary } });
    expect(
      resolveForParticipation(
        input({ placementAgenturKey: ost, override: partial, projectType: "ta_only" }),
      ).blockers,
    ).toEqual([
      {
        code: "agentur_submission_blocked",
        step: "agentur_submission",
        agenturKey: ost,
        missing: ["originalRequired", "rejectsOutdatedFormVersions"],
      },
    ]);
    expect(
      resolveForParticipation(input({ placementAgenturKey: null })).blockers.map(
        (b) => b.agenturKey,
      ),
    ).toEqual([null, null]);
  });

  it("the Kug 200b batch channel only blocks in ta_tg projects (Q91)", () => {
    const noBatch = template(nord, {
      settings: { ...settings, asu_registration: { defaultChannel: "kug_200b" } },
    });
    const run = (projectType: "ta_only" | "ta_tg") =>
      resolveForParticipation(input({ templatesByAgentur: { [nord]: noBatch }, projectType }))
        .blockers;
    expect(run("ta_only")).toEqual([]);
    expect(run("ta_tg")).toEqual([
      {
        code: "agentur_submission_blocked",
        step: "asu_registration",
        agenturKey: nord,
        missing: ["batchSubmissionChannel"],
      },
    ]);
  });

  it("an unset ASU default channel blocks nothing (round 14)", () => {
    const noDefault = template(nord, {
      settings: { ...settings, asu_registration: { batchSubmissionChannel: "upload" } },
    });
    expect(
      resolveForParticipation(input({ templatesByAgentur: { [nord]: noDefault } })).blockers,
    ).toEqual([]);
    const noSettings = template(nord, { settings: undefined });
    expect(
      resolveForParticipation(input({ templatesByAgentur: { [nord]: noSettings } })).blockers,
    ).toHaveLength(2);
  });
});
