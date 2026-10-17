import {
  isLocked,
  ruleAppliesTo,
  type CompletenessRule,
  type ProjectType,
  type Step,
} from "@transfer/domain";
import type { FieldSchema } from "./field-schema";
import type {
  BaseDefaults,
  ConfigLayer,
  NationwideSettings,
  ProjectOverride,
  RegionalSettings,
  RegionalTemplate,
  RuleRelaxation,
  TemporaryAgenturSetting,
} from "./model";
import { ConfigError, parseLayer, type ConfigIssue } from "./validate";

/**
 * Where a resolved value comes from (plan 5.7): the base defaults, a pinned template version,
 * the project override, or an Agentur-scoped temporary setting with its confirmation.
 */
export type LayerRef =
  | { layer: "base" | "override" | `template:${string}@${number}` }
  | ({ layer: `override:agentur:${string}` } & Omit<TemporaryAgenturSetting, "settings">);

export type ResolvedConfig = {
  nationwide: NationwideSettings;
  settings: RegionalSettings;
  fields: Record<string, FieldSchema>;
  /** Rules keep `basis` and `projectTypes`: displays and reminders skip inapplicable ones (Q89). */
  rules: Partial<Record<Step, CompletenessRule[]>>;
  relaxed: (RuleRelaxation & { step: Step })[];
  helpTexts: { de: Record<string, string>; en: Record<string, string> };
};

type SubmissionStep = "asu_registration" | "agentur_submission";

export type Blocker =
  | { code: "project_activation_blocked"; agenturKey: string | null }
  | {
      code: "agentur_submission_blocked";
      step: SubmissionStep;
      agenturKey: string | null;
      missing: string[];
    };

export type Resolution = {
  config: ResolvedConfig;
  /** Keyed by path: `settings.<step>.<key>`, `rules.<step>.<id>`, `fields.<key>`, … */
  provenance: Record<string, LayerRef>;
  blockers: Blocker[];
  /** One for each blocker, for the PL dashboard (Q76). */
  warnings: Blocker[];
};

export type ProjectResolveInput = {
  base: BaseDefaults;
  /** The project's pinned template versions (Q36), by Agentur key. */
  templatesByAgentur: Readonly<Record<string, RegionalTemplate>>;
  override?: ProjectOverride;
  projectType: ProjectType;
  projectAgenturKey: string | null;
};
export type ParticipationResolveInput = ProjectResolveInput & {
  placementAgenturKey: string | null;
};

const projectSteps: ReadonlySet<Step> = new Set(["project_checklist"]);

/** What must be known before submitting to an Agentur; none has a default (Q76, round 8). */
const submissionSettings: Record<SubmissionStep, readonly string[]> = {
  asu_registration: ["batchSubmissionChannel"],
  agentur_submission: [
    "submissionChannel",
    "originalRequired",
    "leadTimeDays",
    "rejectsOutdatedFormVersions",
  ],
};

/**
 * Project steps, resolved against the Project Agentur's template (two levels, Q15, Q90): the
 * KuG-Agentur in a `ta_tg` project, the Agentur responsible for the §110 measure in `ta_only`.
 */
export function resolveForProject(input: ProjectResolveInput): Resolution {
  const { config, provenance } = resolveLevel(input, "project", input.projectAgenturKey);
  return finish(config, provenance, activationBlockers(input));
}

/**
 * A participation's configuration: participant steps from its placement Agentur's template,
 * project steps from the Project Agentur's (two levels, Q15, Q90). Settings, custom fields and help texts
 * are the participant level's.
 */
export function resolveForParticipation(input: ParticipationResolveInput): Resolution {
  const own = resolveLevel(input, "participant", input.placementAgenturKey);
  const project = resolveLevel(input, "project", input.projectAgenturKey);
  const config = {
    ...own.config,
    rules: { ...own.config.rules, ...project.config.rules },
    relaxed: [...own.config.relaxed, ...project.config.relaxed],
  };
  const projectRules = Object.entries(project.provenance).filter(([path]) =>
    /^(rules|relax)\./.test(path),
  );
  return finish(config, { ...own.provenance, ...Object.fromEntries(projectRules) }, [
    ...activationBlockers(input),
    ...submissionBlockers(input, config.settings),
  ]);
}

