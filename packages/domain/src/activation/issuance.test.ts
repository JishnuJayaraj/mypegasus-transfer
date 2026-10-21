import { describe, expect, it } from "vitest";
import { issuanceRefusals, type IssuanceFacts } from "./issuance";

const valid: IssuanceFacts = {
  projectStatus: "active",
  participationStatus: "imported",
  channel: "letter",
  hasBirthDate: true,
  hasPostalAddress: true,
  identityChecked: false,
  beforeCutoff: true,
  hasOpenCode: false,
  replaceOpenCode: false,
  accountActivated: false,
};

describe("activation-code issuance", () => {
  it("accepts a complete letter issuance", () => {
    expect(issuanceRefusals(valid)).toEqual([]);
  });

  it.each([
    [{ projectStatus: "draft" }, "project_not_active"],
    [{ participationStatus: "withdrawn" }, "participation_closed"],
    [{ participationStatus: "ta_completed" }, "participation_closed"],
    [{ participationStatus: "exited" }, "participation_closed"],
    [{ hasBirthDate: false }, "birth_date_required"],
    [{ hasPostalAddress: false }, "address_required"],
    [{ beforeCutoff: false }, "before_cutoff"],
    [{ hasOpenCode: true }, "open_code_exists"],
    [{ accountActivated: true }, "already_activated"],
  ] as const)("refuses %o with %s", (change, refusal) => {
    expect(issuanceRefusals({ ...valid, ...change })).toContain(refusal);
  });

  it("allows a conscious replacement and requires ID checks only for ID-backed channels", () => {
    expect(issuanceRefusals({ ...valid, hasOpenCode: true, replaceOpenCode: true })).not.toContain(
      "open_code_exists",
    );
    expect(
      issuanceRefusals({
        ...valid,
        channel: "sheet",
        hasBirthDate: false,
        hasPostalAddress: false,
      }),
    ).toEqual([]);
    expect(
      issuanceRefusals({
        ...valid,
        channel: "in_person",
        hasBirthDate: false,
        hasPostalAddress: false,
      }),
    ).toContain("identity_not_checked");
    expect(
      issuanceRefusals({
        ...valid,
        channel: "in_person",
        hasBirthDate: false,
        hasPostalAddress: false,
        identityChecked: true,
      }),
    ).toEqual([]);
  });

  it("applies the cutoff only to pre-admission statuses", () => {
    for (const participationStatus of ["imported", "contacted", "unreachable"] as const) {
      expect(issuanceRefusals({ ...valid, participationStatus, beforeCutoff: false })).toContain(
        "before_cutoff",
      );
    }
    for (const participationStatus of ["informed", "active_in_tg"] as const) {
      expect(
        issuanceRefusals({ ...valid, participationStatus, beforeCutoff: false }),
      ).not.toContain("before_cutoff");
    }
  });

  // Q130: an activated account gets a code only as a recovery; no cutoff, no status change.
  describe("recovery", () => {
    const recovery: IssuanceFacts = {
      ...valid,
      purpose: "recovery",
      participationStatus: "contacted",
      accountActivated: true,
      beforeCutoff: false,
    };

    it("is issued for an activated account after the cutoff", () => {
      expect(issuanceRefusals(recovery)).toEqual([]);
    });

    it("needs an activated account and an open participation", () => {
      expect(issuanceRefusals({ ...recovery, accountActivated: false })).toEqual(["not_activated"]);
      expect(issuanceRefusals({ ...recovery, participationStatus: "exited" })).toContain(
        "participation_closed",
      );
    });

    it("keeps the channel rules and the reissue confirmation", () => {
      expect(issuanceRefusals({ ...recovery, hasBirthDate: false })).toEqual([
        "birth_date_required",
      ]);
      expect(issuanceRefusals({ ...recovery, hasOpenCode: true })).toEqual(["open_code_exists"]);
      expect(issuanceRefusals({ ...recovery, channel: "in_person" })).toEqual([
        "identity_not_checked",
      ]);
    });
  });
});
