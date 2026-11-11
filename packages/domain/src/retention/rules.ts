import { z } from "zod";
import {
  staffPermission,
  type Actor,
  type Permission,
  type PermissionTarget,
} from "../access/permissions";
import { addDays, addMonths, compareIsoDates } from "../dates";
import type { IsoDate } from "../iso-date";

// Retention as data (ADR-0008, retention per data item; data-protection.md, retention and
// deletion): which classes the job applies, by which triggers, at which stage. The periods are
// configuration (the data catalog's `retentionPeriods`) and stay `unset` until the DPO confirms
// them (Q3, Q24); nothing here invents one. No I/O, no system time: the job passes the day.

/** Every retention class of the data catalog, the job's report lists each of them. */
export const RetentionClass = z.enum([
  "project_master",
  "staff_account",
  "participation_record",
  "personnel_file",
  "health_record",
  "audit_log",
  "access_credential",
  "evidence_set",
  "form_working_copy",
  // A stored object without a document row (an upload whose row was never written): not a data
  // item of the catalog, but deleted the same way, by its period after it was written.
  "orphaned_object",
  "reference_data",
]);
export type RetentionClass = z.infer<typeof RetentionClass>;

/**
 * A class's configured period: `unset` (no deletion may touch it), `never` (no personal data), or
 * per trigger how long the item is kept after it: days, calendar months, or until the end of the
 * n-th calendar year after the trigger's year (data-protection.md, retention and deletion). The
 * item is deleted on the day after the last kept; each trigger takes exactly one of the three.
 */
export type RetentionPeriod =
  | "unset"
  | "never"
  | {
      readonly days?: Readonly<Record<string, number>>;
      readonly months?: Readonly<Record<string, number>>;
      readonly yearEnds?: Readonly<Record<string, number>>;
    };
export type RetentionPeriods = Readonly<Record<RetentionClass, RetentionPeriod>>;

export type RetentionRule = {
  /** The events that start the class's period, by the key its period's days use. */
  triggers: readonly string[];
  /** Stage one deletes per item; stage two erases what is left of a participation (ADR-0008). */
  stage: 1 | 2;
  /** Whether the job applies the class yet; the rest is reported, never deleted. */
  applied: boolean;
  /**
   * Whether its deletion waits for a known §110 funding where the participation never entered the
   * TG (data-protection.md, retention per class: `funding_unknown`).
   */
  dependsOnFunding: boolean;
};

/** The participation's own triggers (data-protection.md, retention and deletion; Q77, Q105). */
const participationTriggers = ["non_signer_withdrawn", "closed_without_tg", "exited"] as const;

/**
 * The rules (data-protection.md, retention and deletion). Applied: access credentials 30 days
 * after use, expiry, lock, revocation or end (Q122), generated working copies' files after
 * supersession, an accepted scan, abandonment or the terminal status (Q179), and per class of a
 * participation the personnel file and the health record at the participation's own triggers.
 * The participation record is stage two (the erasure or the evidence-only phase): reported, its
 * deletion comes with the erasure.
 */
export const retentionRules: Readonly<Record<RetentionClass, RetentionRule>> = {
  project_master: { triggers: [], stage: 2, applied: false, dependsOnFunding: false },
  staff_account: { triggers: [], stage: 2, applied: false, dependsOnFunding: false },
  participation_record: {
    triggers: participationTriggers,
    stage: 2,
    applied: false,
    dependsOnFunding: true,
  },
  personnel_file: {
    triggers: participationTriggers,
    stage: 1,
    applied: true,
    dependsOnFunding: false,
  },
  health_record: {
    triggers: participationTriggers,
    stage: 1,
    applied: true,
    dependsOnFunding: false,
  },
  audit_log: { triggers: [], stage: 2, applied: false, dependsOnFunding: false },
  access_credential: { triggers: ["ended"], stage: 1, applied: true, dependsOnFunding: false },
  evidence_set: { triggers: [], stage: 2, applied: false, dependsOnFunding: false },
  form_working_copy: {
    triggers: ["superseded", "scan_accepted", "abandoned", "participation_closed"],
    stage: 1,
    applied: true,
    dependsOnFunding: false,
  },
  orphaned_object: { triggers: ["stored"], stage: 1, applied: true, dependsOnFunding: false },
  reference_data: { triggers: [], stage: 2, applied: false, dependsOnFunding: false },
};

/**
 * A participation's triggers as Berlin days (data-protection.md, retention and deletion): a
 * non-signer (withdrawn before the TG without a fully executed DSV) from `withdrawnOn`; a
 * participation withdrawn with a fully executed DSV from the day it closed; a TG participant
 * from the day it exited. The mapping for `ta_completed` is unconfirmed.
 */
