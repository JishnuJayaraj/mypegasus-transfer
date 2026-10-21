import { describe, expect, it } from "vitest";
import { privacyNoticeState } from "./notice-state";

describe("Art. 14 notice state", () => {
  it("uses one clamped calendar month from data receipt", () => {
    expect(privacyNoticeState("2026-01-31", [], "2026-02-27")).toEqual({
      state: "due",
      dueOn: "2026-02-28",
      providedAt: null,
    });
    expect(privacyNoticeState("2024-01-31", [], "2024-02-29").dueOn).toBe("2024-02-29");
  });

  it("becomes overdue only after the due day", () => {
    expect(privacyNoticeState("2026-01-20", [], "2026-02-20").state).toBe("due");
    expect(privacyNoticeState("2026-01-20", [], "2026-02-21").state).toBe("overdue");
  });

  it("is provided as soon as an immutable delivery exists", () => {
    expect(
      privacyNoticeState("2026-01-20", [{ providedAt: "2026-01-25T11:00:00.000Z" }], "2026-04-01"),
    ).toEqual({
      state: "provided",
      dueOn: "2026-02-20",
      providedAt: "2026-01-25T11:00:00.000Z",
    });
  });
});
