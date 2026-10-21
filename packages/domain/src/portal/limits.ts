/**
 * The limits of codes, one-time codes and participant sessions (ADR-0007, limits; Q128;
 * data-protection.md, Authentication). The SQL functions use the same values; a drift test
 * (packages/db/src/portal-limits.int.test.ts) holds them equal.
 */
export const portalLimits = {
  /** Valid 30 days from issuance; the fifth failure locks. */
  activationCode: { validityDays: 30, failuresToLock: 5 },
  /** Q128: every code submission per client IP (in memory in Slice 3). */
  ipThrottle: { submissions: 10, windowMinutes: 15 },
  /** Login and channel verification together count towards the hourly limit. */
  oneTimeCode: { digits: 6, validityMinutes: 15, requestsPerAddressPerHour: 5, failures: 5 },
  /** `activating` and `active` alike; `last_seen_at` is written at most once a minute. */
  session: { idleMinutes: 30, absoluteHours: 12, lastSeenWriteSeconds: 60 },
  /** Q137: the fifth wrong birth date of a step-up ends the session; a step-up code counts alone. */
  stepUp: { birthDateFailures: 5 },
} as const;
