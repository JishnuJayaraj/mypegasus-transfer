import { z } from "zod";
import type { StepUpMethod } from "../activation/model";
import type { IdentityAssurance } from "../activation/steps";
import { isoDate } from "../iso-date";
import { NoticeLanguage } from "../notices/catalog";

// The step-up before special-category data (ADR-0007, step-up; Q129, Q137): once per portal
// session, before the health and disability fields are read or written. The database functions
// repeat these rules under the session's row lock.

/**
 * How a session steps up: an account assured by birth date re-enters it, one assured by photo ID
 * gets a step-up one-time code to a verified channel it picks.
 */
export const SensitiveStepUpMethod = z
  .enum(["birth_date", "photo_id_and_code"])
  .meta({ id: "SensitiveStepUpMethod" });
export type SensitiveStepUpMethod = z.infer<typeof SensitiveStepUpMethod>;

export const stepUpMethodOf = (assurance: IdentityAssurance): SensitiveStepUpMethod =>
  assurance === "birth_date" ? "birth_date" : "photo_id_and_code";

export type StepUpFacts = {
  assurance: IdentityAssurance;
  /** How the session itself was verified (`participant_session.step_up_method`). */
  sessionVerifiedBy: StepUpMethod | null;
  /** When this session stepped up, if it did. */
  steppedUpAt: string | null;
};

/**
 * Whether the session has stepped up: by its own step-up, or, for a birth-date account, because
 * it follows an activation (or recovery) with the birth-date step. A login code never counts.
 */
export const stepUpDone = (facts: StepUpFacts) =>
  facts.steppedUpAt !== null ||
  (facts.assurance === "birth_date" && facts.sessionVerifiedBy === "birth_date");

/** The session's step-up as the portal shows it. */
export const PortalStepUp = z
  .strictObject({ method: SensitiveStepUpMethod, done: z.boolean() })
  .meta({ id: "PortalStepUp" });
export type PortalStepUp = z.infer<typeof PortalStepUp>;

/** `POST /portal/step-up/birth-date`: a birth-date account re-enters it. */
export const StepUpBirthDateInput = z
  .strictObject({ birthDate: isoDate })
  .meta({ id: "StepUpBirthDateInput" });

/** `POST /portal/step-up/code-request`: a photo-ID account picks a verified channel. */
export const StepUpCodeRequestInput = z
  .strictObject({ channelId: z.uuid(), language: NoticeLanguage.default("de") })
  .meta({ id: "StepUpCodeRequestInput" });

/** `POST /portal/step-up/code`: the step-up code sent to it. */
export const StepUpCodeInput = z
  .strictObject({ oneTimeCode: z.string().regex(/^[0-9]{6}$/) })
  .meta({ id: "StepUpCodeInput" });