function finish(config: ResolvedConfig, provenance: Resolution["provenance"], blockers: Blocker[]) {
  return { config, provenance, blockers, warnings: blockers.map((blocker) => ({ ...blocker })) };
}

const templateFor = (input: ProjectResolveInput, agenturKey: string | null) =>
  agenturKey !== null && Object.hasOwn(input.templatesByAgentur, agenturKey)
    ? input.templatesByAgentur[agenturKey]
    : undefined;

/**
 * Every project type needs its Project Agentur's template (Q76, Q90). Only a pinned template
 * lifts this blocker; temporary settings can't stand in for it (round 15).
 */
function activationBlockers(input: ProjectResolveInput): Blocker[] {
  if (templateFor(input, input.projectAgenturKey)) return [];
  return [{ code: "project_activation_blocked", agenturKey: input.projectAgenturKey }];
}

function submissionBlockers(input: ParticipationResolveInput, settings: RegionalSettings) {
  const known = settings as Partial<Record<SubmissionStep, Record<string, unknown>>>;
  return (Object.keys(submissionSettings) as SubmissionStep[]).flatMap((step): Blocker[] => {
    // Step-scoped: blocks only the Kug 200b batch submission, which exists only on the TG
    // route (Q91), and the TL 407 submission (Q92); never activation or other work.
    if (step === "asu_registration" && input.projectType === "ta_only") return [];
    const missing = submissionSettings[step].filter((key) => known[step]?.[key] === undefined);
    if (!missing.length) return [];
    return [
      { code: "agentur_submission_blocked", step, agenturKey: input.placementAgenturKey, missing },
    ];
  });
}

/**
 * One level: base defaults → the Agentur's template → the project override. Each layer is
 * validated with the custom fields of the layers below. Rule ids are unique across every step
 * of every layer; only the level's steps enter the config.
 */
