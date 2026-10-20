import { describe, expect, it } from "vitest";
import { StaffAuditEvent, StaffAuditEventType, StaffSessionEndReason } from "./staff-events";

const staffUserId = "00000000-0000-4000-8000-000000000003";
const base = { requestId: "0c4b1f4e-1111-4000-8000-000000000001" };

const ok = (input: unknown) => StaffAuditEvent.safeParse(input).success;

describe("staff audit events (D6)", () => {
  it("has the 3b event types and session end reasons", () => {
    expect(StaffAuditEventType.options).toEqual([
      "staff_login",
      "staff_logout",
      "staff_login_refused",
      "staff_identity_bound",
    ]);
    expect(StaffSessionEndReason.options).toEqual(["logout", "deactivated", "superseded"]);
  });

  it("accepts a login and a logout of the acting user, with the method as a code", () => {
    expect(ok({ ...base, type: "staff_login", staffUserId, method: "oidc" })).toBe(true);
    expect(ok({ ...base, type: "staff_login", staffUserId, method: "dev" })).toBe(true);
    expect(ok({ ...base, type: "staff_logout", staffUserId })).toBe(true);
    expect(ok({ ...base, type: "staff_login", staffUserId, method: "password" })).toBe(false);
  });

  it("records a refusal as a code, the account only where one was matched", () => {
    const refused = { ...base, type: "staff_login_refused", method: "oidc" };
    expect(ok({ ...refused, reasonCode: "unknown_account", subjectStaffUserId: null })).toBe(true);
    expect(
      ok({ ...refused, reasonCode: "identity_mismatch", subjectStaffUserId: staffUserId }),
    ).toBe(true);
    expect(ok({ ...refused, reasonCode: "unknown_account", subjectStaffUserId: staffUserId })).toBe(
      false,
    );
    expect(ok({ ...refused, reasonCode: "account_deactivated", subjectStaffUserId: null })).toBe(
      false,
    );
  });

  it("never carries the claimed email (strict objects)", () => {
    expect(
      ok({
        ...base,
        type: "staff_login_refused",
        method: "oidc",
        reasonCode: "unknown_account",
        subjectStaffUserId: null,
        email: "someone@example.org",
      }),
    ).toBe(false);
  });

  it("records a binding with the claim it matched", () => {
    const bound = { ...base, type: "staff_identity_bound", staffUserId };
    expect(ok({ ...bound, matchedBy: "email" })).toBe(true);
    expect(ok({ ...bound, matchedBy: "preferred_username" })).toBe(true);
    expect(ok({ ...bound, matchedBy: "upn" })).toBe(false);
  });

  it("holds request ids to the id pattern", () => {
    expect(ok({ requestId: null, type: "staff_logout", staffUserId })).toBe(true);
    expect(ok({ requestId: "not an id", type: "staff_logout", staffUserId })).toBe(false);
  });
});
