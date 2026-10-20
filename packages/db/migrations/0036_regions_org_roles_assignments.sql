CREATE TYPE "public"."assignment_end_reason" AS ENUM('unassigned', 'consultant_removed', 'account_deactivated');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('admin', 'regional_admin', 'regional_operations_manager');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'project_member_added';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'project_member_removed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'participant_assigned';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'participant_unassigned';--> statement-breakpoint
ALTER TYPE "public"."staff_audit_event_type" ADD VALUE 'staff_account_created';--> statement-breakpoint
ALTER TYPE "public"."staff_audit_event_type" ADD VALUE 'staff_account_changed';--> statement-breakpoint
ALTER TYPE "public"."staff_audit_event_type" ADD VALUE 'staff_account_deactivated';--> statement-breakpoint
ALTER TYPE "public"."staff_audit_event_type" ADD VALUE 'org_role_granted';--> statement-breakpoint
ALTER TYPE "public"."staff_audit_event_type" ADD VALUE 'org_role_revoked';--> statement-breakpoint
ALTER TYPE "public"."staff_audit_event_type" ADD VALUE 'region_created';--> statement-breakpoint
ALTER TYPE "public"."staff_audit_event_type" ADD VALUE 'region_changed';--> statement-breakpoint
CREATE TABLE "participant_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by" uuid,
	"ended_at" timestamp with time zone,
	"end_reason" "assignment_end_reason",
	CONSTRAINT "participant_assignment_ended" CHECK (("participant_assignment"."ended_at" is null) = ("participant_assignment"."ended_by" is null) and ("participant_assignment"."ended_at" is null) = ("participant_assignment"."end_reason" is null) and "participant_assignment"."ended_at" >= "participant_assignment"."assigned_at")
);
--> statement-breakpoint
CREATE TABLE "region" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_code_unique" UNIQUE("code"),
	CONSTRAINT "region_code_format" CHECK ("region"."code" ~ '^[A-Z0-9]([A-Z0-9-]{0,18}[A-Z0-9])?$'),
	CONSTRAINT "region_name" CHECK ("region"."name" = btrim("region"."name") and length("region"."name") between 1 and 100 and "region"."name" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "staff_org_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"role" "org_role" NOT NULL,
	"region_id" uuid,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_org_role_unique" UNIQUE NULLS NOT DISTINCT("staff_user_id","role","region_id"),
	CONSTRAINT "staff_org_role_region_scope" CHECK (("staff_org_role"."role" = 'admin') = ("staff_org_role"."region_id" is null))
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_lifecycle_has_participation";--> statement-breakpoint
ALTER TABLE "staff_audit_event" DROP CONSTRAINT "staff_audit_event_shape";--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_user" ADD COLUMN "may_create_projects" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_assignment" ADD CONSTRAINT "participant_assignment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_assignment" ADD CONSTRAINT "participant_assignment_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_assignment" ADD CONSTRAINT "participant_assignment_assigned_by_staff_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_assignment" ADD CONSTRAINT "participant_assignment_ended_by_staff_user_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_assignment" ADD CONSTRAINT "participant_assignment_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_org_role" ADD CONSTRAINT "staff_org_role_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_org_role" ADD CONSTRAINT "staff_org_role_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_org_role" ADD CONSTRAINT "staff_org_role_granted_by_staff_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "participant_assignment_one_open_idx" ON "participant_assignment" USING btree ("participation_id","staff_user_id") WHERE "participant_assignment"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "participant_assignment_staff_user_open_idx" ON "participant_assignment" USING btree ("staff_user_id") WHERE "participant_assignment"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_region_idx" ON "project" USING btree ("region_id");--> statement-breakpoint
-- Hand-edited: the flat role's mapping (Q126). `project_lead` becomes the project-creation flag,
-- `admin` a global org role. The flat regional roles get no org role: no region is known (the seed
-- grants them with one). Consultants and back office keep their project memberships.
UPDATE "staff_user" SET "may_create_projects" = ("role" = 'project_lead');--> statement-breakpoint
INSERT INTO "staff_org_role" ("staff_user_id", "role") SELECT "id", 'admin' FROM "staff_user" WHERE "role" = 'admin';--> statement-breakpoint
ALTER TABLE "staff_user" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_lifecycle_has_participation" CHECK ("audit_event"."participation_id" is not null or "audit_event"."event_type"::text not in ('participation_created', 'status_changed', 'entry_wave_assigned', 'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected', 'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed', 'participation_created_manually', 'participation_dates_changed', 'sensitive_read', 'sensitive_write', 'break_glass_access', 'document_opened', 'participant_assigned', 'participant_unassigned'));--> statement-breakpoint
ALTER TABLE "staff_audit_event" ADD CONSTRAINT "staff_audit_event_shape" CHECK (coalesce(case
        when "staff_audit_event"."event_type"::text = 'staff_login_refused' then "staff_audit_event"."actor_staff_user_id" is null
          and "staff_audit_event"."reason_code" in ('unknown_account', 'account_deactivated', 'identity_mismatch')
          and ("staff_audit_event"."subject_staff_user_id" is null) = ("staff_audit_event"."reason_code" = 'unknown_account')
        when "staff_audit_event"."event_type"::text in ('staff_login', 'staff_logout', 'staff_identity_bound') then "staff_audit_event"."actor_staff_user_id" is not null
          and "staff_audit_event"."subject_staff_user_id" = "staff_audit_event"."actor_staff_user_id" and "staff_audit_event"."reason_code" is null
        when "staff_audit_event"."event_type"::text in ('region_created', 'region_changed') then "staff_audit_event"."actor_staff_user_id" is not null
          and "staff_audit_event"."subject_staff_user_id" is null and "staff_audit_event"."reason_code" is null
          and jsonb_typeof("staff_audit_event"."details" -> 'regionId') = 'string'
        else "staff_audit_event"."actor_staff_user_id" is not null and "staff_audit_event"."subject_staff_user_id" is not null
          and "staff_audit_event"."reason_code" is null
      end, false));--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_display_name" CHECK ("staff_user"."display_name" = btrim("staff_user"."display_name") and length("staff_user"."display_name") between 1 and 100 and "staff_user"."display_name" !~ '[[:cntrl:]]');--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_email_format" CHECK ("staff_user"."email" ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$' and length("staff_user"."email") <= 254);--> statement-breakpoint
DROP TYPE "public"."staff_role";