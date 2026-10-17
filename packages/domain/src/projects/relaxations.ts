import { z } from "zod";

// Rule relaxations with approval (Slice 2 plan 5.9; Q75, round 14, R2, R3). The vocabulary lives
// here so the audit model, the database enums and the API share it; `@transfer/config` re-exports
// the reason codes from `override.ts`, as `model.ts` does the Agentur vocabulary (round 27).

/**
 * The controlled reason codes of a rule relaxation (round 14; Q100, confirmed in round 22):
 * project-wide, so none reveals anything about a person.
 */
export const RelaxationReasonCode = z.enum([
  "source_data_not_provided",
  "not_needed_for_project_measures",
  "collected_outside_platform",
  "agentur_confirmed_not_required",
]);
export type RelaxationReasonCode = z.infer<typeof RelaxationReasonCode>;

/** A relaxation request's life: pending, then decided by another person or withdrawn (5.1). */
export const RelaxationRequestStatus = z.enum(["requested", "approved", "rejected", "withdrawn"]);
export type RelaxationRequestStatus = z.infer<typeof RelaxationRequestStatus>;

/**
 * The id of a completeness rule as a relaxation names it: id characters only, so it may enter the
 * audit trail like an Agentur key (the database checks the same pattern).
 */
export const RuleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
