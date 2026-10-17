CREATE TYPE "public"."relaxation_reason_code" AS ENUM('source_data_not_provided', 'not_needed_for_project_measures', 'collected_outside_platform', 'agentur_confirmed_not_required');--> statement-breakpoint
CREATE TYPE "public"."relaxation_request_status" AS ENUM('requested', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'rule_relaxation_requested';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'rule_relaxation_approved';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'rule_relaxation_rejected';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'rule_relaxation_withdrawn';--> statement-breakpoint
CREATE TABLE "config_relaxation_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"reason_code" "relaxation_reason_code" NOT NULL,
	"status" "relaxation_request_status" NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_on" date NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_on" date,
	"decided_at" timestamp with time zone,
	CONSTRAINT "config_relaxation_request_rule_id" CHECK ("config_relaxation_request"."rule_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'),
	CONSTRAINT "config_relaxation_request_decision" CHECK (("config_relaxation_request"."decided_by" is null) = ("config_relaxation_request"."decided_on" is null) and ("config_relaxation_request"."decided_by" is null) = ("config_relaxation_request"."decided_at" is null) and ("config_relaxation_request"."status" in ('approved', 'rejected')) = ("config_relaxation_request"."decided_by" is not null)),
	CONSTRAINT "config_relaxation_request_four_eyes" CHECK ("config_relaxation_request"."decided_by" <> "config_relaxation_request"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "config_relaxation_request" ADD CONSTRAINT "config_relaxation_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_relaxation_request" ADD CONSTRAINT "config_relaxation_request_requested_by_staff_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_relaxation_request" ADD CONSTRAINT "config_relaxation_request_decided_by_staff_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "config_relaxation_request_one_open_idx" ON "config_relaxation_request" USING btree ("project_id","rule_id") WHERE "config_relaxation_request"."status" = 'requested';