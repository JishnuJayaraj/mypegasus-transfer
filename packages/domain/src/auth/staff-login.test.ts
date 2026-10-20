import { describe, expect, it } from "vitest";
import {
  loginNameOf,
  STAFF_SESSION_HOURS,
  staffLoginDecision,
  type StaffLoginAccount,
} from "./staff-login";

const issuer = "https://login.example.org/tenant/v2.0";
const account = (overrides: Partial<StaffLoginAccount> = {}): StaffLoginAccount => ({
  id: "00000000-0000-4000-8000-000000000003",
  oidcIssuer: null,
  oidcSubject: null,
  deactivated: false,
  ...overrides,
});

describe("loginNameOf (D5)", () => {
  it("takes the email claim, else preferred_username, trimmed", () => {
    expect(loginNameOf({ email: " A@Example.org ", preferred_username: "b@example.org" })).toEqual({
      claim: "email",
      name: "A@Example.org",
    });
    const username = { claim: "preferred_username", name: "b@example.org" };
    expect(loginNameOf({ preferred_username: "b@example.org" })).toEqual(username);
    expect(loginNameOf({ email: "  ", preferred_username: "b@example.org" })).toEqual(username);
  });

  it("is null without a usable claim", () => {
    expect(loginNameOf({})).toBeNull();
    expect(loginNameOf({ email: 42, preferred_username: ["x"] })).toBeNull();
    expect(loginNameOf({ preferred_username: "" })).toBeNull();
  });
});

describe("staffLoginDecision (D5)", () => {
  it("logs in the account bound to (iss, sub)", () => {
    const bound = account({ oidcIssuer: issuer, oidcSubject: "sub-1" });
    expect(staffLoginDecision({ bound, byLoginName: null })).toEqual({
      kind: "login",
      staffUserId: bound.id,
    });
  });

  it("matches later logins by (iss, sub) only: the email account doesn't matter", () => {
    const bound = account({ oidcIssuer: issuer, oidcSubject: "sub-1" });
    const other = account({ id: "00000000-0000-4000-8000-000000000004" });
    expect(staffLoginDecision({ bound, byLoginName: other })).toEqual({
      kind: "login",
      staffUserId: bound.id,
    });
  });

  it("refuses a deactivated bound account", () => {
    const bound = account({ oidcIssuer: issuer, oidcSubject: "sub-1", deactivated: true });
    expect(staffLoginDecision({ bound, byLoginName: null })).toEqual({
      kind: "refuse",
      code: "account_deactivated",
      staffUserId: bound.id,
    });
  });

  it("binds an active, unbound account matched by its login name", () => {
    const match = account();
    expect(staffLoginDecision({ bound: null, byLoginName: match })).toEqual({
      kind: "bind",
      staffUserId: match.id,
    });
  });

  it("refuses an unknown account without naming anyone", () => {
    expect(staffLoginDecision({ bound: null, byLoginName: null })).toEqual({
      kind: "refuse",
      code: "unknown_account",
      staffUserId: null,
    });
  });

  it("refuses a deactivated account matched by its login name", () => {
    const match = account({ deactivated: true });
    expect(staffLoginDecision({ bound: null, byLoginName: match })).toEqual({
      kind: "refuse",
      code: "account_deactivated",
      staffUserId: match.id,
    });
  });

  it("refuses an account bound to another identity", () => {
    const match = account({ oidcIssuer: issuer, oidcSubject: "sub-2" });
    expect(staffLoginDecision({ bound: null, byLoginName: match })).toEqual({
      kind: "refuse",
      code: "identity_mismatch",
      staffUserId: match.id,
    });
  });

  it("refuses deactivation before a mismatch", () => {
    const match = account({ oidcIssuer: issuer, oidcSubject: "sub-2", deactivated: true });
    expect(staffLoginDecision({ bound: null, byLoginName: match })).toMatchObject({
      code: "account_deactivated",
    });
  });
});

describe("staff session lifetime (ADR-0007)", () => {
  it("is 8 hours absolute", () => {
    expect(STAFF_SESSION_HOURS).toBe(8);
  });
});
