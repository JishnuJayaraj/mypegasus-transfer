import { document, sql, type Database } from "@transfer/db";
import {
  mayDecideCorrection,
  maySeeReview,
  type CorrectionReviewItem,
  type Subject,
} from "@transfer/domain";

// Evidence corrections as the views read them (data-protection.md, evidence corrections; D29,
// Q209). Reads only; the writes are `request_evidence_correction` and
// `decide_evidence_correction`.

/**
 * A document's correction state beside its row: invalidated by an approved correction (it opens
 * for nobody and counts nothing), or with a request awaiting its decision.
 */
export const documentCorrection = {
  invalidated: sql<boolean>`${document.invalidatedByCorrection} is not null`,
  // Qualified by hand: a single-table select renders its columns unqualified.
  correctionPending: sql<boolean>`exists (select from evidence_correction c
    where c.document_id = "document"."id" and c.status = 'requested')`,
};

/**
 * The pending corrections in "Freigaben" (data-protection.md, evidence corrections; D29): those of
 * the projects of the manager's regions, oldest first; per item the project, the target's kind
 * and category (a field's key, a signature's paper and kind), the action, the reason, the
 * documented source and the dates, and whether the
 * viewer may decide it (never their own request). No name, no file, no corrected value.
 */
export async function correctionReviewItemsOf(
  db: Database,
  subject: Subject,
): Promise<CorrectionReviewItem[]> {
  const { rows } = await db.execute<{
    correction_id: string;
    project_id: string;
    project_name: string;
    region_id: string | null;
    participation_id: string;
    target_kind: CorrectionReviewItem["targetKind"];
    action: CorrectionReviewItem["action"];
    document_type: CorrectionReviewItem["documentType"];
    reporting_kind: CorrectionReviewItem["reportingKind"];
    wrong_person: boolean | null;
    field_key: CorrectionReviewItem["fieldKey"];
    signature_kind: CorrectionReviewItem["signatureKind"];
    reason: CorrectionReviewItem["reason"];
    source: string;
    requested_on: string;
    requested_by: string;
    target_recorded_on: string;
  }>(sql`select c.id as correction_id, c.project_id, pr.name as project_name, pr.region_id,
      c.participation_id, c.target_kind, c.action, coalesce(d.type::text, c.signature_paper)
        as document_type, t.reporting_kind, c.wrong_person, c.field_key, c.signature_kind,
      c.reason, c.source, c.requested_by,
      to_char(c.requested_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as requested_on,
      -- A field: when its status change was recorded; a signature: when its rows were.
      to_char(coalesce(d.reviewed_at, g.recorded_at, t.decided_at,
        (select f.occurred_at from field_status_change(c.participation_id, c.field_key) f
          where c.field_key is not null),
        (select min(s.recorded_at) from dsv_scan_signature s join document x on x.id = s.document_id
          where x.dsv_offer_id = c.dsv_offer_id and x.type::text = c.signature_paper
            and s.kind = c.signature_kind), c.requested_at)
        at time zone 'Europe/Berlin', 'YYYY-MM-DD') as target_recorded_on
    from evidence_correction c
    join project pr on pr.id = c.project_id
    left join document d on d.id = c.document_id
    left join asu_registration g on g.id = c.asu_registration_id
    left join ba_reporting_task t on t.id = c.ba_reporting_task_id
    where c.status = 'requested'
    order by c.requested_at, c.id`);
  return rows
    .filter((row) => maySeeReview(subject, { regionId: row.region_id }))
    .map((row) => ({
      correctionId: row.correction_id,
      projectId: row.project_id,
      projectName: row.project_name,
      targetKind: row.target_kind,
      action: row.action,
      documentType: row.document_type,
      reportingKind: row.reporting_kind,
      wrongPerson: row.wrong_person,
      fieldKey: row.field_key,
      signatureKind: row.signature_kind,
      reason: row.reason,
      source: row.source,
      requestedOn: row.requested_on,
      targetRecordedOn: row.target_recorded_on,
      capabilities: {
        decide: mayDecideCorrection(subject, row.requested_by, {
          projectId: row.project_id,
          regionId: row.region_id,
          participationId: row.participation_id,
        }),
      },
    }));
}
