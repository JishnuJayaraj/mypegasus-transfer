import { z } from "zod";
import {
  AgenturSettingSource,
  type AsuChannel,
  Kug200bBatchChannel,
  type RegionalSettings,
} from "../projects/agentur-settings";
import { isoDate } from "../iso-date";

// Kug 200b batches (process-and-lifecycle.md, Kug 200b batches; regional-variation.md, the
// accepted alternative; Q91, Q187, Q203). Pure: the database functions enforce the same rules under
// the project's exclusive lock; the API shows them (the ready scans, a stale batch's rows).

/** A batch holds 1–200 members, all or nothing (data-protection.md, exports). */
export const kug200bBatchMax = 200;

/**
 * What goes to the Agentur with the scans: the official Kug 200a, or the alternative list the
 * Agentur accepted. The operational index (the work list) is never the artifact.
 */
export const Kug200bBatchArtifact = z
  .enum(["kug200a", "accepted_alternative"])
  .meta({ id: "Kug200bBatchArtifact" });
export type Kug200bBatchArtifact = z.infer<typeof Kug200bBatchArtifact>;

export const Kug200bBatchStatus = z
  .enum(["open", "submitted", "discarded"])
  .meta({ id: "Kug200bBatchStatus" });
export type Kug200bBatchStatus = z.infer<typeof Kug200bBatchStatus>;

/**
 * Why a scan can't join a batch, or a member makes its batch stale. `in_open_batch` and
 * `already_submitted` only when a batch is built.
 */
export const BatchMemberProblem = z.enum([
  "scan_unusable",
  "participation_closed",
  "placement_agentur_changed",
  "in_open_batch",
  "already_submitted",
  "asu_route_unset",
  "asu_registered",
  "asu_route_changed",
  "form_version_outdated",
]);
export type BatchMemberProblem = z.infer<typeof BatchMemberProblem>;

/** A stale batch's row: a member and its problem, or the batch itself (`settings_changed`). */
export const BatchStaleRow = z
  .strictObject({
    participationId: z.uuid().nullable(),
    documentId: z.uuid().nullable(),
    reason: z.enum([...BatchMemberProblem.options, "settings_changed"]),
  })
  .meta({ id: "Kug200bBatchStaleRow" });
export type BatchStaleRow = z.infer<typeof BatchStaleRow>;

/** A participation's facts for one scan, as read now. */
export type BatchMemberFacts = {
  /** Live, accepted, neither quarantined nor invalidated, with its form version. */
  scanUsable: boolean;
  /** `withdrawn`, `ta_completed` or `exited`. */
  closed: boolean;
  placementAgenturKey: string | null;
  asuChannel: AsuChannel | null;
  /** An ASU registration exists. */
  asuRegistered: boolean;
  formVersion: string | null;
  /** A member of an open batch. */
  inOpenBatch: boolean;
  /** Its Kug 200b was submitted to an Agentur. */
  submitted: boolean;
};

type Scope = { agenturKey: string; outdatedVersions: readonly string[] };

/** The problems both checks share, in a fixed order; null when none. */
function memberProblem(facts: BatchMemberFacts, { agenturKey }: Scope): BatchMemberProblem | null {
  if (!facts.scanUsable || facts.formVersion === null) return "scan_unusable";
  if (facts.closed) return "participation_closed";
  if (facts.placementAgenturKey !== agenturKey) return "placement_agentur_changed";
  return null;
}

/** On the route `kug_200b` the submission is the registration, so none may exist yet (D19). */
const registered = (facts: BatchMemberFacts) =>
  facts.asuChannel === "kug_200b" && facts.asuRegistered;

/** A version expired in the registry, where the Agentur rejects outdated forms (D26). */
const outdated = (facts: BatchMemberFacts, { outdatedVersions }: Scope) =>
  facts.formVersion !== null && outdatedVersions.includes(facts.formVersion);

/**
 * Whether a scan may join a new batch of the Agentur (D25): a usable Kug 200b scan of an open
 * participation placed with that Agentur, in no open batch, not submitted before and on an
 * explicitly chosen ASU route (`asu_route_unset` otherwise: the route is set on "Arbeitsuche"
 * first, Q203).
 */
export function batchEligibility(facts: BatchMemberFacts, scope: Scope): BatchMemberProblem | null {
  const problem = memberProblem(facts, scope);
  if (problem) return problem;
  if (facts.inOpenBatch) return "in_open_batch";
  if (facts.submitted) return "already_submitted";
  // The route decides whether the submission is the registration: chosen first, never assumed.
  if (facts.asuChannel === null) return "asu_route_unset";
  if (registered(facts)) return "asu_registered";
  if (outdated(facts, scope)) return "form_version_outdated";
  return null;
}

