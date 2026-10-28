import { z } from "zod";
import { AssignedConsultant, assignmentLimit } from "./projects/team";
import { page } from "./api";
import { isoDate } from "./iso-date";
import {
  AmendmentOriginalLocation,
  BaReportingKind,
  BaReportingStatus,
  DatesPrecondition,
  DsvAmendmentKind,
} from "./projects/participation-dates";
import { DsvStatus, MainStatus, ProfilingStatus } from "./lifecycle/enums";
import { ActivationStatus } from "./activation/status";
import { PrivacyNoticeState } from "./privacy/notice-state";
import { AgenturKey } from "./projects/agentur-settings";
import { ConfigBlocker } from "./projects/pins";
import { PlacementAgenturChoice } from "./projects/placement-agentur";

const activationCapabilities = z.strictObject({
  issueActivationCode: z.boolean(),
  recordHandover: z.boolean(),
  revokeActivationCode: z.boolean(),
  providePrivacyNotice: z.boolean(),
});

/**
 * A participation in the project's list (data-protection.md, access matrix). Only fields the viewer
 * may `list` (decideAccess, the field catalog's `listable`) carry a value; the person fields are
 * absent for a viewer who may not list them. Paged by `(created_at, id)`, never by a name or a
 * Personalnummer.
 */
export const ParticipationListItem = z
  .strictObject({
    id: z.uuid(),
    status: MainStatus,
    profilingStatus: ProfilingStatus,
    dsvStatus: DsvStatus,
    entryWaveId: z.uuid().nullable(),
    /** The Agentur the participant is placed with (Q139); `null` until it is set. */
    placementAgenturKey: AgenturKey.nullable(),
    personnelNumber: z.string().optional(),
    lastName: z.string().optional(),
    firstName: z.string().optional(),
    /** The consultants it is assigned to (Q62), by name. */
    consultants: z.array(AssignedConsultant),
    activationStatus: ActivationStatus,
    privacyNoticeState: PrivacyNoticeState,
    activationCapabilities,
  })
  .meta({ id: "ParticipationListItem" });
export type ParticipationListItem = z.infer<typeof ParticipationListItem>;

export const ParticipationPage = page(ParticipationListItem).meta({ id: "ParticipationPage" });

/**
 * Hints derived for the detail, never stored (process-and-lifecycle.md; like the planner's flags).
 * `placement_agentur_check`: the participant wrote an address after the placement Agentur was
 * chosen (regional-variation.md, "Placement Agentur"; Q139).
 */
export const ParticipationHint = z.enum([
  "tg_start_missed",
  "new_start_needs_ba_review",
  "placement_agentur_check",
]);
export type ParticipationHint = z.infer<typeof ParticipationHint>;

/** Street with house number, postal code, city and country: one unit (round 32). */
export const ParticipantAddress = z
  .strictObject({
    street: z.string(),
    postalCode: z.string(),
    city: z.string(),
    country: z.string(),
  })
  .meta({ id: "ParticipantAddress" });
export type ParticipantAddress = z.infer<typeof ParticipantAddress>;

/**
 * Why the wave choice is closed: no permission, the first failing rule of
 * `assignEntryWave` in its order, or no other wave of the project to choose.
 */
export const AssignEntryWaveRefusal = z.enum([
  "forbidden",
  "not_ta_tg",
  "status_not_open",
  "dsv_already_offered",
  "individual_dates_set",
  "no_other_wave",
]);
export type AssignEntryWaveRefusal = z.infer<typeof AssignEntryWaveRefusal>;

/** Why the dates can't be changed now: no permission, else the first failing precondition. */
export const SetParticipationDatesRefusal = z.enum(["forbidden", ...DatesPrecondition.options]);
export type SetParticipationDatesRefusal = z.infer<typeof SetParticipationDatesRefusal>;

/**
 * A DSV amendment as the detail shows it (process-and-lifecycle.md): dates, codes and the
 * confirming staff id.
 */
export const DsvAmendmentView = z
  .strictObject({
    id: z.uuid(),
    kind: DsvAmendmentKind,
    fullyExecutedOn: isoDate,
    oldTgStart: isoDate.nullable(),
    newTgStart: isoDate.nullable(),
    oldTgEnd: isoDate.nullable(),
    newTgEnd: isoDate.nullable(),
    confirmedBy: z.uuid(),
    confirmedAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    originalLocation: AmendmentOriginalLocation,
    documentReference: z.string().nullable(),
  })
  .meta({ id: "DsvAmendment" });
export type DsvAmendmentView = z.infer<typeof DsvAmendmentView>;

/** A BA reporting task as the detail shows it (process-and-lifecycle.md, "BA reporting"). */
export const BaReportingTaskView = z
  .strictObject({
    id: z.uuid(),
    reportingKind: BaReportingKind,
    subjectDate: isoDate,
    status: BaReportingStatus,
    createdAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    reportedOn: isoDate.nullable(),
  })
  .meta({ id: "BaReportingTask" });
export type BaReportingTaskView = z.infer<typeof BaReportingTaskView>;

const recorded = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

/**
 * One participation for its detail page (data-protection.md, "Participation detail"). The
 * case data (statuses, wave, dates) is shown only to a viewer who may read all of it; each person
 * field is absent where the viewer may not read it and `null` where nothing is recorded. The
 * capabilities are derived by the server; the routes decide again.
 */
