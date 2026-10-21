import { describe, expect, it } from "vitest";
import { BatchActivationCodeInput, RecoveryCodeInput } from "./api";

describe("batch activation-code input", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("refuses the same participation twice", () => {
    const result = BatchActivationCodeInput.safeParse({
      participationIds: [id, id],
      channel: "letter",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["participationIds"],
      params: { code: "duplicate" },
    });
    expect(
      BatchActivationCodeInput.parse({ participationIds: [id], channel: "sheet" }),
    ).toMatchObject({ language: "de", replaceOpenCode: false });
  });
});

describe("recovery-code input (Q130)", () => {
  it("needs the staff's verification, and for in person the photo-ID check and an address", () => {
    expect(
      RecoveryCodeInput.parse({ purpose: "recovery", channel: "letter", identityVerified: true }),
    ).toMatchObject({ language: "de", replaceOpenCode: false });
    expect(RecoveryCodeInput.safeParse({ purpose: "recovery", channel: "letter" }).success).toBe(
      false,
    );
    expect(
      RecoveryCodeInput.safeParse({
        purpose: "recovery",
        channel: "in_person",
        identityVerified: true,
        deliveryKind: "email",
        deliveryAddress: "person@example.invalid",
      }).success,
    ).toBe(false);
    expect(
      RecoveryCodeInput.safeParse({
        purpose: "activation",
        channel: "sheet",
        identityVerified: true,
      }).success,
    ).toBe(false);
  });
});
