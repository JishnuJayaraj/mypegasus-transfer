import { z } from "zod";
import type { IsoDate } from "../iso-date";
import { planImport, type ExistingParticipant } from "./plan";
import { validateRow, type ImportValues } from "./rows";
import { ImportTarget, type ImportIssue, type ImportIssueCode } from "./targets";

// Manual creation (Slice 2 plan, "Planned in PR 2h", R32; PR 2h-2): one person entered by the PL
// is one import row, checked by the same rules, with four differences: an existing Personalnummer
// is refused rather than updated, a value the import would drop is a field error, the country is
// Germany (the only one the MVP accepts), and warnings and a possible duplicate need the PL's
// explicit word in the same request. Pure; codes only, never a value.

/**
 * The import's targets except the country, which is always Germany (round 32), and the knowledge
 * date, which the PL sets on the tab "Arbeitsuche" (`set_knowledge_date`, Q201).
 */
export const manualTargets = ImportTarget.options.filter(
  (target): target is Exclude<ImportTarget, "addressCountry" | "knowledgeDate"> =>
    target !== "addressCountry" && target !== "knowledgeDate",
);
export type ManualTarget = (typeof manualTargets)[number];
export type ManualValues = Partial<Record<ManualTarget, string>>;

/** `POST /projects/{projectId}/participations`: the values as typed, dates as `TT.MM.JJJJ`. */
export const ManualParticipationInput = z
  .strictObject({
    values: z.strictObject(
      Object.fromEntries(
        manualTargets.map((target) => [target, z.string().max(500).optional()]),
      ) as {
        [K in ManualTarget]: z.ZodOptional<z.ZodString>;
      },
    ),
    /** The entry wave of the new participation (`ta_tg` only). */
    waveId: z.uuid().optional(),
    /** The PL saw the warnings (age plausibility) and creates anyway. */
    confirmWarnings: z.boolean().default(false),
    /** The PL saw that a person with the same birth date and names exists and creates anyway. */
    createDespiteDuplicate: z.boolean().default(false),
  })
  .meta({ id: "ManualParticipationInput" });
export type ManualParticipationInput = z.infer<typeof ManualParticipationInput>;

export type ManualIssueCode =
  | ImportIssueCode
  | "personnel_number_taken"
  | "value_invalid"
  | "warnings_unconfirmed";
export type ManualIssue = { target: ImportIssue["target"]; code: ManualIssueCode };

export type ManualCheck =
  | { ok: true; values: ImportValues; confirmedWarnings: ImportIssueCode[] }
  | { ok: false; issues: ManualIssue[]; participationId?: string };

const issue = ({ target, code }: { target: ImportIssue["target"]; code: ManualIssueCode }) => ({
  target,
  code,
});

/**
 * Checks one manually entered person against the project's participations (R32). Refusals come in
 * this order: an existing Personalnummer (with that participation's id); the row's errors, a
 * value the import would drop among them as `value_invalid`; then, together, an undecided
 * possible duplicate and unconfirmed warnings with the warnings themselves. On success the values
 * are those the import would store, and the warnings to audit as `warning_confirmed`.
 */
export function checkManualCreation(input: {
  values: ManualValues;
  existing: readonly ExistingParticipant[];
  relaxedRuleIds: ReadonlySet<string>;
  today: IsoDate;
  confirmWarnings: boolean;
  createDespiteDuplicate: boolean;
}): ManualCheck {
  const validated = validateRow({ row: 1, cells: input.values, country: "DE", today: input.today });
  const taken = input.existing.find(
    (p) => p.values.personnelNumber === validated.values.personnelNumber,
  );
  if (taken) {
    return {
      ok: false,
      issues: [{ target: "personnelNumber", code: "personnel_number_taken" }],
      participationId: taken.participationId,
    };
  }
  // A form can be corrected at once, so nothing is dropped silently: such a value is an error.
  const dropped = validated.issues.filter((i) => i.code === "value_invalid_dropped");
  const planned = planImport({
    rows: [{ ...validated, issues: validated.issues.filter((i) => !dropped.includes(i)) }],
    mapped: new Set(ImportTarget.options),
    existing: input.existing,
    relaxedRuleIds: input.relaxedRuleIds,
  }).rows[0]!;
  const errors: ManualIssue[] = [
    ...(planned.outcome === "error"
      ? planned.issues.filter((i) => i.severity === "error").map(issue)
      : []),
    ...dropped.map(({ target }) => ({ target, code: "value_invalid" as const })),
  ];
  if (errors.length > 0) return { ok: false, issues: errors };
  const warnings = planned.issues.filter((i) => i.code !== "possible_duplicate");
  const duplicate = planned.issues.length > warnings.length;
  const refusals: ManualIssue[] = [];
  if (duplicate && !input.createDespiteDuplicate) {
    refusals.push({ target: null, code: "possible_duplicate" });
  }
  if (warnings.length > 0 && !input.confirmWarnings) {
    refusals.push({ target: null, code: "warnings_unconfirmed" }, ...warnings.map(issue));
  }
  if (refusals.length > 0) return { ok: false, issues: refusals };
  return {
    ok: true,
    values: validated.values,
    confirmedWarnings: [
      ...new Set([
        ...(duplicate ? ["possible_duplicate" as const] : []),
        ...warnings.map((w) => w.code),
      ]),
    ],
  };
}
