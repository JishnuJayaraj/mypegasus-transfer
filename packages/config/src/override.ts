import {
  isLocked,
  RelaxationReasonCode,
  ruleAppliesTo,
  type CompletenessRule,
  type ProjectType,
  type Step,
} from "@transfer/domain";
import type {
  BaseDefaults,
  ProjectOverride,
  RegionalTemplate,
  RuleRelaxation,
  TemporaryAgenturSetting,
} from "./model";
import { resolveForParticipation, resolveForProject } from "./resolve";
import { ConfigError, parseLayer, type ConfigIssue } from "./validate";

/**
 * The controlled reason codes of a rule relaxation (round 14; Q100, confirmed in round 22),
 * declared once in the domain, whose audit model and database enum need them too (2d-2).
 */
export { RelaxationReasonCode };

export type OverrideValidation =
  | { ok: true; override: ProjectOverride }
  | { ok: false; layer: string; issues: readonly ConfigIssue[] };

/**
 * Whether an override may be stored with these pins (Slice 2 plan 5.9; round 15, R16): the layer
 * on its own (`parseLayer`), then resolved for the project and for participations against the
 * base-only chain and every pinned Agentur chain, where any `ConfigError` fails with its layer and
 * issues (a rule on a custom field only one template declares, a locked relaxation, …). Then
 * every relaxation must relax a rule in at least one chain (a typo is never a silent global
 * no-op) and carry a controlled reason code. Run on every override write and every pin.
 */
export function validateProjectOverride(input: {
  base: BaseDefaults;
  /** The project's pinned templates by Agentur key, including a pin about to be added. */
  templatesByAgentur: Readonly<Record<string, RegionalTemplate>>;
  override: unknown;
  projectType: ProjectType;
}): OverrideValidation {
  const { base, templatesByAgentur, projectType } = input;
  const parsed = parseLayer(input.override);
  if (!parsed.ok) return { ok: false, layer: "override", issues: parsed.issues };
  if (parsed.layer.kind !== "project_override") {
    return { ok: false, layer: "override", issues: [{ code: "wrong_layer_kind", path: ["kind"] }] };
  }
  const override = parsed.layer;
  const relaxed = new Set<string>();
  try {
    for (const agenturKey of [null, ...Object.keys(templatesByAgentur)]) {
      const chain = { base, templatesByAgentur, override, projectType };
      resolveForProject({ ...chain, projectAgenturKey: agenturKey });
      const { config } = resolveForParticipation({
        ...chain,
        projectAgenturKey: agenturKey,
        placementAgenturKey: agenturKey,
      });
      for (const { ruleId } of config.relaxed) relaxed.add(ruleId);
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, layer: error.layer, issues: error.issues };
  }
  const issues: ConfigIssue[] = [];
  (override.relax ?? []).forEach(({ ruleId, reasonCode }, index) => {
    if (!relaxed.has(ruleId)) {
      issues.push({ code: "relaxation_unmatched", path: ["relax", index, "ruleId"], key: ruleId });
    }
    if (!RelaxationReasonCode.safeParse(reasonCode).success) {
      issues.push({ code: "reason_code_unknown", path: ["relax", index, "reasonCode"] });
    }
  });
  return issues.length ? { ok: false, layer: "override", issues } : { ok: true, override };
}

/**
 * The override with `agenturKey`'s scoped setting replaced (`setting`) or removed (`null`); every
 * other part stays. Without an override yet, it starts from an empty one (version 0, 5.9).
 */
export function withAgenturSetting(
  current: ProjectOverride | undefined,
  agenturKey: string,
  setting: TemporaryAgenturSetting | null,
): ProjectOverride {
  const { agenturSettings, ...rest } = current ?? { schemaVersion: 1, kind: "project_override" };
  const next = { ...agenturSettings };
  if (setting) next[agenturKey] = setting;
  else delete next[agenturKey];
  return Object.keys(next).length ? { ...rest, agenturSettings: next } : rest;
}

/** The override without `ruleId`'s relaxation (`null`), or with `relaxation` appended (5.9). */
export function withRelaxation(
  current: ProjectOverride | undefined,
  change: { ruleId: string; relaxation: RuleRelaxation | null },
): ProjectOverride {
  const { relax = [], ...rest } = current ?? { schemaVersion: 1, kind: "project_override" };
  const next = relax.filter(({ ruleId }) => ruleId !== change.ruleId);
  if (change.relaxation) next.push(change.relaxation);
  return next.length ? { ...rest, relax: next } : rest;
}

/**
 * The rules a relaxation may be requested for (5.9): rules of the templates and base defaults
 * that are `operational_default` and apply to the project type in some chain (the base-only chain
 * and every pinned one) and locked in none, not relaxed yet; in rule-id order. The request is
 * still checked by `validateProjectOverride`.
 */
export function relaxableRules(input: {
  base: BaseDefaults;
  templatesByAgentur: Readonly<Record<string, RegionalTemplate>>;
  override: ProjectOverride | undefined;
  projectType: ProjectType;
}): { ruleId: string; step: Step }[] {
  const open = new Map<string, Step>();
  const locked = new Set<string>();
  for (const agenturKey of [null, ...Object.keys(input.templatesByAgentur)]) {
    const { config, provenance } = resolveForParticipation({
      ...input,
      projectAgenturKey: agenturKey,
      placementAgenturKey: agenturKey,
    });
    for (const [step, rules] of Object.entries(config.rules) as [Step, CompletenessRule[]][]) {
      for (const rule of rules) {
        // The override's own rules are never relaxed by it (round 15).
        if (provenance[`rules.${step}.${rule.id}`]?.layer === "override") continue;
        if (isLocked(rule)) locked.add(rule.id);
        else if (ruleAppliesTo(rule, input.projectType)) open.set(rule.id, step);
      }
    }
  }
  return [...open]
    .filter(([ruleId]) => !locked.has(ruleId))
    .map(([ruleId, step]) => ({ ruleId, step }))
    .toSorted((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
}
