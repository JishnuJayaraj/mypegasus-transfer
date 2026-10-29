import { z } from "zod";
import { ActivationDeliveryKind } from "../activation/model";
import { ActivationStatus } from "../activation/status";
import { entryWaveAssignment } from "../access/participation-view";
import type { IsoDate } from "../iso-date";
import {
  DsvStatus,
  LifecycleFlag,
  MainStatus,
  ProfilingStatus,
  terminalMainStatuses,
} from "../lifecycle/enums";
import {
  lifecycleFlags,
  type ParticipationSnapshot,
  type PlannerProject,
} from "../lifecycle/planner";
import { PrivacyNoticeState } from "../privacy/notice-state";
import { AgenturKey } from "../projects/agentur-settings";
import { AssignedConsultant } from "../projects/team";
import { RemindCapability, WorklistReminder } from "../reminders/api";
import {
  chooseChannel,
  PortalReach,
  portalReach,
  reminderEligibility,
  type ReminderChannelFacts,
  type ReminderStatus,
} from "../reminders/model";
import { participantActions, ParticipantAction, type ActionFacts } from "./actions";
import {
  appointmentItems,
  WorklistAppointments,
  type AppointmentItemBooking,
  type AppointmentItemNotice,
} from "./appointments";
import { Deadline, deadlinesOf, remainingFlags } from "./deadlines";
import type { AsuDueDate } from "../dates";
import { kug200bItems, type Kug200bOfferFacts } from "../asu/kug200b";
import { isoDate } from "../iso-date";

// The work list (data-protection.md, the work list and the dashboard): one projection of a
// participation's facts for the list and the dashboard alike.

/** The PRD's 2,000 participations with headroom; a larger project gets no snapshot (a 422). */
export const worklistMaxRows = 5000;

export const WorklistCapabilities = z.strictObject({
  assignEntryWave: z.boolean(),
  issueActivationCode: z.boolean(),
  recordHandover: z.boolean(),
  revokeActivationCode: z.boolean(),
  providePrivacyNotice: z.boolean(),
  remind: RemindCapability,
  /**
   * "Zu Termin einladen" (data-protection.md, invitations): whether the viewer may invite the row
   * (`mayRemind`, an open participation) and the channel an invitation would go to now, `null`
   * when none is usable ("nicht zustellbar, im Portal sichtbar"). The appointment's rules follow
   * at the request.
   */
  invite: z.strictObject({ allowed: z.boolean(), channel: ActivationDeliveryKind.nullable() }),
  /**
   * "Kug 200b erzeugen" (data-protection.md, generated forms; Q179): the PL, for an open
   * participation of a `ta_tg` project; the generation's own checks follow.
   */
  generateKug200b: z.boolean(),
});

/**
 * Staff work on a row that isn't a dated deadline (process-and-lifecycle.md, deadline warnings):
 * `knowledge_date_missing` with the ASU reference date as a labelled orientation, never overdue
 * ("Kenntnisdatum klären"); `kug200b_offer_open` with the offer's date and
 * `kug200b_withdrawal_ba_notice` with the withdrawal's date of receipt (`kug200bItems`).
 */
export const WorklistCaseItem = z
  .strictObject({
    kind: z.enum(["knowledge_date_missing", "kug200b_offer_open", "kug200b_withdrawal_ba_notice"]),
    date: isoDate,
  })
  .meta({ id: "WorklistCaseItem" });
export type WorklistCaseItem = z.infer<typeof WorklistCaseItem>;

/**
 * One row of the work list: the list item's fields, the participant's actions, the deadlines,
 * the flags no deadline represents, the portal and what the viewer may do. Person fields only
 * where the viewer may list them.
 */
export const WorklistItem = z
  .strictObject({
    id: z.uuid(),
    status: MainStatus,
    profilingStatus: ProfilingStatus,
    dsvStatus: DsvStatus,
    entryWaveId: z.uuid().nullable(),
    placementAgenturKey: AgenturKey.nullable(),
    personnelNumber: z.string().optional(),
    lastName: z.string().optional(),
    firstName: z.string().optional(),
    consultants: z.array(AssignedConsultant),
    activationStatus: ActivationStatus,
    privacyNoticeState: PrivacyNoticeState,
    actions: z.array(ParticipantAction),
    deadlines: z.array(Deadline),
    caseItems: z.array(WorklistCaseItem),
    flags: z.array(LifecycleFlag),
    portal: PortalReach,
    /** The latest reminder requested for the participation, whatever its outcome. */
    reminder: WorklistReminder.nullable(),
    /** The next booking and the appointment items (staff work, never a participant action). */
    appointments: WorklistAppointments,
    capabilities: WorklistCapabilities,
  })
  .meta({ id: "WorklistItem" });
export type WorklistItem = z.infer<typeof WorklistItem>;

export const Worklist = z
  .strictObject({
    generatedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    items: z.array(WorklistItem),
  })
  .meta({ id: "Worklist" });
export type Worklist = z.infer<typeof Worklist>;

export type WorklistFacts = Pick<
  WorklistItem,
  | "id"
  | "entryWaveId"
  | "placementAgenturKey"
  | "consultants"
  | "activationStatus"
  | "privacyNoticeState"
