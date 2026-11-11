import { z } from "zod";
import {
  staffPermission,
  type Actor,
  type Permission,
  type PermissionTarget,
} from "../access/permissions";
import { addDays, compareIsoDates } from "../dates";
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
 * the days kept after each of its triggers (the item is deleted on the day after the last kept).
 */
export type RetentionPeriod =
  | "unset"
  | "never"
  | { readonly days: Readonly<Record<string, number>> };
export type RetentionPeriods = Readonly<Record<RetentionClass, RetentionPeriod>>;

export type RetentionRule = {
  /** The events that start the class's period, by the key its period's days use. */
  triggers: readonly string[];
  /** Stage one deletes per item; stage two erases what is left of a participation (ADR-0008). */
  stage: 1 | 2;
  /** Whether the job applies the class yet; the rest is reported, never deleted. */
  applied: boolean;
};

/**
 * The rules (data-protection.md, retention and deletion). Applied: access credentials 30 days
 * after use, expiry, lock, revocation or end (Q122), and generated working copies' files after
 * supersession, an accepted scan, abandonment or the terminal status (Q179). The other classes
 * are reported only; their deletion per class, holds and the erasure come later.
 */
export const retentionRules: Readonly<Record<RetentionClass, RetentionRule>> = {
  project_master: { triggers: [], stage: 2, applied: false },
  staff_account: { triggers: [], stage: 2, applied: false },
  participation_record: { triggers: [], stage: 2, applied: false },
  personnel_file: { triggers: [], stage: 1, applied: false },
  health_record: { triggers: [], stage: 1, applied: false },
  audit_log: { triggers: [], stage: 2, applied: false },
  access_credential: { triggers: ["ended"], stage: 1, applied: true },
  evidence_set: { triggers: [], stage: 2, applied: false },
  form_working_copy: {
    triggers: ["superseded", "scan_accepted", "abandoned", "participation_closed"],
    stage: 1,
    applied: true,
  },
  orphaned_object: { triggers: ["stored"], stage: 1, applied: true },
  reference_data: { triggers: [], stage: 2, applied: false },
};

export type RetentionDue =
  | { kind: "period_unset" }
  | { kind: "never" }
  | { kind: "held" }
  | { kind: "not_due"; on: IsoDate | null }
  | { kind: "due"; stage: 1 | 2; trigger: string; from: IsoDate };

/**
 * When one item of a class may go: the earliest of its triggers' days plus the configured days,
 * plus one (kept for the full period; 30 days after use is deleted on day 31). A trigger the item
 * doesn't have yet counts nothing; a period missing a trigger's days is `period_unset`.
 */
export function retentionDue(
  item: {
    class: RetentionClass;
    /** The Berlin day each trigger happened, if it did. */
    triggers: Readonly<Record<string, IsoDate | null | undefined>>;
    held: boolean;
  },
  periods: RetentionPeriods,
  today: IsoDate,
): RetentionDue {
  const period = periods[item.class];
  if (period === "unset") return { kind: "period_unset" };
  if (period === "never") return { kind: "never" };
  const rule = retentionRules[item.class];
  if (rule.triggers.some((trigger) => !Number.isInteger(period.days[trigger]))) {
    return { kind: "period_unset" };
  }
  if (item.held) return { kind: "held" };
  let best: { trigger: string; from: IsoDate; on: IsoDate } | null = null;
  for (const trigger of rule.triggers) {
    const from = item.triggers[trigger];
    if (!from) continue;
    const on = addDays(from, period.days[trigger]! + 1);
    if (best === null || compareIsoDates(on, best.on) < 0) best = { trigger, from, on };
  }
  if (best === null || compareIsoDates(best.on, today) > 0) {
    return { kind: "not_due", on: best?.on ?? null };
  }
  return { kind: "due", stage: rule.stage, trigger: best.trigger, from: best.from };
}

/**
 * The last day a credential may have ended to be due today (`retentionDue`'s rule for the one
 * trigger `ended`, for the job to apply in one statement); `null` when the class isn't configured.
 */
export function credentialCutoff(periods: RetentionPeriods, today: IsoDate): IsoDate | null {
  const period = periods.access_credential;
  if (period === "unset" || period === "never" || !Number.isInteger(period.days.ended)) return null;
  return addDays(today, -(period.days.ended! + 1));
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
