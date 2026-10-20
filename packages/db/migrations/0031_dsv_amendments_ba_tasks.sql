CREATE TYPE "public"."amendment_original_location" AS ENUM('paper_personnel_file');--> statement-breakpoint
CREATE TYPE "public"."ba_reporting_kind" AS ENUM('later_entry', 'planned_end_changed', 'early_exit');--> statement-breakpoint
CREATE TYPE "public"."ba_reporting_status" AS ENUM('pending', 'reported', 'not_required');--> statement-breakpoint
CREATE TYPE "public"."dsv_amendment_kind" AS ENUM('extension', 'new_start');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'participation_dates_changed';--> statement-breakpoint
CREATE TABLE "ba_reporting_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"reporting_kind" "ba_reporting_kind" NOT NULL,
	"subject_date" date NOT NULL,
	"amendment_id" uuid,
	"status" "ba_reporting_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_on" date,
	"channel" text,
	"reference" text,
	CONSTRAINT "ba_reporting_task_reported_fields" CHECK (("ba_reporting_task"."status" = 'reported') = ("ba_reporting_task"."reported_on" is not null) and ("ba_reporting_task"."status" = 'reported' or ("ba_reporting_task"."channel" is null and "ba_reporting_task"."reference" is null)))
);
--> statement-breakpoint
CREATE TABLE "participation_dsv_amendment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "dsv_amendment_kind" NOT NULL,
	"fully_executed_on" date NOT NULL,
	"old_tg_start" date,
	"new_tg_start" date,
	"old_tg_end" date,
	"new_tg_end" date,
	"confirmed_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"original_location" "amendment_original_location" NOT NULL,
	"document_reference" text,
	CONSTRAINT "participation_dsv_amendment_id_project" UNIQUE("id","project_id"),
	CONSTRAINT "participation_dsv_amendment_reference" CHECK ("participation_dsv_amendment"."document_reference" ~ '^[A-Za-z0-9_./-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_lifecycle_has_participation";--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_reporting_task" ADD CONSTRAINT "ba_reporting_task_amendment_fk" FOREIGN KEY ("amendment_id","project_id") REFERENCES "public"."participation_dsv_amendment"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_dsv_amendment" ADD CONSTRAINT "participation_dsv_amendment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_dsv_amendment" ADD CONSTRAINT "participation_dsv_amendment_confirmed_by_staff_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_dsv_amendment" ADD CONSTRAINT "participation_dsv_amendment_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ba_reporting_task_participation_idx" ON "ba_reporting_task" USING btree ("participation_id");--> statement-breakpoint
CREATE INDEX "participation_dsv_amendment_participation_idx" ON "participation_dsv_amendment" USING btree ("participation_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_lifecycle_has_participation" CHECK ("audit_event"."participation_id" is not null or "audit_event"."event_type"::text not in ('participation_created', 'status_changed', 'entry_wave_assigned', 'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected', 'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed', 'participation_created_manually', 'participation_dates_changed', 'sensitive_read', 'sensitive_write', 'break_glass_access', 'document_opened'));