import { describe, expect, it } from "vitest";
import { portalLimits } from "./limits";
import { SensitiveStepUpMethod, stepUpDone, stepUpMethodOf } from "./step-up";

describe("the step-up before special-category data (Q129, Q137)", () => {
  it("re-enters the birth date for a birth-date account, else a step-up code", () => {
    expect(SensitiveStepUpMethod.options).toEqual(["birth_date", "photo_id_and_code"]);
    expect(stepUpMethodOf("birth_date")).toBe("birth_date");
    expect(stepUpMethodOf("photo_id")).toBe("photo_id_and_code");
  });

  it("counts once per session", () => {
    for (const assurance of ["birth_date", "photo_id"] as const) {
      expect(
        stepUpDone({
          assurance,
          sessionVerifiedBy: "one_time_code",
          steppedUpAt: "2026-10-21T10:00:00Z",
        }),
      ).toBe(true);
      expect(stepUpDone({ assurance, sessionVerifiedBy: "one_time_code", steppedUpAt: null })).toBe(
        false,
      );
    }
  });

  it("counts the session after an activation with the birth-date step, for that account only", () => {
    expect(
      stepUpDone({ assurance: "birth_date", sessionVerifiedBy: "birth_date", steppedUpAt: null }),
    ).toBe(true);
    // A photo-ID account needs its own code: neither a birth date nor the login code counts.
    expect(
      stepUpDone({ assurance: "photo_id", sessionVerifiedBy: "birth_date", steppedUpAt: null }),
    ).toBe(false);
    expect(stepUpDone({ assurance: "photo_id", sessionVerifiedBy: null, steppedUpAt: null })).toBe(
      false,
    );
  });

  it("ends the session at the fifth wrong birth date", () => {
    expect(portalLimits.stepUp).toEqual({ birthDateFailures: 5 });
  });
});
