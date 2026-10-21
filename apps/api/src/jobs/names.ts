/** The background jobs (plan 5.9, ADR-0011); the handlers come with PR 1h-2. */
export const jobNames = {
  lifecycleSweep: "lifecycle.sweep",
  evaluateProject: "lifecycle.evaluate-project",
  // Slice 3 plan D21: the notice that goes to a newly activated channel.
  activationNotice: "portal.activation-notice",
} as const;

/** The nightly run is a Berlin local time (round 9). */
export const timeZone = "Europe/Berlin";
