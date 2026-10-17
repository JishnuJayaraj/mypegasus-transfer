import { z } from "zod";
import { isoDate } from "../iso-date";
import { Step } from "../lifecycle/enums";
import { ExpectedOverrideVersion } from "./agentur-settings";

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

/** The PL asks to relax one rule (`POST …/config/relaxations`); strict. */
export const RequestRelaxationInput = z
  .strictObject({ ruleId: RuleId, reasonCode: RelaxationReasonCode })
  .meta({ id: "RequestRelaxationInput" });
export type RequestRelaxationInput = z.infer<typeof RequestRelaxationInput>;

/**
 * Another person's decision (`POST /config/relaxations/{requestId}/decision`, R2): an approval
 * writes a new override version, so it names the version it expects (409 when stale); strict.
 */
export const DecideRelaxationInput = z
  .discriminatedUnion("decision", [
    z.strictObject({ decision: z.literal("approved"), expectedVersion: ExpectedOverrideVersion }),
    z.strictObject({ decision: z.literal("rejected") }),
  ])
  .meta({ id: "DecideRelaxationInput" });
export type DecideRelaxationInput = z.infer<typeof DecideRelaxationInput>;

/** A withdrawal carries nothing (`POST …/withdrawal`, a JSON body like every write). */
export const WithdrawRelaxationInput = z.strictObject({}).meta({ id: "WithdrawRelaxationInput" });

/** Removes an approved relaxation (`DELETE …/config/relaxations/{ruleId}`, query); strict. */
export const RemoveRelaxationQuery = z.strictObject({
  expectedVersion: z.coerce.number().pipe(ExpectedOverrideVersion),
});

/** An approved relaxation as the override stores it and the API returns it. */
export const ApprovedRelaxation = z.strictObject({
  ruleId: z.string(),
  reasonCode: RelaxationReasonCode,
  approvedBy: z.uuid().meta({ description: "Staff user id" }),
  approvedOn: isoDate,
});

/** An open relaxation request, with what the viewer may do with it (round 26). */
export const RelaxationRequest = z.strictObject({
  id: z.uuid(),
  ruleId: RuleId,
  reasonCode: RelaxationReasonCode,
  requestedBy: z.uuid().meta({ description: "Staff user id" }),
  requestedOn: isoDate,
  capabilities: z.strictObject({ decide: z.boolean(), withdraw: z.boolean() }),
});

/** A rule the PL may ask to relax: `operational_default` in some chain, not relaxed or asked. */
export const RelaxableRule = z.strictObject({ ruleId: RuleId, step: Step });
