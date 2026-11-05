import { sql, type Database } from "@transfer/db";
import {
  documentCapabilities,
  mayAddDocument,
  mayPerformOperation,
  maySeeReview,
  type PermissionTarget,
  type ProfilingExceptionReason,
  type ProfilingExceptionView,
  type ReviewItem,
  type Subject,
} from "@transfer/domain";

// Profiling exceptions on the tab "Profiling" and in the queue "Freigaben" (process-and-lifecycle.md,
// profiling exceptions; data-protection.md, exception evidence; D30, Q80, Q194). Reads only; the
// writes go through the status service. Neither view carries a fingerprint, a file, a document's
// metadata beyond its id and review state, or the BA confirmation's facts.

/** An instant as ISO 8601 UTC text. */
const utc = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/**
 * What the viewer may do with an evidence document on the tab without opening it: delete it
 * before its review, quarantine it at once, lift a quarantine (the review of PR #102).
 */
function safetyActions(
  subject: Subject,
  target: PermissionTarget & { participationId: string },
  reviewState: "unreviewed" | "accepted" | "rejected",
  quarantinedBy: string | null,
  correction: { invalidated: boolean; correctionPending: boolean },
) {
  const all = documentCapabilities(
    subject,
    target,
    { kind: "normal" },
    {
      type: "profiling_exception_evidence",
      addedByParticipant: false,
      reviewState,
      quarantinedBy,
      ...correction,
    },
  );
  return {
    delete: all.delete,
    quarantine: all.quarantine,
    liftQuarantine: all.liftQuarantine,
    requestCorrection: all.requestCorrection,
  };
}

/**
 * The exception block of one participation for the viewer (the PL or the assigned consultant):
 * the current request and its evidence's kind, the evidence documents as ids and review states
 * (the PL uploads them but can't open them), and what the viewer may do now.
 */
export async function exceptionViewOf(
  db: Database,
  subject: Subject,
  target: PermissionTarget & { participationId: string },
  participation: { status: string; profilingStatus: string },
): Promise<ProfilingExceptionView> {
  const { participationId } = target;
  const { rows: current } = await db.execute<{
    request_id: string;
    status: "requested" | "approved" | "rejected" | "revoked" | "superseded";
    reason: ProfilingExceptionReason;
    requested_on: string;
    decided_on: string | null;
    evidence_record_id: string;
    evidence_kind: "documents" | "ba_confirmation";
  }>(sql`select r.id as request_id, r.status, r.reason_code as reason,
      r.requested_on::text, r.decided_on::text, r.evidence_record_id, e.kind as evidence_kind
    from participation p
    join profiling_exception_request r on r.id = p.profiling_exception_request_id
    join profiling_exception_evidence_record e on e.id = r.evidence_record_id
    where p.id = ${participationId}::uuid`);
  const { rows: documents } = await db.execute<{
    document_id: string;
    added_at: string;
    review_state: "unreviewed" | "accepted" | "rejected";
    usable: boolean;
    quarantined_by: string | null;
    invalidated: boolean;
    correction_pending: boolean;
  }>(sql`select id as document_id, ${utc("added_at")} as added_at, review_state, quarantined_by,
      invalidated_by_correction is not null as invalidated,
      exists (select from evidence_correction c
        where c.document_id = document.id and c.status = 'requested') as correction_pending,
      review_state = 'accepted' and quarantined_at is null
        and invalidated_by_correction is null as usable
    from document
    where participation_id = ${participationId}::uuid
      and type = 'profiling_exception_evidence' and deleted_at is null
    order by added_at, id`);
  const row = current[0];
  const informed = participation.status === "informed";
  const profilingOpen = !["profiling_done", "profiling_declined"].includes(
    participation.profilingStatus,
  );
  const open = row?.status === "requested" || row?.status === "approved";
  const may = (kind: "requestProfilingException" | "revokeProfilingException") =>
    mayPerformOperation(subject, { kind }, target).ok;
  return {
    current: row
      ? {
          requestId: row.request_id,
          status: row.status,
          reason: row.reason,
          requestedOn: row.requested_on,
          decidedOn: row.decided_on,
          evidenceRecordId: row.evidence_record_id,
          evidenceKind: row.evidence_kind,
        }
      : null,
    evidenceDocuments: documents.map((d) => ({
      documentId: d.document_id,
      addedAt: d.added_at,
      reviewState: d.review_state,
      usable: d.usable,
      quarantined: d.quarantined_by !== null,
      capabilities: safetyActions(subject, target, d.review_state, d.quarantined_by, {
        invalidated: d.invalidated,
        correctionPending: d.correction_pending,
      }),
    })),
    capabilities: {
      addEvidence:
        informed &&
        mayAddDocument(subject, "profiling_exception_evidence", target, { kind: "normal" }).ok,
      request: informed && profilingOpen && !open && may("requestProfilingException"),
      revoke: informed && open && may("revokeProfilingException"),
    },
  };
}

/**
 * The queue "Freigaben" (Q80, Q194): the pending requests of `informed` participations in the
 * projects of the manager's regions, oldest first; per item the project, the reason code, the
 * dates, the evidence's kind and whether it still counts, and whether the viewer may decide it
 * (never their own request). No name, no case data, no evidence content.
 */
export async function reviewItemsOf(db: Database, subject: Subject): Promise<ReviewItem[]> {
  const { rows } = await db.execute<{
    request_id: string;
    project_id: string;
    project_name: string;
    region_id: string | null;
    participation_id: string;
    reason: ReviewItem["reason"];
    requested_on: string;
    requested_by: string;
    tg_start: string | null;
    evidence_record_id: string;
    evidence_kind: ReviewItem["evidenceKind"];
    evidence_present: boolean;
  }>(sql`select r.id as request_id, r.project_id, pr.name as project_name,
      pr.region_id, r.participation_id, r.reason_code as reason, r.requested_on::text,
      r.requested_by, coalesce(p.tg_start, w.default_tg_start)::text as tg_start,
      r.evidence_record_id, e.kind as evidence_kind,
      exception_evidence_usable(e.id) as evidence_present
    from profiling_exception_request r
    join participation p on p.id = r.participation_id and p.profiling_exception_request_id = r.id
    join project pr on pr.id = r.project_id
    join profiling_exception_evidence_record e on e.id = r.evidence_record_id
    left join project_entry_wave w on w.id = p.entry_wave_id
    where r.status = 'requested' and p.status = 'informed'
    order by r.requested_at, r.id`);
  return rows
    .filter((row) => maySeeReview(subject, { regionId: row.region_id }))
    .map((row) => ({
      requestId: row.request_id,
      projectId: row.project_id,
      projectName: row.project_name,
      reason: row.reason,
      requestedOn: row.requested_on,
      tgStart: row.tg_start,
      evidenceRecordId: row.evidence_record_id,
      evidenceKind: row.evidence_kind,
      evidencePresent: row.evidence_present,
      capabilities: {
        decide: mayPerformOperation(
          subject,
          { kind: "decideProfilingException", requestedBy: row.requested_by },
          {
            projectId: row.project_id,
            regionId: row.region_id,
            participationId: row.participation_id,
          },
        ).ok,
      },
    }));
}