export function participationRetentionTriggers(facts: {
  status: string;
  /** The day of the last main-status change, for a terminal status. */
  closedOn: IsoDate | null;
  withdrawnOn: IsoDate | null;
  enteredTg: boolean;
  dsvFullyExecuted: boolean;
}): Record<(typeof participationTriggers)[number], IsoDate | null> {
  const withdrawn = facts.status === "withdrawn" && !facts.enteredTg;
  const nonSigner = withdrawn && !facts.dsvFullyExecuted;
  return {
    non_signer_withdrawn: nonSigner ? (facts.withdrawnOn ?? facts.closedOn) : null,
    closed_without_tg: withdrawn && !nonSigner ? (facts.withdrawnOn ?? facts.closedOn) : null,
    exited: facts.status === "exited" ? facts.closedOn : null,
  };
}

export type RetentionDue =
  | { kind: "period_unset" }
  | { kind: "never" }
  | { kind: "held" }
  | { kind: "blocked"; reason: "funding_unknown" }
  | { kind: "not_due"; on: IsoDate | null }
  | { kind: "due"; stage: 1 | 2; trigger: string; from: IsoDate };

/** The last day an item is kept after a trigger on `from`, or null when the period lacks it. */
function keptUntil(
  period: Exclude<RetentionPeriod, "unset" | "never">,
  trigger: string,
  from: IsoDate,
): IsoDate | null {
  const spans = [period.days?.[trigger], period.months?.[trigger], period.yearEnds?.[trigger]];
  if (spans.filter((n) => n !== undefined).length !== 1) return null;
  const [days, months, yearEnds] = spans;
  if (Number.isInteger(days)) return addDays(from, days!);
  if (Number.isInteger(months)) return addMonths(from, months!);
  if (Number.isInteger(yearEnds)) {
    return `${Number(from.slice(0, 4)) + yearEnds!}-12-31` as IsoDate;
  }
  return null;
}

/**
 * When one item of a class may go: the earliest of its triggers' last kept days, plus one (kept
 * for the full period; 30 days after use is deleted on day 31, 90 after `withdrawnOn` on day 91).
 * A trigger the item doesn't have yet counts nothing; a period missing a trigger's span is
 * `period_unset`. A class depending on the funding is blocked, once due, while it is `unknown`
 * and the participation never entered the TG (`funding_unknown`).
 */
export function retentionDue(
  item: {
    class: RetentionClass;
    /** The Berlin day each trigger happened, if it did. */
    triggers: Readonly<Record<string, IsoDate | null | undefined>>;
    held: boolean;
    /** For a class depending on the funding: the participation's, and whether it entered the TG. */
    funding?: { funded110: Funded110; enteredTg: boolean };
  },
  periods: RetentionPeriods,
  today: IsoDate,
): RetentionDue {
  const period = periods[item.class];
  if (period === "unset") return { kind: "period_unset" };
  if (period === "never") return { kind: "never" };
  const rule = retentionRules[item.class];
  const sample = "1970-01-01" as IsoDate;
  if (rule.triggers.some((trigger) => keptUntil(period, trigger, sample) === null)) {
    return { kind: "period_unset" };
  }
  if (item.held) return { kind: "held" };
  let best: { trigger: string; from: IsoDate; on: IsoDate } | null = null;
  for (const trigger of rule.triggers) {
    const from = item.triggers[trigger];
    if (!from) continue;
    if (trigger === "closed_without_tg" && item.class === "health_record") continue;
    if (
      trigger === "non_signer_withdrawn" &&
      (item.class === "personnel_file" || item.class === "health_record")
    ) {
      if (item.funding?.funded110 === "known_yes") continue;
    }
    const on = addDays(keptUntil(period, trigger, from)!, 1);
    if (best === null || compareIsoDates(on, best.on) < 0) best = { trigger, from, on };
  }
  if (best === null || compareIsoDates(best.on, today) > 0) {
    return { kind: "not_due", on: best?.on ?? null };
  }
  if (
    (rule.dependsOnFunding &&
      item.funding &&
      !item.funding.enteredTg &&
      item.funding.funded110 === "unknown") ||
    (best.trigger === "non_signer_withdrawn" &&
      (item.class === "personnel_file" || item.class === "health_record") &&
      (item.funding?.funded110 ?? "unknown") === "unknown")
  ) {
    return { kind: "blocked", reason: "funding_unknown" };
  }
  return { kind: "due", stage: rule.stage, trigger: best.trigger, from: best.from };
}

/**
 * The last day a credential may have ended to be due today (`retentionDue`'s rule for the one
 * trigger `ended`, for the job to apply in one statement); `null` when the class isn't configured.
 */
