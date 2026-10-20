import { z } from "zod";

/** Staff sessions last 8 hours from login, without a sliding window (ADR-0007, D2). */
export const STAFF_SESSION_HOURS = 8;

/** Why a staff login is refused (D5); the code only, never the claimed name. */
export const StaffLoginRefusal = z.enum([
  "unknown_account",
  "account_deactivated",
  "identity_mismatch",
]);
export type StaffLoginRefusal = z.infer<typeof StaffLoginRefusal>;

/** A staff account as the login sees it. */
export type StaffLoginAccount = {
  id: string;
  oidcIssuer: string | null;
  oidcSubject: string | null;
  deactivated: boolean;
};

export type StaffLoginDecision =
  | { kind: "login"; staffUserId: string }
  | { kind: "bind"; staffUserId: string }
  | { kind: "refuse"; code: StaffLoginRefusal; staffUserId: string | null };

const claimText = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * The name a first login is matched by and its claim (D5): the `email` claim, else
 * `preferred_username`. The caller compares it with the account's email case-insensitively.
 */
export function loginNameOf(
  claims: Readonly<Record<string, unknown>>,
): { claim: "email" | "preferred_username"; name: string } | null {
  const email = claimText(claims.email);
  if (email !== null) return { claim: "email", name: email };
  const username = claimText(claims.preferred_username);
  return username === null ? null : { claim: "preferred_username", name: username };
}

/**
 * The outcome of an OIDC login (D5). `bound` is the account bound to the token's `(iss, sub)`;
 * `byLoginName` the account whose email equals the login name. A bound identity decides alone;
 * only an active, unbound account is bound at its first login.
 */
export function staffLoginDecision(accounts: {
  bound: StaffLoginAccount | null;
  byLoginName: StaffLoginAccount | null;
}): StaffLoginDecision {
  const { bound, byLoginName } = accounts;
  if (bound) {
    return bound.deactivated
      ? { kind: "refuse", code: "account_deactivated", staffUserId: bound.id }
      : { kind: "login", staffUserId: bound.id };
  }
  if (!byLoginName) return { kind: "refuse", code: "unknown_account", staffUserId: null };
  if (byLoginName.deactivated) {
    return { kind: "refuse", code: "account_deactivated", staffUserId: byLoginName.id };
  }
  if (byLoginName.oidcSubject !== null) {
    return { kind: "refuse", code: "identity_mismatch", staffUserId: byLoginName.id };
  }
  return { kind: "bind", staffUserId: byLoginName.id };
}
