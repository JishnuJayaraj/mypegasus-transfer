CREATE TYPE "public"."actor_type" AS ENUM('user', 'participant', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('participation_created', 'status_changed', 'entry_wave_assigned', 'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected', 'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected', 'sensitive_read', 'sensitive_write', 'break_glass_access', 'document_opened', 'warning_confirmed', 'export_created', 'config_override_changed', 'review_recorded', 'clarification_requested');--> statement-breakpoint
CREATE TYPE "public"."dsv_status" AS ENUM('not_offered', 'dsv_offered', 'dsv_signed', 'dsv_declined', 'dsv_expired');--> statement-breakpoint
CREATE TYPE "public"."edge_kind" AS ENUM('scheduled_entry', 'scheduled_entry_catchup', 'reconciliation', 'manual', 'system', 'anonymous_self_registration');--> statement-breakpoint
CREATE TYPE "public"."end_reason" AS ENUM('declined_profiling', 'declined_dsv', 'no_response', 'never_contacted', 'not_informed', 'placed_direct', 'self_employed', 'retirement', 'other_measure', 'deceased', 'other', 'placed_permanent', 'placed_fixed_term', 'apprenticeship_or_study', 'max_duration_reached', 'own_termination_without_job', 'terminated_by_tg', 'long_term_illness_reduced_earning_capacity');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_track" AS ENUM('main', 'profiling', 'dsv');--> statement-breakpoint
CREATE TYPE "public"."main_status" AS ENUM('self_registered', 'imported', 'contacted', 'unreachable', 'informed', 'active_in_tg', 'withdrawn', 'rejected', 'ta_completed', 'exited');--> statement-breakpoint
CREATE TYPE "public"."profiling_exception_reason" AS ENUM('participant_prevented_documented', 'agentur_scheduling_unavailable', 'force_majeure', 'ba_confirmed_other');--> statement-breakpoint
CREATE TYPE "public"."profiling_exception_status" AS ENUM('none', 'requested', 'approved', 'rejected', 'revoked', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."profiling_exception_superseded_reason" AS ENUM('participation_closed', 'project_ta_only', 'profiling_closed');--> statement-breakpoint
CREATE TYPE "public"."profiling_status" AS ENUM('not_started', 'profiling_accepted', 'profiling_in_progress', 'profiling_done', 'profiling_declined');--> statement-breakpoint
CREATE TYPE "public"."status_field" AS ENUM('status', 'profiling_status', 'dsv_status');--> statement-breakpoint
CREATE TYPE "public"."tg_entry_kind" AS ENUM('scheduled_entry', 'scheduled_entry_catchup', 'reconciliation');--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"participation_id" uuid,
	"event_type" "audit_event_type" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_staff_user_id" uuid,
	"actor_participation_id" uuid,
	"system_job" text,
	"on_behalf_of_participation_id" uuid,
	"field" "status_field",
	"from_value" text,
	"to_value" text,
	"reason_code" text,
	"effective_date" date,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	"job_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flagged_for_review" boolean DEFAULT false NOT NULL,
	CONSTRAINT "audit_event_actor_consistent" CHECK (case "audit_event"."actor_type"
        when 'user' then "audit_event"."actor_staff_user_id" is not null and "audit_event"."actor_participation_id" is null and "audit_event"."system_job" is null
        when 'participant' then "audit_event"."actor_participation_id" is not null and "audit_event"."actor_staff_user_id" is null and "audit_event"."system_job" is null and "audit_event"."on_behalf_of_participation_id" is null
        else "audit_event"."system_job" is not null and "audit_event"."actor_staff_user_id" is null and "audit_event"."actor_participation_id" is null and "audit_event"."on_behalf_of_participation_id" is null
      end),
	CONSTRAINT "audit_event_lifecycle_has_participation" CHECK ("audit_event"."participation_id" is not null or "audit_event"."event_type" not in ('participation_created', 'status_changed', 'entry_wave_assigned', 'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected', 'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected', 'sensitive_read', 'sensitive_write', 'break_glass_access', 'document_opened')),
	CONSTRAINT "audit_event_change_values" CHECK (case
        when "audit_event"."event_type" = 'status_changed' then "audit_event"."field" is not null and "audit_event"."from_value" is not null and "audit_event"."to_value" is not null
        when "audit_event"."event_type" = 'participation_created' then "audit_event"."field" = 'status' and "audit_event"."from_value" is null and "audit_event"."to_value" = 'imported'
        when "audit_event"."event_type" = 'end_reason_corrected' then "audit_event"."field" is null and "audit_event"."from_value" = any(enum_range(null::end_reason)::text[]) and "audit_event"."to_value" = any(enum_range(null::end_reason)::text[])
        else "audit_event"."field" is null and "audit_event"."from_value" is null and "audit_event"."to_value" is null
      end),
	CONSTRAINT "audit_event_values_of_field" CHECK ("audit_event"."field" is null or case "audit_event"."field"
        when 'status' then "audit_event"."to_value" = any(enum_range(null::main_status)::text[]) and ("audit_event"."from_value" is null or "audit_event"."from_value" = any(enum_range(null::main_status)::text[]))
        when 'profiling_status' then "audit_event"."to_value" = any(enum_range(null::profiling_status)::text[]) and "audit_event"."from_value" = any(enum_range(null::profiling_status)::text[])
        else "audit_event"."to_value" = any(enum_range(null::dsv_status)::text[]) and "audit_event"."from_value" = any(enum_range(null::dsv_status)::text[])
      end),
	CONSTRAINT "audit_event_reason_code_is_code" CHECK ("audit_event"."reason_code" ~ '^[a-z][a-z0-9_]{0,62}$' and "audit_event"."reason_code" <> 'long_term_illness_reduced_earning_capacity'),
	CONSTRAINT "audit_event_system_job_is_name" CHECK ("audit_event"."system_job" ~ '^[a-z][a-z0-9_.-]{0,62}$'),
	CONSTRAINT "audit_event_request_id_is_id" CHECK ("audit_event"."request_id" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
	CONSTRAINT "audit_event_job_id_is_id" CHECK ("audit_event"."job_id" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
	CONSTRAINT "audit_event_details_ids_and_codes" CHECK (jsonb_typeof("audit_event"."details") = 'object' and not jsonb_path_exists("audit_event"."details", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_.:+-]{1,100}$"))') and not jsonb_path_exists("audit_event"."details", 'strict $.** ? (@.type() == "object").keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9]{0,62}$"))'))
);
--> statement-breakpoint
CREATE TABLE "lifecycle_edge" (
	"track" "lifecycle_track" NOT NULL,
	"from_value" text,
	"to_value" text NOT NULL,
	"kind" "edge_kind" NOT NULL,
	"actors" "actor_type"[] NOT NULL,
	"project_types" "project_type"[],
	CONSTRAINT "lifecycle_edge_unique" UNIQUE NULLS NOT DISTINCT("track","from_value","to_value","kind"),
	CONSTRAINT "lifecycle_edge_values_of_track" CHECK (("lifecycle_edge"."track" = 'main' and "lifecycle_edge"."to_value" = any(enum_range(null::main_status)::text[]) and ("lifecycle_edge"."from_value" is null or "lifecycle_edge"."from_value" = any(enum_range(null::main_status)::text[]))) or ("lifecycle_edge"."track" = 'profiling' and "lifecycle_edge"."to_value" = any(enum_range(null::profiling_status)::text[]) and ("lifecycle_edge"."from_value" is null or "lifecycle_edge"."from_value" = any(enum_range(null::profiling_status)::text[]))) or ("lifecycle_edge"."track" = 'dsv' and "lifecycle_edge"."to_value" = any(enum_range(null::dsv_status)::text[]) and ("lifecycle_edge"."from_value" is null or "lifecycle_edge"."from_value" = any(enum_range(null::dsv_status)::text[]))))
);
--> statement-breakpoint
CREATE TABLE "participation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"entry_wave_id" uuid,
	"status" "main_status" NOT NULL,
	"profiling_status" "profiling_status" NOT NULL,
	"dsv_status" "dsv_status" NOT NULL,
	"offer_deadline" date,
	"tg_start" date,
	"tg_end" date,
	"tg_entry_date" date,
	"exit_date" date,
	"withdrawn_on" date,
	"profiling_done_on" date,
	"end_reason" "end_reason",
	"end_reason_source" "actor_type",
	"end_reason_secondary" "end_reason"[] DEFAULT '{}' NOT NULL,
	"profiling_exception_request_id" uuid,
	"status_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participation_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "participation_tg_dates_ordered" CHECK ("participation"."tg_start" <= "participation"."tg_end"),
	CONSTRAINT "participation_offer_deadline_before_tg_start" CHECK ("participation"."offer_deadline" <= "participation"."tg_start"),
	CONSTRAINT "participation_offer_needs_wave" CHECK ("participation"."dsv_status" = 'not_offered' or "participation"."entry_wave_id" is not null),
	CONSTRAINT "participation_end_reason_when_ended" CHECK (("participation"."status" in ('withdrawn', 'exited')) = ("end_reason" is not null)),
	CONSTRAINT "participation_end_reason_source_with_reason" CHECK ((end_reason is not null) = ("end_reason_source" is not null)),
	CONSTRAINT "participation_secondary_reasons_with_reason" CHECK ("participation"."end_reason" is not null or cardinality("participation"."end_reason_secondary") = 0),
	CONSTRAINT "participation_end_reason_storable" CHECK ("participation"."end_reason" is distinct from 'long_term_illness_reduced_earning_capacity' and not ('long_term_illness_reduced_earning_capacity' = any("participation"."end_reason_secondary"))),
	CONSTRAINT "participation_withdrawn_on_when_withdrawn" CHECK (("participation"."status" in ('withdrawn')) = ("withdrawn_on" is not null)),
	CONSTRAINT "participation_tg_entry_date_in_tg" CHECK (("participation"."status" in ('active_in_tg', 'exited')) = ("tg_entry_date" is not null)),
	CONSTRAINT "participation_exit_date_when_exited" CHECK (("participation"."status" in ('exited')) = ("exit_date" is not null)),
	CONSTRAINT "participation_profiling_done_on_when_done" CHECK (("participation"."profiling_status" = 'profiling_done') = ("profiling_done_on" is not null)),
	CONSTRAINT "participation_tracks_start_at_informed" CHECK (not ("participation"."status" in ('self_registered', 'rejected', 'imported', 'contacted', 'unreachable')) or ("participation"."profiling_status" = 'not_started' and "participation"."dsv_status" = 'not_offered')),
	CONSTRAINT "participation_tg_needs_signed_dsv" CHECK (not ("participation"."status" in ('active_in_tg', 'exited')) or "participation"."dsv_status" = 'dsv_signed'),
	CONSTRAINT "participation_unmatched_has_no_wave" CHECK (not ("participation"."status" in ('self_registered', 'rejected')) or "participation"."entry_wave_id" is null)
);
--> statement-breakpoint
CREATE TABLE "profiling_exception_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"reason_code" "profiling_exception_reason" NOT NULL,
	"status" "profiling_exception_status" NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_on" date NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_record_id" uuid NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"decided_by" uuid,
	"decided_on" date,
	"decided_at" timestamp with time zone,
	"superseded_reason" "profiling_exception_superseded_reason",
	CONSTRAINT "profiling_exception_request_id_participation_unique" UNIQUE("id","participation_id"),
	CONSTRAINT "profiling_exception_request_status_not_none" CHECK ("profiling_exception_request"."status" <> 'none'),
	CONSTRAINT "profiling_exception_request_fingerprint" CHECK ("profiling_exception_request"."evidence_fingerprint" ~ '^sha256:v1:[0-9a-f]{64}$'),
	CONSTRAINT "profiling_exception_request_decision" CHECK (("profiling_exception_request"."decided_by" is null) = ("profiling_exception_request"."decided_on" is null) and ("profiling_exception_request"."decided_by" is null) = ("profiling_exception_request"."decided_at" is null) and (not ("profiling_exception_request"."status" in ('approved', 'rejected')) or "profiling_exception_request"."decided_by" is not null) and (not ("profiling_exception_request"."status" in ('requested', 'superseded')) or "profiling_exception_request"."decided_by" is null)),
	CONSTRAINT "profiling_exception_request_superseded_reason" CHECK (("profiling_exception_request"."status" in ('superseded')) = ("superseded_reason" is not null)),
	CONSTRAINT "profiling_exception_request_four_eyes" CHECK ("profiling_exception_request"."decided_by" <> "profiling_exception_request"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "project_entry_wave" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"signing_deadline" date,
	"default_tg_start" date,
	"default_tg_end" date,
	"latest_entry_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_entry_wave_project_code_unique" UNIQUE("project_id","code"),
	CONSTRAINT "project_entry_wave_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "project_entry_wave_tg_dates_ordered" CHECK ("project_entry_wave"."default_tg_start" <= "project_entry_wave"."default_tg_end")
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_entry_wave_same_project_fk" FOREIGN KEY ("entry_wave_id","project_id") REFERENCES "public"."project_entry_wave"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_current_exception_request_fk" FOREIGN KEY ("profiling_exception_request_id","id") REFERENCES "public"."profiling_exception_request"("id","participation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_exception_request" ADD CONSTRAINT "profiling_exception_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_exception_request" ADD CONSTRAINT "profiling_exception_request_requested_by_staff_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_exception_request" ADD CONSTRAINT "profiling_exception_request_decided_by_staff_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_exception_request" ADD CONSTRAINT "profiling_exception_request_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_entry_wave" ADD CONSTRAINT "project_entry_wave_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_participation_seq_idx" ON "audit_event" USING btree ("participation_id","seq");--> statement-breakpoint
CREATE INDEX "audit_event_project_seq_idx" ON "audit_event" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "participation_project_id_idx" ON "participation" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiling_exception_request_one_open_idx" ON "profiling_exception_request" USING btree ("participation_id") WHERE "profiling_exception_request"."status" in ('requested', 'approved');