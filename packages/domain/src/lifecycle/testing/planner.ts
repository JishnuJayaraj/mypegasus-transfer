import { addDays } from "../../dates";
import type { IsoDate } from "../../iso-date";
import type { ProjectType } from "../../project";
import type { DsvStatus, MainStatus, ProfilingStatus } from "../enums";
import type { ParticipationSnapshot, PlannedChange, PlannerProject, RunDay } from "../planner";
import { canTransition, type TransitionContext } from "../transition";
import { wave } from "./context";

/** Test fixtures for the planner (synthetic). The wave's cutoff is 2027-05-01. */
export const project: PlannerProject = { type: "ta_tg", waves: [wave] };

export function snapshot(overrides: Partial<ParticipationSnapshot> = {}): ParticipationSnapshot {
  return {
    current: { status: "informed", profilingStatus: "not_started", dsvStatus: "not_offered" },
    wave,
    participation: { tgStart: null, offerDeadline: null, tgEntryDate: null },
    facts: {},
    ...overrides,
  };
}

export const state = (
  status: MainStatus,
  profilingStatus: ProfilingStatus = "not_started",
  dsvStatus: DsvStatus = "not_offered",
) => ({ status, profilingStatus, dsvStatus });

/** The day's run at 04:15 Europe/Berlin (CEST from 2027-03-28 to 2027-10-30). */
export function runDay(day: IsoDate): RunDay {
  const offset = day >= "2027-03-28" && day < "2027-10-31" ? "+02:00" : "+01:00";
  return { day, scheduledAt: new Date(`${day}T04:15:00${offset}`) };
}

/** The window of a run on `today` after the last completed run on `lastCompleted`. */
export function window(lastCompleted: IsoDate | null, today: IsoDate) {
  const days: RunDay[] = [];
  const first = lastCompleted ? addDays(lastCompleted, 1) : today;
  for (let d = first; d <= today; d = addDays(d, 1)) days.push(runDay(d));
  return { days, today };
}

/**
 * Applies the planned changes in order, asserting that each one is an allowed system
 * transition; returns the resulting snapshot.
 */
export function replay(
  s: ParticipationSnapshot,
  changes: readonly PlannedChange[],
  projectType: ProjectType,
  today: IsoDate,
): ParticipationSnapshot {
  const field = { main: "status", profiling: "profilingStatus", dsv: "dsvStatus" } as const;
  return changes.reduce((acc, change) => {
    const ctx: TransitionContext = {
      projectType,
      current: acc.current,
      actor: { type: "system" },
      today,
      wave: acc.wave,
      participation: acc.participation,
      facts: acc.facts,
      ...(change.entryKind && { entryKind: change.entryKind, scheduledAt: change.scheduledAt }),
      ...(change.endReason && { endReason: change.endReason }),
    };
    const check = canTransition(change.track, change.from, change.to, ctx);
    if (!check.ok) throw new Error(`not allowed: ${JSON.stringify({ change, check })}`);
    return {
      ...acc,
      current: { ...acc.current, [field[change.track]]: change.to },
      participation:
        change.to === "active_in_tg"
          ? { ...acc.participation, tgEntryDate: change.effectiveDate }
          : acc.participation,
    };
  }, s);
}
