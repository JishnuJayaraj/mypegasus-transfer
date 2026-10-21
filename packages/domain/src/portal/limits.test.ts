import { describe, expect, it } from "vitest";
import { portalLimits } from "./limits";

// D14, D27 and D29 restated by hand; packages/db/src/portal-limits.int.test.ts holds the SQL to
// the same constants.
describe("portal limits", () => {
  it("are the plan's values", () => {
    expect(portalLimits).toEqual({
      activationCode: { validityDays: 30, failuresToLock: 5 },
      ipThrottle: { submissions: 10, windowMinutes: 15 },
      oneTimeCode: { digits: 6, validityMinutes: 15, requestsPerAddressPerHour: 5, failures: 5 },
      session: { idleMinutes: 30, absoluteHours: 12, lastSeenWriteSeconds: 60 },
    });
  });
});