function resolveLevel(
  input: ProjectResolveInput,
  level: "participant" | "project",
  agenturKey: string | null,
) {
  const config: ResolvedConfig = {
    nationwide: input.base.nationwide,
    settings: {},
    fields: {},
    rules: {},
    relaxed: [],
    helpTexts: { de: {}, en: {} },
  };
  const provenance: Record<string, LayerRef> = {};
  const rules = new Map<string, { step: Step; rule: CompletenessRule }>();
  const fields = new Set<string>();
  const inLevel = (step: Step) => projectSteps.has(step) === (level === "project");

  function merge(layer: ConfigLayer, ref: LayerRef) {
    const issues: ConfigIssue[] = [];
    for (const [key, schema] of Object.entries(
      layer.kind === "base_defaults" ? {} : (layer.fields ?? {}),
    )) {
      config.fields[key] = schema;
      fields.add(key);
      provenance[`fields.${key}`] = ref;
    }
    for (const [step, list] of Object.entries(layer.rules ?? {}) as [Step, CompletenessRule[]][]) {
      list.forEach((rule, index) => {
        if (rules.has(rule.id)) {
          issues.push({ code: "rule_redefined", path: ["rules", step, index, "id"], key: rule.id });
          return;
        }
        rules.set(rule.id, { step, rule });
        if (!inLevel(step)) return;
        (config.rules[step] ??= []).push(rule);
        provenance[`rules.${step}.${rule.id}`] = ref;
      });
    }
    for (const language of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(layer.helpTexts?.[language] ?? {})) {
        config.helpTexts[language][key] = text;
        provenance[`helpTexts.${language}.${key}`] = ref;
      }
    }
    if (issues.length) throw new ConfigError(ref.layer, issues);
  }

  /** Regional settings belong to participant steps; later layers win per key. */
  function settle(settings: RegionalSettings | undefined, ref: LayerRef) {
    if (level === "project") return;
    const target = config.settings as Record<string, Record<string, unknown>>;
    for (const [step, values] of Object.entries(settings ?? {})) {
      for (const [key, value] of Object.entries(values as object)) {
        (target[step] ??= {})[key] = value;
        provenance[`settings.${step}.${key}`] = ref;
      }
    }
  }

  /** Relaxes rules of the layers below; a rule this level doesn't resolve stays untouched. */
  function relax(relaxations: readonly RuleRelaxation[], ref: LayerRef) {
    const issues: ConfigIssue[] = [];
    const seen = new Set<string>();
    relaxations.forEach((relaxation, index) => {
      const path = ["relax", index, "ruleId"];
      const key = relaxation.ruleId;
      const found = rules.get(key);
      if (seen.has(key)) issues.push({ code: "duplicate_id", path, key });
      seen.add(key);
      if (!found) return; // another Agentur's rule: it is relaxed where it is resolved
      if (isLocked(found.rule)) issues.push({ code: "relaxation_locked", path, key });
      // A rule for another project type is never relaxed (round 28): nothing applies to relax
      // (Q89), so `validateProjectOverride` finds the relaxation unmatched.
      if (issues.length || !inLevel(found.step) || !ruleAppliesTo(found.rule, input.projectType)) {
        return;
      }
      config.rules[found.step] = config.rules[found.step]!.filter((rule) => rule !== found.rule);
      config.relaxed.push({ ...relaxation, step: found.step });
      delete provenance[`rules.${found.step}.${key}`];
      provenance[`relax.${key}`] = ref;
    });
    if (issues.length) throw new ConfigError(ref.layer, issues);
  }

  const base = checked(input.base, "base_defaults", fields, { layer: "base" });
  config.nationwide = base.nationwide;
  merge(base, { layer: "base" });
  for (const path of leaves(base.nationwide, "nationwide")) provenance[path] = { layer: "base" };

  const template = templateFor(input, agenturKey);
  if (template) {
    const ref: LayerRef = { layer: `template:${template.id}@${template.version}` };
    const layer = checked(template, "regional_template", fields, ref);
    if (layer.agenturKey !== agenturKey) {
      throw new ConfigError(ref.layer, [
        { code: "template_key_mismatch", path: ["agenturKey"], key: agenturKey as string },
      ]);
    }
    merge(layer, ref);
    settle(layer.settings, ref);
  }

  if (input.override) {
    const ref: LayerRef = { layer: "override" };
    const layer = checked(input.override, "project_override", fields, ref);
    relax(layer.relax ?? [], ref);
    merge(layer, ref);
    const scoped = layer.agenturSettings ?? {};
    if (agenturKey !== null && Object.hasOwn(scoped, agenturKey)) {
      const { settings, ...confirmation } = scoped[agenturKey]!;
      settle(settings, { layer: `override:agentur:${agenturKey}`, ...confirmation });
    }
  }
  return { config, provenance };
}

/** `parseLayer` with the fields inherited from the layers below, in the expected place. */
function checked<K extends ConfigLayer["kind"]>(
  input: unknown,
  kind: K,
  inheritedFields: ReadonlySet<string>,
  ref: LayerRef,
): Extract<ConfigLayer, { kind: K }> {
  const result = parseLayer(input, { inheritedFields });
  if (!result.ok) throw new ConfigError(ref.layer, result.issues);
  if (result.layer.kind !== kind) {
    throw new ConfigError(ref.layer, [{ code: "wrong_layer_kind", path: ["kind"] }]);
  }
  return result.layer as Extract<ConfigLayer, { kind: K }>;
}

function* leaves(value: object, path: string): Generator<string> {
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "object") yield* leaves(child as object, `${path}.${key}`);
    else yield `${path}.${key}`;
  }
}