export const ParticipationDetail = z
  .strictObject({
    id: z.uuid(),
    projectId: z.uuid(),
    status: MainStatus,
    profilingStatus: ProfilingStatus,
    dsvStatus: DsvStatus,
    /** The version a status-dependent write compares (compare-and-set). */
    statusVersion: z.int().min(0),
    entryWave: z
      .strictObject({
        id: z.uuid(),
        code: z.string(),
        name: z.string(),
        signingDeadline: isoDate.nullable(),
        defaultTgStart: isoDate.nullable(),
        defaultTgEnd: isoDate.nullable(),
        latestEntryDate: isoDate.nullable(),
      })
      .nullable(),
    dates: z.strictObject({
      /** The participation's own contractual dates; `null` means the wave's applies. */
      tgStart: isoDate.nullable(),
      tgEnd: isoDate.nullable(),
      effectiveTgStart: isoDate.nullable(),
      effectiveTgEnd: isoDate.nullable(),
      offerDeadline: isoDate.nullable(),
      tgEntryDate: isoDate.nullable(),
      exitDate: isoDate.nullable(),
      withdrawnOn: isoDate.nullable(),
      profilingDoneOn: isoDate.nullable(),
    }),
    hints: z.array(ParticipationHint),
    /**
     * The Agentur the participant is placed with (Q139), and when it was set; `null` until then.
     */
    placementAgenturKey: AgenturKey.nullable(),
    placementAgenturSetAt: z.iso
      .datetime()
      .nullable()
      .meta({ description: "UTC timestamp (ISO 8601)" }),
    /**
     * The participant-level blockers of this participation's chain: base, the placement Agentur's
     * pinned template, the override (Q76, Q91, Q92). Without a template the Agentur submission
     * stays blocked; collecting data does not.
     */
    submissionBlockers: z.array(ConfigBlocker),
    /**
     * The Agenturen offered for `setPlacementAgentur` (empty without it); a free key is possible
     * too.
     */
    placementAgenturChoices: z.array(PlacementAgenturChoice),
    person: z.strictObject({
      personnelNumber: recorded(z.string()),
      lastName: recorded(z.string()),
      firstName: recorded(z.string()),
      birthDate: recorded(isoDate),
      oldEmploymentEndDate: recorded(isoDate),
      address: recorded(ParticipantAddress),
      phone: recorded(z.string()),
      mobile: recorded(z.string()),
      privateEmail: recorded(z.string()),
      workEmail: recorded(z.string()),
    }),
    /** Absent where the viewer may not read them; newest last. */
    amendments: z.array(DsvAmendmentView).optional(),
    baReportingTasks: z.array(BaReportingTaskView).optional(),
    /** The consultants it is assigned to (Q62), oldest assignment first. */
    assignments: z.array(AssignedConsultant),
    activationStatus: ActivationStatus,
    privacyNoticeState: PrivacyNoticeState,
    capabilities: z.strictObject({
      assignEntryWave: z.boolean(),
      setParticipationDates: z.boolean(),
      /** Assign and unassign consultants (the PL). */
      assignParticipations: z.boolean(),
      issueActivationCode: z.boolean(),
      recordHandover: z.boolean(),
      revokeActivationCode: z.boolean(),
      providePrivacyNotice: z.boolean(),
      /** Set the placement Agentur (the PL or back office, while not terminal, Q139). */
      setPlacementAgentur: z.boolean(),
      /**
       * Open the wizard in assisted mode (the PL, the assigned consultant, back office; while not
       * terminal, Q136).
       */
      startAssistedMode: z.boolean(),
      /** The tab "Profiling" (the PL, the assigned consultant; data-protection.md, Q49). */
      viewProfiling: z.boolean(),
      /** The tab "Arbeitsuche" (whoever reads the case data, in a `ta_tg` project; Q89). */
      viewAsu: z.boolean(),
    }),
    /** Why a capability is closed: the missing permission first, then the domain's first rule. */
    refusals: z.strictObject({
      assignEntryWave: AssignEntryWaveRefusal.nullable(),
      setParticipationDates: SetParticipationDatesRefusal.nullable(),
    }),
  })
  .meta({ id: "ParticipationDetail" });
export type ParticipationDetail = z.infer<typeof ParticipationDetail>;

/** `PUT /participations/{id}/entry-wave` (process-and-lifecycle.md, assigning a wave). */
export const AssignEntryWaveInput = z
  .strictObject({ waveId: z.uuid() })
  .meta({ id: "AssignEntryWaveInput" });
export type AssignEntryWaveInput = z.infer<typeof AssignEntryWaveInput>;

/**
 * `POST /projects/{id}/entry-wave-assignments`: one wave for 1–500 distinct participations, all
 * or nothing (process-and-lifecycle.md, assigning a wave).
 */
export const EntryWaveAssignmentsInput = z
  .strictObject({
    waveId: z.uuid(),
    participationIds: z.array(z.uuid()).min(1).max(assignmentLimit),
  })
  .refine(({ participationIds }) => new Set(participationIds).size === participationIds.length, {
    message: "A participation is named twice",
    path: ["participationIds"],
    params: { code: "duplicate_participation" },
  })
  .meta({ id: "EntryWaveAssignmentsInput" });
export type EntryWaveAssignmentsInput = z.infer<typeof EntryWaveAssignmentsInput>;

/** The participations moved to the wave, and those already in it. */
export const EntryWaveAssignmentsResult = z
  .strictObject({ assigned: z.int().min(0), unchanged: z.int().min(0) })
  .meta({ id: "EntryWaveAssignmentsResult" });
export type EntryWaveAssignmentsResult = z.infer<typeof EntryWaveAssignmentsResult>;

export const ParticipationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  /** A code state, or `activated` for an activated account (its code state is then `none`). */
  activation: z
    .enum([
      "activated",
      "none",
      "printed",
      "open",
      "delivery_unknown",
      "expired",
      "locked",
      "revoked",
      "used",
    ])
    .optional(),
  privacyNotice: z.enum(["provided", "due", "overdue"]).optional(),
});