export function credentialCutoff(periods: RetentionPeriods, today: IsoDate): IsoDate | null {
  const period = periods.access_credential;
  if (period === "unset" || period === "never") return null;
  const ended = period.days?.ended;
  if (!Number.isInteger(ended) || period.months?.ended !== undefined) return null;
  if (period.yearEnds?.ended !== undefined) return null;
  return addDays(today, -(ended! + 1));
}

/** Generated working copies' triggers (data-protection.md, generated forms; Q179) as days. */
export function workingCopyTriggers(facts: {
  generatedOn: IsoDate;
  supersededOn: IsoDate | null;
  scanAcceptedOn: IsoDate | null;
  closedOn: IsoDate | null;
}): Record<string, IsoDate | null> {
  return {
    superseded: facts.supersededOn,
    scan_accepted: facts.scanAcceptedOn,
    participation_closed: facts.closedOn,
    // Abandoned only while it has neither a successor nor an accepted scan.
    abandoned:
      facts.supersededOn === null && facts.scanAcceptedOn === null ? facts.generatedOn : null,
  };
}

/** What must hold before any live deletion (data-protection.md, retention; Q219). */
export const RetentionPrerequisite = z.enum([
  "periods_confirmed",
  // Includes the completed operational workflow for holds on individual documents.
  "hold_administration_confirmed",
  "evidence_only_access_built",
  "maintenance_rules_complete",
]);
export type RetentionPrerequisite = z.infer<typeof RetentionPrerequisite>;
export type RetentionPrerequisites = Readonly<Record<RetentionPrerequisite, boolean>>;

/** Active only when every prerequisite is met; otherwise the job is a dry run. */
export function retentionActivation(prerequisites: RetentionPrerequisites): {
  active: boolean;
  unmet: RetentionPrerequisite[];
} {
  const unmet = RetentionPrerequisite.options.filter((key) => prerequisites[key] !== true);
  return { active: unmet.length === 0, unmet };
}

/** Whether a participation received funding under §110 SGB III (data-protection.md, funding; Q217). */
export const Funded110 = z.enum(["known_yes", "known_no", "unknown"]).meta({ id: "Funded110" });
export type Funded110 = z.infer<typeof Funded110>;

/**
 * Which settlement dates a project needs before stage two (data-protection.md, settlement dates;
 * Q52): the final Transfer-KuG settlement when any participation entered the TG (a conservative
 * trigger, never proof of Transfer-KuG), the §110 settlement when any is funded `known_yes`; an
 * `unknown` funding blocks stage two whatever the dates.
 */
export function settlementDatesRequired(project: {
  anyEnteredTg: boolean;
  fundings: readonly Funded110[];
}): {
  kugFinalSettlementDate: boolean;
  measure110SettlementDate: boolean;
  fundingUnknown: boolean;
} {
  return {
    kugFinalSettlementDate: project.anyEnteredTg,
    measure110SettlementDate: project.fundings.includes("known_yes"),
    fundingUnknown: project.fundings.includes("unknown"),
  };
}

const denied = { ok: false, because: "actor_not_allowed" } as const satisfies Permission;

/**
 * The settlement dates and a participation's funding (data-protection.md, funding and settlement
 * dates; Q52, Q217): back office, in normal mode; the database checks the role again.
 */
export function mayRecordFunding(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => role === "back_office");
}

/** Who reads a participation's funding with its source: back office and the PL (Q234). */
export function mayReadFunding(actor: Actor, target: PermissionTarget): Permission {
  if (actor.kind !== "staff") return denied;
  return staffPermission(actor, target, (role) => ["back_office", "project_lead"].includes(role));
}

/** The classes an evidence set keeps (data-protection.md, the evidence set; Q64, Q88). */
const evidenceSetClasses: ReadonlySet<RetentionClass> = new Set([
  "participation_record",
  "evidence_set",
  "audit_log",
]);

/**
 * Whether a participation enters the evidence-only phase (data-protection.md, the evidence-only
 * phase; Q64): only with an evidence set (it entered the TG, a conservative trigger, or its
 * funding is `known_yes`) and once every class outside the evidence set has been deleted. Without
 * one it is erased when its last class is due (`no_evidence_set`); an `unknown` funding of a
 * participation that never entered the TG decides neither (`funding_unknown`).
 */
export function evidenceOnlyApplies(
  classesLeft: readonly RetentionClass[],
  funding: Funded110,
  enteredTg: boolean,
): "applies" | "classes_left" | "no_evidence_set" | "funding_unknown" {
  if (!enteredTg && funding === "unknown") return "funding_unknown";
  if (!enteredTg && funding === "known_no") return "no_evidence_set";
  return classesLeft.every((c) => evidenceSetClasses.has(c)) ? "applies" : "classes_left";
}
