import { z } from "zod";
import type { ActivationChannel } from "./model";

/**
 * The steps of an activation after the code (Slice 3 plan D23): the notice is shown first (the
 * portal records the version at completion), then the birth date, then either the delivery address
 * of an `in_person` code or a private email or mobile with a one-time code. The database functions
 * repeat these rules under the code's row lock.
 */
export const ActivationStep = z
  .enum(["birth_date", "delivery_address", "channel", "one_time_code", "complete"])
  .meta({ id: "ActivationStep" });
export type ActivationStep = z.infer<typeof ActivationStep>;

/** The requests of an activating session; `complete` is the completion. */
export type ActivationRequest = Exclude<ActivationStep, "one_time_code">;

export interface ActivationProgress {
  channel: ActivationChannel;
  hasBirthDate: boolean;
  birthDateChecked: boolean;
  deliveryAddressChecked: boolean;
  /** A one-time code went to the chosen address and is still live. */
  oneTimeCodeSent: boolean;
}

export const IdentityAssurance = z.enum(["birth_date", "photo_id"]);
export type IdentityAssurance = z.infer<typeof IdentityAssurance>;

/** Q129: only a handed-over sheet or an in-person code (both after a photo-ID check) skip it. */
export function needsBirthDate(channel: ActivationChannel, hasBirthDate: boolean): boolean {
  return hasBirthDate || channel === "letter";
}

export function nextActivationStep(progress: ActivationProgress): ActivationStep {
  if (needsBirthDate(progress.channel, progress.hasBirthDate) && !progress.birthDateChecked) {
    return "birth_date";
  }
  if (progress.channel === "in_person") {
    return progress.deliveryAddressChecked ? "complete" : "delivery_address";
  }
  return progress.oneTimeCodeSent ? "one_time_code" : "channel";
}

/** `null` when the request fits the current step; a new one-time code may always be requested. */
export function stepRefusal(
  progress: ActivationProgress,
  request: ActivationRequest,
): "step_not_allowed" | null {
  const next = nextActivationStep(progress);
  const allowed =
    request === next ||
    (next === "one_time_code" && (request === "channel" || request === "complete"));
  return allowed ? null : "step_not_allowed";
}

/** D29: how the identity was assured at activation; `photo_id` only without the birth date. */
export function identityAssurance(progress: ActivationProgress): IdentityAssurance {
  return progress.birthDateChecked ? "birth_date" : "photo_id";
}
