import type { ProjectType } from "../project";
import type {
  ActorType,
  DsvStatus,
  MainStatus,
  ProfilingStatus,
  TgEntryKind,
  Track,
} from "./enums";
import type { GuardId } from "./guards";

/**
 * How a transition happens: the TG entry kinds, a manual or system step, or the participant's own
 * activation (Slice 3 plan D25), which only `complete_activation` takes.
 */
export type EdgeKind = TgEntryKind | "manual" | "system" | "activation";

/** The `edge_kind` values, in the database's order. */
export const edgeKinds = [
  "scheduled_entry",
  "scheduled_entry_catchup",
  "reconciliation",
  "manual",
  "system",
  "activation",
] as const satisfies readonly EdgeKind[];

/**
 * One allowed transition for one actor type (plan 5.3). `from: null` is creation. Everything
 * not listed is `no_edge`. Which staff roles may take an edge is `mayPerformTransition` (PR 1d).
 */
export type Edge = {
  track: Track;
  from: MainStatus | ProfilingStatus | DsvStatus | null;
  to: MainStatus | ProfilingStatus | DsvStatus;
  actor: ActorType;
  kind: EdgeKind;
  guards: readonly GuardId[];
  /** Only in these project types; all when absent. */
  projectTypes?: readonly ProjectType[];
};

type Row = [Edge["from"], Edge["to"], ActorType, EdgeKind, GuardId[]?, ProjectType[]?];

const rows = (track: Track, list: Row[]): Edge[] =>
  list.map(([from, to, actor, kind, guards = [], projectTypes]) => ({
    track,
    from,
    to,
    actor,
    kind,
    guards,
    ...(projectTypes && { projectTypes }),
  }));

const tgEntry: GuardId[] = [
  "dsv_fully_executed",
  "asu_registered_with_proof",
  "profiling_done_or_approved_exception",
  "tg_start_date",
];
const withdrawal: GuardId[] = ["withdrawal_after_dsv_signed"];
const reOffer: GuardId[] = ["before_cutoff", "offer_deadline_valid"];

export const edges: readonly Edge[] = [
  ...rows("main", [
    [null, "imported", "user", "manual"],
    ["imported", "contacted", "user", "manual"],
    ["contacted", "informed", "user", "manual"],
    ["contacted", "unreachable", "user", "manual"],
    ["unreachable", "contacted", "user", "manual", ["before_cutoff"]],
    // A first activation before the cutoff (Q116, Q121); `contacted` itself stays as it is.
    ["imported", "contacted", "participant", "activation", ["before_cutoff"]],
    ["unreachable", "contacted", "participant", "activation", ["before_cutoff"]],
    ["informed", "active_in_tg", "system", "scheduled_entry", tgEntry, ["ta_tg"]],
    ["informed", "active_in_tg", "system", "scheduled_entry_catchup", tgEntry, ["ta_tg"]],
    ["informed", "active_in_tg", "user", "reconciliation", tgEntry, ["ta_tg"]],
    ["informed", "ta_completed", "user", "manual", ["ta_completion"], ["ta_only"]],
    ["active_in_tg", "exited", "user", "manual"],
    ...(["imported", "contacted", "unreachable", "informed"] as const).flatMap((from): Row[] => [
      [from, "withdrawn", "user", "manual", withdrawal],
      [from, "withdrawn", "system", "system", withdrawal],
    ]),
  ]),
  ...rows("profiling", [
    ["not_started", "profiling_accepted", "user", "manual"],
    ["not_started", "profiling_declined", "user", "manual"],
    ["profiling_accepted", "profiling_in_progress", "user", "manual"],
    ["profiling_accepted", "profiling_declined", "user", "manual"],
    ["profiling_in_progress", "profiling_done", "user", "manual", ["tl407_signed"]],
    ["profiling_in_progress", "profiling_declined", "user", "manual"],
    ["profiling_declined", "profiling_accepted", "user", "manual", ["before_cutoff"]],
  ]),
  ...rows("dsv", [
    [
      "not_offered",
      "dsv_offered",
      "user",
      "manual",
      ["entry_wave_assigned", "dsv_generated", "offer_deadline_valid"],
    ],
    ["dsv_offered", "dsv_signed", "user", "manual", ["dsv_scan_received"]],
    ["dsv_offered", "dsv_declined", "user", "manual"],
    ["dsv_offered", "dsv_expired", "system", "system"],
    ["dsv_declined", "dsv_offered", "user", "manual", reOffer],
    ["dsv_expired", "dsv_offered", "user", "manual", reOffer],
  ]),
];