> & {
  person: Record<"personnelNumber" | "lastName" | "firstName", string | null>;
  completeness: ActionFacts;
  channels: readonly ReminderChannelFacts[];
  lastReminder: { requestedOn: IsoDate; status: ReminderStatus } | null;
  /** The applicable ASU due date (`applicableAsuDueDate`), or null. */
  asuDueDate: AsuDueDate | null;
  /** The Kug 200b offer's facts (`kug200bItems`), beside the project type and status. */
  kug200b: Omit<Kug200bOfferFacts, "projectType" | "status">;
  appointments: {
    bookings: readonly AppointmentItemBooking[];
    notices: readonly AppointmentItemNotice[];
    /** When the participation became terminal; null while it isn't. */
    closedAt: string | null;
  };
};

export type WorklistProject = PlannerProject & { id: string };

/** What one viewer may do with one participation; the API builds it from `decideAccess`. */
export type WorklistViewer = {
  staffUserId: string;
  /** Whether a person field may be listed. */
  lists: (field: keyof WorklistFacts["person"]) => boolean;
  /** Whether a self-service field may be named (the "Selbstauskunft" tab's rule). */
  knows: (key: string) => boolean;
  /** The operation's permission; the domain's preconditions follow. */
  may: (
    operation: Exclude<keyof WorklistItem["capabilities"], "remind" | "invite" | "generateKug200b">,
  ) => boolean;
  /** `mayRemind` in an active project; the reminder rules follow. */
  remind: boolean;
  /** `mayGenerateKug200bBulk`: the PL. */
  generatesKug200b: boolean;
};

/**
 * One participation's row. A terminal participation asks nothing more of the participant: it has
 * no actions (the portal takes no upload, process-and-lifecycle.md, document review).
 */
export function worklistProjection(
  facts: WorklistFacts,
  snapshot: ParticipationSnapshot,
  project: WorklistProject,
  today: IsoDate,
  now: Date,
  viewer: WorklistViewer,
): WorklistItem {
  const { current } = snapshot;
  const person = Object.fromEntries(
    (["personnelNumber", "lastName", "firstName"] as const).flatMap((field) => {
      const value = facts.person[field];
      return value !== null && viewer.lists(field) ? [[field, value]] : [];
    }),
  );
  const wave = entryWaveAssignment(
    {
      projectType: project.type,
      current,
      actor: { type: "user", staffUserId: viewer.staffUserId },
      today,
      now,
      wave: snapshot.wave,
      participation: snapshot.participation,
    },
    project.id,
    project.waves.map((w) => w.id),
    viewer.may("assignEntryWave"),
  );
  const closed = terminalMainStatuses.has(current.status);
  const actions = closed ? [] : participantActions(facts.completeness, viewer.knows);
  const portal = portalReach(facts.channels);
  // A reminder asks for every action of the participant's own, whoever requests it.
  const eligibility = reminderEligibility(
    {
      status: current.status,
      actionCount: closed ? 0 : participantActions(facts.completeness, () => true).length,
      portal,
    },
    facts.lastReminder?.requestedOn ?? null,
    today,
  );
  const remind = !viewer.remind
    ? { allowed: false, code: null, channel: null }
    : eligibility === "ok"
      ? { allowed: true, code: null, channel: chooseChannel(facts.channels)!.kind }
      : { allowed: false, code: eligibility, channel: null };
  return {
    id: facts.id,
    ...current,
    entryWaveId: facts.entryWaveId,
    placementAgenturKey: facts.placementAgenturKey,
    ...person,
    consultants: facts.consultants,
    activationStatus: facts.activationStatus,
    privacyNoticeState: facts.privacyNoticeState,
    actions,
    deadlines: deadlinesOf(
      { snapshot, project, privacyNotice: facts.privacyNoticeState, asuDueDate: facts.asuDueDate },
      today,
    ),
    caseItems: [
      ...(facts.asuDueDate?.kind === "orientation"
        ? [{ kind: "knowledge_date_missing" as const, date: facts.asuDueDate.date }]
        : []),
      ...kug200bItems({ ...facts.kug200b, projectType: project.type, status: current.status }),
    ],
    flags: remainingFlags(lifecycleFlags(snapshot, project, today)),
    portal,
    reminder: facts.lastReminder
      ? { lastRequestedOn: facts.lastReminder.requestedOn, status: facts.lastReminder.status }
      : null,
    appointments: appointmentItems(
      facts.appointments.bookings,
      facts.appointments.notices,
      current.status,
      facts.appointments.closedAt,
      now.toISOString(),
      today,
    ),
    capabilities: {
      assignEntryWave: wave.allowed,
      issueActivationCode: viewer.may("issueActivationCode"),
      recordHandover: viewer.may("recordHandover"),
      revokeActivationCode: viewer.may("revokeActivationCode"),
      providePrivacyNotice: viewer.may("providePrivacyNotice"),
      remind,
      invite: {
        allowed: viewer.remind && !closed,
        channel: viewer.remind ? (chooseChannel(facts.channels)?.kind ?? null) : null,
      },
      generateKug200b: viewer.generatesKug200b && project.type === "ta_tg" && !closed,
    },
  };
}
