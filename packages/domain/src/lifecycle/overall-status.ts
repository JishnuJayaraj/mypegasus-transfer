import type { ProjectType } from "../project";
import type { DsvStatus, MainStatus, ProfilingStatus } from "./enums";

/** A participation's three statuses, its project type and whether it has an entry wave. */
export type LifecycleState = {
  projectType: ProjectType;
  status: MainStatus;
  profilingStatus: ProfilingStatus;
  dsvStatus: DsvStatus;
  hasWave: boolean;
};

const tracksNotStarted = new Set<MainStatus>(["imported", "contacted", "unreachable"]);
const inOrAfterTg = new Set<MainStatus>(["active_in_tg", "exited"]);

/**
 * Whether the edges can reach this combination (plan 5.3): the tracks start at `informed`; an
 * offered DSV needs a wave, which can't change afterwards; TG entry needs a signed DSV;
 * `ta_only` has no DSV, no wave and no TG, and only it ends in `ta_completed`.
 */
export function isConsistentState(s: LifecycleState): boolean {
  const offered = s.dsvStatus !== "not_offered";
  if (s.projectType === "ta_only") {
    if (offered || s.hasWave || inOrAfterTg.has(s.status)) return false;
  } else if (s.status === "ta_completed") {
    return false;
  }
  if (tracksNotStarted.has(s.status) && (s.profilingStatus !== "not_started" || offered)) {
    return false;
  }
  if (offered && !s.hasWave) return false;
  return !inOrAfterTg.has(s.status) || s.dsvStatus === "dsv_signed";
}

/**
 * The one overall status the UI shows, as an i18n key; never stored. While `informed` it
 * names both tracks (e.g. "DSV unterschrieben, Profiling offen"), in the TG the profiling
 * track (Q74).
 */
export function deriveOverallStatus(s: LifecycleState): string {
  if (!isConsistentState(s)) throw new Error("Inconsistent lifecycle state");
  const key = `lifecycle.overall.${s.status}`;
  if (s.status === "informed") {
    return s.projectType === "ta_tg"
      ? `${key}.${s.dsvStatus}.${s.profilingStatus}`
      : `${key}.${s.profilingStatus}`;
  }
  return s.status === "active_in_tg" ? `${key}.${s.profilingStatus}` : key;
}
