CREATE TYPE "public"."correction_action" AS ENUM('invalidate', 'supersede');--> statement-breakpoint
CREATE TYPE "public"."correction_reason" AS ENUM('ba_legal_reference', 'data_subject_rectification', 'corrected_source_document', 'documented_internal_error');--> statement-breakpoint
CREATE TYPE "public"."correction_status" AS ENUM('requested', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."correction_target_kind" AS ENUM('document', 'asu_registration', 'ba_reporting_task');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'evidence_correction_requested';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'evidence_correction_decided';--> statement-breakpoint
CREATE TABLE "evidence_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"target_kind" "correction_target_kind" NOT NULL,
	"action" "correction_action" NOT NULL,
	"document_id" uuid,
	"asu_registration_id" uuid,
	"ba_reporting_task_id" uuid,
	"wrong_person" boolean,
	"corrected_registered_on" date,
	"reason" "correction_reason" NOT NULL,
	"source" text NOT NULL,
	"retention_class" text NOT NULL,
	"status" "correction_status" DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "evidence_correction_target" CHECK (num_nonnulls("evidence_correction"."document_id", "evidence_correction"."asu_registration_id", "evidence_correction"."ba_reporting_task_id") = 1 and ("evidence_correction"."target_kind" = 'document') = ("evidence_correction"."document_id" is not null) and ("evidence_correction"."target_kind" = 'asu_registration') = ("evidence_correction"."asu_registration_id" is not null) and ("evidence_correction"."target_kind" = 'ba_reporting_task') = ("evidence_correction"."ba_reporting_task_id" is not null)),
	CONSTRAINT "evidence_correction_action" CHECK (("evidence_correction"."target_kind" <> 'document' or "evidence_correction"."action" = 'invalidate') and ("evidence_correction"."target_kind" <> 'ba_reporting_task' or "evidence_correction"."action" = 'supersede') and ("evidence_correction"."target_kind" = 'document') = ("evidence_correction"."wrong_person" is not null) and ("evidence_correction"."target_kind" = 'asu_registration' and "evidence_correction"."action" = 'supersede') = ("evidence_correction"."corrected_registered_on" is not null)),
	CONSTRAINT "evidence_correction_source" CHECK (char_length("evidence_correction"."source") between 1 and 200 and "evidence_correction"."source" !~ '[[:cntrl:]]' and "evidence_correction"."source" = btrim("evidence_correction"."source")),
	CONSTRAINT "evidence_correction_decision" CHECK (("evidence_correction"."status" = 'requested') = ("evidence_correction"."decided_by" is null) and ("evidence_correction"."decided_by" is null) = ("evidence_correction"."decided_at" is null) and "evidence_correction"."decided_by" is distinct from "evidence_correction"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "asu_registration" DROP CONSTRAINT "asu_registration_participation_unique";--> statement-breakpoint
ALTER TABLE "asu_registration" DROP CONSTRAINT "asu_registration_proof_document_unique";--> statement-breakpoint
ALTER TABLE "asu_registration" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD COLUMN "invalidated_by" uuid;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD COLUMN "correction_id" uuid;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD COLUMN "replaces_task_id" uuid;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD COLUMN "correction_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_correction" ADD CONSTRAINT "evidence_correction_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_correction" ADD CONSTRAINT "evidence_correction_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_correction" ADD CONSTRAINT "evidence_correction_asu_registration_id_asu_registration_id_fk" FOREIGN KEY ("asu_registration_id") REFERENCES "public"."asu_registration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_correction" ADD CONSTRAINT "evidence_correction_ba_reporting_task_id_ba_reporting_task_id_fk" FOREIGN KEY ("ba_reporting_task_id") REFERENCES "public"."ba_reporting_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_correction" ADD CONSTRAINT "evidence_correction_requested_by_staff_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_correction" ADD CONSTRAINT "evidence_correction_decided_by_staff_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_correction" ADD CONSTRAINT "evidence_correction_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_correction_participation_idx" ON "evidence_correction" USING btree ("participation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_correction_one_pending_idx" ON "evidence_correction" USING btree (coalesce(document_id, asu_registration_id, ba_reporting_task_id)) WHERE status = 'requested';--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_superseded_by_evidence_correction_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."evidence_correction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_invalidated_by_evidence_correction_id_fk" FOREIGN KEY ("invalidated_by") REFERENCES "public"."evidence_correction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_correction_id_evidence_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."evidence_correction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_superseded_by_ba_reporting_task_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."ba_reporting_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_replaces_task_id_ba_reporting_task_id_fk" FOREIGN KEY ("replaces_task_id") REFERENCES "public"."ba_reporting_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_correction_id_evidence_correction_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."evidence_correction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- NOT VALID (hand-edited, Q209): an invalidation written before corrections existed (only tests
-- wrote one) can name no correction; it stays invalidated, so it still counts nothing, and every
-- new value must name a correction.
ALTER TABLE "document" ADD CONSTRAINT "document_invalidated_by_correction_evidence_correction_id_fk" FOREIGN KEY ("invalidated_by_correction") REFERENCES "public"."evidence_correction"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "asu_registration_current_unique" ON "asu_registration" USING btree ("participation_id") WHERE superseded_by is null and invalidated_by is null;--> statement-breakpoint
CREATE UNIQUE INDEX "asu_registration_current_proof_unique" ON "asu_registration" USING btree ("proof_document_id") WHERE superseded_by is null and invalidated_by is null;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_replaces_unique" UNIQUE("replaces_task_id");--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_corrected_once" CHECK (num_nonnulls("asu_registration"."superseded_by", "asu_registration"."invalidated_by") <= 1);--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_correction" CHECK (("ba_reporting_task"."superseded_by" is null or "ba_reporting_task"."status" <> 'pending') and ("ba_reporting_task"."replaces_task_id" is null) = ("ba_reporting_task"."correction_id" is null));