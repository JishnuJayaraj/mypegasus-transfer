import type { WorklistFilter } from "@transfer/domain";
import type de from "../locales/de/translation.json";

// The work list's quick views (ui-patterns.md, the work list; the plan of Slice 6b, D6): each one
// existing `WorklistFilter` with its predicate unchanged, labelled by what it selects. A quick view
// and the dashboard tile with the same filter share one label key, so they can't drift.

export type QuickViewKey = keyof typeof de.worklist.views;
type TileLabelKey = keyof typeof de.dashboard.tiles;

/** The viewer's project roles, as far as the quick views depend on them. */
export type ViewerRoles = {
  staffUserId: string | undefined;
  projectLead: boolean;
  backOffice: boolean;
  consultant: boolean;
};

export type QuickView = { key: QuickViewKey; filter: WorklistFilter };

/**
 * The quick views the viewer gets, in their order: everyone gets "Alle" to "Hinweise"; "Termine zu
 * klären" only the PL (the only resolver, data-protection.md, appointments); "Ohne Beratung" the
 * PL and the back office; "Mir zugewiesen" a PL who is also a consultant of the project.
 */
export function quickViews(viewer: ViewerRoles): QuickView[] {
  return [
    { key: "all", filter: {} },
    { key: "overdue", filter: { deadlineState: "overdue" } },
    { key: "upcoming", filter: { deadlineState: "upcoming" } },
    { key: "actions", filter: { actions: "any" } },
    { key: "flags", filter: { flag: "any" } },
    ...(viewer.projectLead
      ? [{ key: "appointmentsToResolve", filter: { appointment: "to_resolve" } } as const]
      : []),
    ...(viewer.projectLead || viewer.backOffice
      ? [{ key: "noConsultant", filter: { consultant: "none" } } as const]
      : []),
    ...(viewer.projectLead && viewer.consultant && viewer.staffUserId
      ? [{ key: "mine", filter: { consultant: viewer.staffUserId } } as const]
      : []),
  ];
}

/**
 * The dashboard tiles that are a quick view: their label is the quick view's. "Teilnehmende"
 * (`{}`) keeps its own label: a count of all rows reads "142 Teilnehmende", the view "Alle".
 */
export const tileViews: Readonly<Record<string, QuickViewKey>> = {
  deadline_overdue: "overdue",
  deadline_upcoming: "upcoming",
  open_actions: "actions",
  flags: "flags",
  appointments_to_resolve: "appointmentsToResolve",
};

/** The label key of a dashboard tile: its quick view's when it has one. */
export function tileLabelKey(key: string) {
  const view = tileViews[key];
  return view
    ? (`worklist.views.${view}` as const)
    : (`dashboard.tiles.${key as TileLabelKey}` as const);
}

const keys = (f: WorklistFilter) => Object.keys(f).toSorted();

/** Two filters are the same set of conditions (key order aside). */
export function sameFilter(a: WorklistFilter, b: WorklistFilter): boolean {
  const [x, y] = [keys(a), keys(b)];
  return (
    x.length === y.length &&
    x.every(
      (key, i) => key === y[i] && a[key as keyof WorklistFilter] === b[key as keyof WorklistFilter],
    )
  );
}
