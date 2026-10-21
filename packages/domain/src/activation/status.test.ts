import { describe, expect, it } from "vitest";
import { activationStatus } from "./status";

describe("activation status", () => {
  it("prefers the activated account state", () => {
    expect(activationStatus(true, null, "2026-10-20T12:00:00.000Z")).toEqual({
      account: "activated",
      code: "none",
      expiresAt: null,
      issuedAt: null,
    });
  });

  it.each([
    [{ channel: "sheet", handedOverAt: null }, "printed"],
    [{ channel: "sheet", handedOverAt: "2026-10-20T10:00:00.000Z" }, "open"],
    [{ channel: "letter" }, "open"],
    [{ channel: "in_person", deliveryStatus: "unknown" }, "delivery_unknown"],
    [{ channel: "letter", lockedAt: "2026-10-20T10:00:00.000Z" }, "locked"],
    [{ channel: "letter", revokedAt: "2026-10-20T10:00:00.000Z" }, "revoked"],
    [{ channel: "letter", usedAt: "2026-10-20T10:00:00.000Z" }, "used"],
  ] as const)("derives %s", (change, expected) => {
    const code = {
      issuedAt: "2026-10-01T10:00:00.000Z",
      expiresAt: "2026-10-31T10:00:00.000Z",
      deliveryStatus: null,
      handedOverAt: null,
      lockedAt: null,
      revokedAt: null,
      usedAt: null,
      ...change,
    };
    expect(activationStatus(false, code, "2026-10-20T12:00:00.000Z").code).toBe(expected);
  });

  it("derives expiry only after all committed terminal markers", () => {
    const code = {
      channel: "letter" as const,
      issuedAt: "2026-09-01T10:00:00.000Z",
      expiresAt: "2026-10-01T10:00:00.000Z",
      deliveryStatus: null,
      handedOverAt: null,
      lockedAt: null,
      revokedAt: null,
      usedAt: null,
    };
    expect(activationStatus(false, code, "2026-10-20T12:00:00.000Z").code).toBe("expired");
  });
});
