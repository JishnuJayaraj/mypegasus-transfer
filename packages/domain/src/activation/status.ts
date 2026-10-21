import { z } from "zod";
import type { ActivationChannel, ActivationPurpose } from "./model";

export const ActivationCodeState = z.enum([
  "none",
  "printed",
  "open",
  "delivery_unknown",
  "expired",
  "locked",
  "revoked",
  "used",
]);

export const ActivationStatus = z
  .strictObject({
    account: z.enum(["activated", "not_activated"]),
    code: ActivationCodeState,
    issuedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "ActivationStatus" });
export type ActivationStatus = z.infer<typeof ActivationStatus>;

export interface ActivationCodeSnapshot {
  /** `activation` when left out. */
  purpose?: ActivationPurpose;
  channel: ActivationChannel;
  issuedAt: string;
  expiresAt: string;
  deliveryStatus: "pending" | "sent" | "failed" | "unknown" | null;
  handedOverAt: string | null;
  lockedAt: string | null;
  revokedAt: string | null;
  usedAt: string | null;
}

export function activationStatus(
  accountActivated: boolean,
  code: ActivationCodeSnapshot | null,
  now: string,
): ActivationStatus {
  // An activated account shows only a recovery code's state (Q130).
  if (!code || (accountActivated && code.purpose !== "recovery")) {
    return {
      account: accountActivated ? "activated" : "not_activated",
      code: "none",
      issuedAt: null,
      expiresAt: null,
    };
  }
  let state: ActivationStatus["code"];
  if (code.usedAt) state = "used";
  else if (code.revokedAt) state = "revoked";
  else if (code.lockedAt) state = "locked";
  else if (code.expiresAt < now) state = "expired";
  else if (code.deliveryStatus === "unknown") state = "delivery_unknown";
  else if (code.channel === "sheet" && !code.handedOverAt) state = "printed";
  else state = "open";
  return {
    account: accountActivated ? "activated" : "not_activated",
    code: state,
    issuedAt: code.issuedAt,
    expiresAt: code.expiresAt,
  };
}
