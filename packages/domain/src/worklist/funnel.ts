import { z } from "zod";
import { DsvStatus, LifecycleFlag, MainStatus, ProfilingStatus } from "../lifecycle/enums";
import { PrivacyNoticeState } from "../privacy/notice-state";
import type { ProjectType } from "../project";
import { DeadlineKind, DeadlineState, remainingFlags } from "./deadlines";
import { ActivationFilter, matchesWorklistFilter, WorklistFilter } from "./filter";
import { PortalReach, type WorklistItem } from "./projection";

// The dashboard (data-protection.md, the work list and the dashboard): every count is the number
// of distinct participations its filter matches in the same work list, so a count and its
// drill-down are one predicate.

export const DashboardCount = z
  .strictObject({ key: z.string(), count: z.int().min(0), filter: WorklistFilter })
  .meta({ id: "DashboardCount" });
export type DashboardCount = z.infer<typeof DashboardCount>;

export const DashboardGroup = z.enum([
  "tiles",
  "statuses",
  "profilingStatuses",
  "dsvStatuses",
  "waves",
  "activation",
  "notice",
  "deadlines",
  "flags",
  "portal",
]);
export type DashboardGroup = z.infer<typeof DashboardGroup>;

export const ProjectDashboard = z
  .strictObject({
    /** `project`: the PL or back office; `assigned`: a consultant's assigned participations. */
    scope: z.enum(["project", "assigned"]),
    generatedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    counts: z.strictObject(
      Object.fromEntries(
        DashboardGroup.options.map((group) => [group, z.array(DashboardCount)]),
      ) as {
        [K in DashboardGroup]: z.ZodArray<typeof DashboardCount>;
      },
    ),
  })
  .meta({ id: "ProjectDashboard" });
export type ProjectDashboard = z.infer<typeof ProjectDashboard>;

export type FunnelProject = { type: ProjectType; waves: readonly { id: string }[] };

type Entry = { key: string; filter: WorklistFilter };
const each = <T extends string>(values: readonly T[], filter: (value: T) => WorklistFilter) =>
  values.map((value): Entry => ({ key: value, filter: filter(value) }));

/**
 * Each count's key and filter, by group: the tiles, the three tracks (DSV only in `ta_tg`), the
 * waves and "ohne Welle" (`ta_tg`), activation, notice, deadline kind × state, the flags that stay
 * flags, the portal.
 */
export function funnelFilters(project: FunnelProject): Record<DashboardGroup, Entry[]> {
  const taTg = project.type === "ta_tg";
  return {
    tiles: [
      { key: "participations", filter: {} },
      { key: "open_actions", filter: { actions: "any" } },
      { key: "deadline_upcoming", filter: { deadlineState: "upcoming" } },
      { key: "deadline_overdue", filter: { deadlineState: "overdue" } },
      { key: "flags", filter: { flag: "any" } },
      { key: "not_reachable", filter: { portal: "not_reachable" } },
    ],
    statuses: each(MainStatus.options, (status) => ({ status })),
    profilingStatuses: each(ProfilingStatus.options, (profilingStatus) => ({ profilingStatus })),
    dsvStatuses: taTg ? each(DsvStatus.options, (dsvStatus) => ({ dsvStatus })) : [],
    waves: taTg ? each([...project.waves.map((w) => w.id), "none"], (wave) => ({ wave })) : [],
    activation: each(ActivationFilter.options, (activation) => ({ activation })),
    notice: each(PrivacyNoticeState.shape.state.options, (notice) => ({ notice })),
    deadlines: DeadlineKind.options.flatMap((deadlineKind) =>
      DeadlineState.options.map((deadlineState) => ({
        key: `${deadlineKind}:${deadlineState}`,
        filter: { deadlineKind, deadlineState },
      })),
    ),
    flags: each(remainingFlags(LifecycleFlag.options), (flag) => ({ flag })),
    portal: each(PortalReach.options, (portal) => ({ portal })),
  };
}

/** The counts of the work list's items: exact, small values included (Q150). */
export function projectFunnel(
  items: readonly WorklistItem[],
  project: FunnelProject,
): ProjectDashboard["counts"] {
  const filters = funnelFilters(project);
  return Object.fromEntries(
    DashboardGroup.options.map((group) => [
      group,
      filters[group].map(({ key, filter }) => ({
        key,
        count: items.filter((item) => matchesWorklistFilter(item, filter)).length,
        filter,
      })),
    ]),
  ) as ProjectDashboard["counts"];
}
