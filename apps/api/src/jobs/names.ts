/** The background jobs (plan 5.9, ADR-0011); the handlers come with PR 1h-2. */
export const jobNames = {
  lifecycleSweep: "lifecycle.sweep",
  evaluateProject: "lifecycle.evaluate-project",
} as const;

/** The nightly run is a Berlin local time (round 9). */
export const timeZone = "Europe/Berlin";
