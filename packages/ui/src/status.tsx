import { Tag } from "@carbon/react";
import {
  CheckmarkFilled,
  CircleDash,
  ErrorFilled,
  InProgress,
  WarningAltFilled,
} from "@carbon/icons-react";
import type {
  AppointmentStatus,
  DeadlineState,
  DsvStatus,
  LifecycleFlag,
  MainStatus,
  ProfilingStatus,
  ProjectStatus,
} from "@transfer/domain";
import { useTranslation } from "react-i18next";

/**
 * The one visual language for status (ui-patterns.md, principle 4): red = overdue/blocked,
 * yellow = due soon/needs confirmation, green = done, blue = in progress/info, gray =
 * inactive/terminal. The text and the icon carry the meaning, never the colour alone (WCAG 1.4.1).
 */
export type StatusTone = "danger" | "warning" | "success" | "info" | "neutral";

/** Each family's codes come from the domain; a new code fails the typecheck until it is mapped. */
interface StatusCodes {
  main: MainStatus;
  profiling: ProfilingStatus;
  dsv: DsvStatus;
  deadline: DeadlineState;
  flag: LifecycleFlag;
  appointment: AppointmentStatus;
  project: ProjectStatus;
}
export type StatusFamily = keyof StatusCodes;

const tones: { [F in StatusFamily]: Record<StatusCodes[F], StatusTone> } = {
  main: {
    imported: "info",
    contacted: "info",
    unreachable: "warning",
    informed: "info",
    active_in_tg: "info",
    withdrawn: "neutral",
    ta_completed: "success",
    exited: "neutral",
  },
  profiling: {
    not_started: "neutral",
    profiling_accepted: "info",
    profiling_in_progress: "info",
    profiling_done: "success",
    profiling_declined: "neutral",
  },
  dsv: {
    not_offered: "neutral",
    dsv_offered: "info",
    dsv_signed: "success",
    dsv_declined: "neutral",
    dsv_expired: "neutral",
  },
  deadline: { upcoming: "warning", overdue: "danger" },
  flag: {
    tg_start_missed: "danger",
    cutoff_warning: "warning",
    cutoff_final_reminder: "danger",
    conflict_dsv_signed_profiling_declined: "danger",
    dsv_never_offered: "warning",
    informed_without_wave_at_cutoff: "warning",
    profiling_exception_deadline_missed: "danger",
    profiling_declined_after_entry: "warning",
  },
  appointment: { scheduled: "info", cancelled: "neutral" },
  // A draft project is not running yet; an active one is in progress.
  project: { draft: "neutral", active: "info" },
};

/**
 * Where each family's labels are: the app catalog's existing keys (the same texts as the filters),
 * so a tag and its filter can't drift.
 */
const labelPrefix: Record<StatusFamily, string> = {
  main: "participants.statuses",
  profiling: "participants.profilingStatuses",
  dsv: "participants.dsvStatuses",
  deadline: "worklist.deadlineStates",
  flag: "worklist.flags",
  appointment: "appointments.statuses",
  project: "projects.statuses",
};

const toneTag = {
  danger: { type: "red", icon: ErrorFilled },
  warning: { type: "warm-gray", icon: WarningAltFilled },
  success: { type: "green", icon: CheckmarkFilled },
  info: { type: "blue", icon: InProgress },
  neutral: { type: "gray", icon: CircleDash },
} as const;

/** Each tone's icon, for a tag or a tile (ui-patterns.md, principle 4). */
export const toneIcon = Object.fromEntries(
  Object.entries(toneTag).map(([tone, { icon }]) => [tone, icon]),
) as { [T in StatusTone]: (typeof toneTag)[T]["icon"] };

/** A code's tone, Carbon tag type, icon and label key (the one map; tests cover every code). */
export function statusTag<F extends StatusFamily>(
  family: F,
  code: StatusCodes[F],
): { tone: StatusTone; labelKey: string } & (typeof toneTag)[StatusTone] {
  const tone: StatusTone = tones[family][code];
  return { tone, ...toneTag[tone], labelKey: `${labelPrefix[family]}.${code}` };
}

/** Every family's codes, for the catalog test and the pattern docs. */
export const statusCodes = Object.fromEntries(
  Object.entries(tones).map(([family, codes]) => [family, Object.keys(codes)]),
) as { [F in StatusFamily]: StatusCodes[F][] };

/**
 * A status, track, deadline or flag as a tag with its icon and text. `prefix` names the track where
 * a code alone is ambiguous ("Profiling: Angenommen" beside "DSV: Angeboten", C3).
 */
export function StatusTag<F extends StatusFamily>({
  family,
  code,
  prefix,
}: {
  family: F;
  code: StatusCodes[F];
  prefix?: string;
}) {
  const { t } = useTranslation();
  const { tone, type, icon: Icon, labelKey } = statusTag(family, code);
  const label = String(t(labelKey as never));
  // Carbon draws no icon in a small tag, so the icon is part of the content.
  return (
    <Tag type={type} size="sm" className={`tp-status-tag tp-status-tag--${tone}`} data-tone={tone}>
      <Icon size={12} aria-hidden="true" className="tp-status-tag-icon" />
      {prefix ? `${prefix}: ${label}` : label}
    </Tag>
  );
}