type BatchSnapshot = {
  agenturKey: string;
  channel: z.infer<typeof Kug200bBatchChannel>;
  artifact: Kug200bBatchArtifact;
  members: readonly {
    participationId: string;
    documentId: string;
    asuChannel: AsuChannel | null;
  }[];
};

/**
 * The recheck before an export and before "Übermittelt am" (D25): the channel and the artifact
 * still resolve as when the batch was built, and each member is still usable, open, placed with the
 * batch's Agentur and on the route it had. Any row refuses (`batch_stale`); the PL discards and
 * rebuilds. A member without facts (gone from the viewer) counts as an unusable scan.
 */
export function batchRecheck(
  batch: BatchSnapshot,
  now: ReadonlyMap<string, BatchMemberFacts>,
  current: { channel: z.infer<typeof Kug200bBatchChannel> | null; artifact: Kug200bBatchArtifact },
  outdatedVersions: readonly string[],
): BatchStaleRow[] {
  if (current.channel !== batch.channel || current.artifact !== batch.artifact) {
    return [{ participationId: null, documentId: null, reason: "settings_changed" }];
  }
  const scope = { agenturKey: batch.agenturKey, outdatedVersions };
  return batch.members.flatMap((member): BatchStaleRow[] => {
    const facts = now.get(member.participationId);
    const reason = !facts
      ? "scan_unusable"
      : (memberProblem(facts, scope) ??
        (facts.asuChannel !== member.asuChannel
          ? "asu_route_changed"
          : registered(facts)
            ? "asu_registered"
            : outdated(facts, scope)
              ? "form_version_outdated"
              : null));
    return reason
      ? [{ participationId: member.participationId, documentId: member.documentId, reason }]
      : [];
  });
}

/** The batch's artifact as the tab shows it: the alternative with its confirmation. */
export const Kug200bArtifactView = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("kug200a") }),
    z.strictObject({
      kind: z.literal("accepted_alternative"),
      source: AgenturSettingSource,
      confirmedBy: z.uuid(),
      confirmedOn: isoDate,
    }),
  ])
  .meta({ id: "Kug200bArtifact" });
export type Kug200bArtifactView = z.infer<typeof Kug200bArtifactView>;

/** Where the resolved `kug200aAlternativeAccepted` came from (the resolver's provenance). */
type SettingRef =
  | { layer: string; source?: AgenturSettingSource; confirmedBy?: string; confirmedOn?: string }
  | undefined;

/**
 * A placement Agentur's batch settings (regional-variation.md, the accepted alternative; Q91):
 * the resolved `batchSubmissionChannel` (null: the step blocker, no batch) and the artifact. The
 * alternative counts only as an Agentur-scoped setting with its source, confirmer and date;
 * anywhere else the Kug 200a stays the artifact.
 */
export function batchSettings(
  settings: RegionalSettings,
  alternativeRef: SettingRef,
): { channel: z.infer<typeof Kug200bBatchChannel> | null; artifact: Kug200bArtifactView } {
  const asu = settings.asu_registration;
  const channel = asu?.batchSubmissionChannel ?? null;
  const { layer, source, confirmedBy, confirmedOn } = alternativeRef ?? { layer: "" };
  if (
    asu?.kug200aAlternativeAccepted === true &&
    layer.startsWith("override:agentur:") &&
    source &&
    confirmedBy &&
    confirmedOn
  ) {
    return {
      channel,
      artifact: { kind: "accepted_alternative", source, confirmedBy, confirmedOn },
    };
  }
  return { channel, artifact: { kind: "kug200a" } };
}

/** "Übermittelt am": the actual sent date, from the batch's (Berlin) day to today (D25). */
export function submissionProblem(
  submittedOn: string,
  { createdOn, today }: { createdOn: string; today: string },
): "submitted_on_in_future" | "submitted_before_batch" | null {
  if (submittedOn > today) return "submitted_on_in_future";
  if (submittedOn < createdOn) return "submitted_before_batch";
  return null;
}

/** "Bestätigung der Agentur am": from the submission to today (D19). */
export function confirmationProblem(
  confirmedOn: string,
  { registeredOn, today }: { registeredOn: string; today: string },
): "confirmed_on_in_future" | "confirmed_before_submission" | null {
  if (confirmedOn > today) return "confirmed_on_in_future";
  if (confirmedOn < registeredOn) return "confirmed_before_submission";
  return null;
}
