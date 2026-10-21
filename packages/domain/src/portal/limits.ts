/**
 * The limits of codes, one-time codes and participant sessions (Slice 3 plan D14, D27, D29;
 * data-protection.md, Authentication). The SQL functions use the same values; a drift test
 * (packages/db/src/portal-limits.int.test.ts) holds them equal.
 */
export const portalLimits = {
  /** D13, D14: valid 30 days from issuance; the fifth failure locks. */
  activationCode: { validityDays: 30, failuresToLock: 5 },
  /** D14: every code submission per client IP (in memory in Slice 3). */
  ipThrottle: { submissions: 10, windowMinutes: 15 },
  /** D27: login and channel verification together count towards the hourly limit. */
  oneTimeCode: { digits: 6, validityMinutes: 15, requestsPerAddressPerHour: 5, failures: 5 },
  /** D29: `activating` and `active` alike; `last_seen_at` is written at most once a minute. */
  session: { idleMinutes: 30, absoluteHours: 12, lastSeenWriteSeconds: 60 },
} as const;
