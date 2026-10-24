import { z } from "zod";
import { ActivationCodeState } from "../activation/status";
import { DsvStatus, LifecycleFlag, MainStatus, ProfilingStatus } from "../lifecycle/enums";
import { PrivacyNoticeState } from "../privacy/notice-state";
import { AppointmentFilter, matchesAppointmentFilter } from "./appointments";
import { DeadlineKind, DeadlineState } from "./deadlines";
import { PortalReach } from "../reminders/model";
import type { WorklistItem } from "./projection";

/** An activated account, else the state of the latest code (like the paged list's filter). */
export const ActivationFilter = z.enum(["activated", ...ActivationCodeState.options]);
export type ActivationFilter = z.infer<typeof ActivationFilter>;

export const ActionsFilter = z.enum(["any", "fields", "documents", "rejected_documents", "none"]);
export type ActionsFilter = z.infer<typeof ActionsFilter>;

const idOrNone = z.union([z.uuid(), z.literal("none")]);

/**
 * The work list's filters: codes and ids only, never a person's value, so they may sit in a URL.
 * Every condition set must hold; the dashboard's counts are defined by them (`funnelFilters`).
 */
export const WorklistFilter = z
  .strictObject({
    status: MainStatus.optional(),
    profilingStatus: ProfilingStatus.optional(),
    dsvStatus: DsvStatus.optional(),
    wave: idOrNone.optional(),
    consultant: idOrNone.optional(),
    activation: ActivationFilter.optional(),
    notice: PrivacyNoticeState.shape.state.optional(),
    actions: ActionsFilter.optional(),
    deadlineKind: DeadlineKind.optional(),
    deadlineState: DeadlineState.optional(),
    /** One flag, or `any` flag. */
    flag: z.union([LifecycleFlag, z.literal("any")]).optional(),
    portal: PortalReach.optional(),
    appointment: AppointmentFilter.optional(),
  })
  .meta({ id: "WorklistFilter" });
export type WorklistFilter = z.infer<typeof WorklistFilter>;

export const activationOf = (item: Pick<WorklistItem, "activationStatus">): ActivationFilter =>
  item.activationStatus.account === "activated" ? "activated" : item.activationStatus.code;

function matchesActions(item: WorklistItem, filter: ActionsFilter): boolean {
  const { actions } = item;
  switch (filter) {
    case "any":
      return actions.length > 0;
    case "none":
      return actions.length === 0;
    case "fields":
      return actions.some((action) => action.kind === "field");
    case "documents":
      return actions.some((action) => action.kind === "document");
    case "rejected_documents":
      return actions.some((action) => action.state === "rejected");
  }
}

/**
 * Whether the item meets every condition of the filter. A deadline kind and state match one
 * deadline with both when both are set.
 */
export function matchesWorklistFilter(item: WorklistItem, filter: WorklistFilter): boolean {
  const { wave, consultant, deadlineKind, deadlineState, flag } = filter;
  const deadline =
    deadlineKind === undefined && deadlineState === undefined
      ? true
      : item.deadlines.some(
          (d) =>
            (deadlineKind === undefined || d.kind === deadlineKind) &&
            (deadlineState === undefined || d.state === deadlineState),
        );
  return (
    deadline &&
    (filter.status === undefined || item.status === filter.status) &&
    (filter.profilingStatus === undefined || item.profilingStatus === filter.profilingStatus) &&
    (filter.dsvStatus === undefined || item.dsvStatus === filter.dsvStatus) &&
    (wave === undefined || item.entryWaveId === (wave === "none" ? null : wave)) &&
    (consultant === undefined ||
      (consultant === "none"
        ? item.consultants.length === 0
        : item.consultants.some((c) => c.staffUserId === consultant))) &&
    (filter.activation === undefined || activationOf(item) === filter.activation) &&
    (filter.notice === undefined || item.privacyNoticeState.state === filter.notice) &&
    (filter.actions === undefined || matchesActions(item, filter.actions)) &&
    (flag === undefined || (flag === "any" ? item.flags.length > 0 : item.flags.includes(flag))) &&
    (filter.portal === undefined || item.portal === filter.portal) &&
    (filter.appointment === undefined ||
      matchesAppointmentFilter(item.appointments, filter.appointment))
  );
}
