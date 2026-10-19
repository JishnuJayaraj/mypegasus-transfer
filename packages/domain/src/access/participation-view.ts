import { ParticipantDataField } from "../fields/catalog";
import type { IsoDate } from "../iso-date";
import type { DsvStatus, MainStatus, ProfilingStatus } from "../lifecycle/enums";
import { assignEntryWave, type OperationContext } from "../lifecycle/operations";
import { effectiveTgEnd, effectiveTgStart, type EntryWave } from "../lifecycle/waves";
import type {
  AssignEntryWaveRefusal,
  ParticipantAddress,
  ParticipationDetail,
  ParticipationHint,
} from "../participations";
import { decideAccess, type AccessAction, type Subject } from "./decide";

// Who lists which participations of a project, and what the detail of one shows (Slice 2 plan,
// "Planned in PR 2h", R29, R30). Pure: the API loads the rows and applies the result.

/** The person fields a participant list carries (plan 5.12). */
const listedFields = ["personnelNumber", "lastName", "firstName"] as const;
/** The case data of a participation, all `case_internal` in the field catalog. */
const caseFields = [
  "status",
  "profilingStatus",
  "dsvStatus",
  "offerDeadline",
  "tgStart",
  "tgEnd",
  "tgEntryDate",
  "exitDate",
  "withdrawnOn",
  "profilingDoneOn",
] as const;

const allowed = (
  subject: Subject,
  projectId: string,
  participationId: string | null,
  field: string,
  action: AccessAction,
) =>
  decideAccess(
    subject,
    { kind: "field", projectId, regionId: null, participationId, phase: "active", field },
    action,
    { kind: "normal" },
  ).effect === "allow";

export type ParticipationListScope =
  | { kind: "all" }
  /** Only these participations (assignments may span projects; the caller filters by project). */
  | { kind: "assigned"; participationIds: readonly string[] }
  | { kind: "none" };

/**
 * `all` when the viewer may list person fields of a participation they aren't assigned to (the
 * PL, back office), `assigned` for exactly the assigned participations they may list (a
 * consultant), else `none` (a 403). Projects have no region before Slice 3.
 */
export function participationListScope(
  subject: Subject,
  projectId: string,
): ParticipationListScope {
  if (subject.kind !== "staff") return { kind: "none" };
  const mayList = (participationId: string | null) =>
    listedFields.some((field) => allowed(subject, projectId, participationId, field, "list"));
  if (mayList(null)) return { kind: "all" };
  const participationIds = [...subject.assignedParticipationIds].filter(mayList);
  return participationIds.length > 0 ? { kind: "assigned", participationIds } : { kind: "none" };
}

/** Whether the viewer may list one person field of one participation (the per-row decision). */
export const mayListField = (
  subject: Subject,
  projectId: string,
  participationId: string,
  field: (typeof listedFields)[number],
) => allowed(subject, projectId, participationId, field, "list");

/** One participation as the API loads it, before projection. */
export type ParticipationRecord = {
  id: string;
  projectId: string;
  status: MainStatus;
  profilingStatus: ProfilingStatus;
  dsvStatus: DsvStatus;
  statusVersion: number;
  wave: (EntryWave & { name: string }) | null;
  dates: Record<
    "tgStart" | "tgEnd" | "offerDeadline" | "tgEntryDate" | "exitDate" | "withdrawnOn",
    IsoDate | null
  > & { profilingDoneOn: IsoDate | null };
  person: Record<Exclude<ParticipantDataField, "address">, string | null> & {
    address: ParticipantAddress | null;
  };
};

/**
 * The detail of one participation for the viewer, or null when they may not read its case data
 * (a 403). Each person field is included where `decideAccess` allows `read`; nothing in Slice 2
 * needs a logged read, so the decision's audit is always null here (R30).
 */
export function participationDetail(
  subject: Subject,
  record: ParticipationRecord,
  options: {
    today: IsoDate;
    capabilities: ParticipationDetail["capabilities"];
    refusals: ParticipationDetail["refusals"];
  },
): ParticipationDetail | null {
  const readable = (field: string) => allowed(subject, record.projectId, record.id, field, "read");
  if (!caseFields.every(readable)) return null;
  const { wave, dates } = record;
  const effectiveStart = effectiveTgStart(dates, wave);
  const hints: ParticipationHint[] = [];
  if (record.status === "informed" && effectiveStart !== null && effectiveStart < options.today) {
    hints.push("tg_start_missed");
  }
  return {
    id: record.id,
    projectId: record.projectId,
    status: record.status,
    profilingStatus: record.profilingStatus,
    dsvStatus: record.dsvStatus,
    statusVersion: record.statusVersion,
    entryWave: wave,
    dates: {
      ...dates,
      effectiveTgStart: effectiveStart,
      effectiveTgEnd: effectiveTgEnd(dates, wave),
    },
    hints,
    person: Object.fromEntries(
      ParticipantDataField.options.filter(readable).map((field) => [field, record.person[field]]),
    ),
    capabilities: options.capabilities,
    refusals: options.refusals,
  };
}

/**
 * Whether the viewer may assign another wave now (R31, R33): the permission first, then
 * `assignEntryWave`'s rules in their order, against the project's other waves (they all share the
 * participation's state, so the first decides); none left is `no_other_wave`.
 */
export function entryWaveAssignment(
  context: OperationContext,
  projectId: string,
  waveIds: readonly string[],
  permitted: boolean,
): { allowed: boolean; refusal: AssignEntryWaveRefusal | null } {
  if (!permitted) return { allowed: false, refusal: "forbidden" };
  const others = waveIds.filter((id) => id !== context.wave?.id);
  // Without another wave, a stand-in that isn't the current one still runs the earlier rules.
  const result = assignEntryWave(context, { projectId, wave: { id: others[0] ?? "", projectId } });
  if (!result.ok) return { allowed: false, refusal: result.code as AssignEntryWaveRefusal };
  return others.length > 0
    ? { allowed: true, refusal: null }
    : { allowed: false, refusal: "no_other_wave" };
}
