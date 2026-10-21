CREATE TYPE "public"."challenge_invalidation" AS ENUM('superseded', 'delivery_failed');--> statement-breakpoint
CREATE TYPE "public"."channel_removal_reason" AS ENUM('consent_revoked', 'lost_access_replaced');--> statement-breakpoint
CREATE TYPE "public"."channel_suspension_reason" AS ENUM('lost_access');--> statement-breakpoint
CREATE TYPE "public"."channel_verification" AS ENUM('one_time_code', 'activation_link');--> statement-breakpoint
CREATE TYPE "public"."consent_end_reason" AS ENUM('revoked', 'lost_access_replaced');--> statement-breakpoint
CREATE TYPE "public"."consent_purpose" AS ENUM('portal_contact');--> statement-breakpoint
CREATE TYPE "public"."contact_channel_kind" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."identity_assurance" AS ENUM('birth_date', 'photo_id');--> statement-breakpoint
CREATE TYPE "public"."one_time_code_purpose" AS ENUM('login', 'channel_verification');--> statement-breakpoint
CREATE TYPE "public"."participant_session_end_reason" AS ENUM('logout', 'activated', 'superseded', 'code_closed', 'participation_closed');--> statement-breakpoint
CREATE TYPE "public"."participant_session_state" AS ENUM('activating', 'active');--> statement-breakpoint
CREATE TYPE "public"."step_up_method" AS ENUM('birth_date', 'one_time_code');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'participant_activated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'consent_given';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'contact_channel_added';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'activation_code_locked';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'one_time_code_exhausted';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'participant_logout';--> statement-breakpoint
-- Hand-edited (Slice 3 plan D25): the 'activation' edges are inserted in 0042, in the same
-- migration transaction, where a value from ADD VALUE would be an unsafe use; the type is
-- recreated instead, as 0033 did. No function names the type in a signature.
ALTER TABLE "lifecycle_edge" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."edge_kind";--> statement-breakpoint
CREATE TYPE "public"."edge_kind" AS ENUM('scheduled_entry', 'scheduled_entry_catchup', 'reconciliation', 'manual', 'system', 'activation');--> statement-breakpoint
ALTER TABLE "lifecycle_edge" ALTER COLUMN "kind" SET DATA TYPE "public"."edge_kind" USING "kind"::"public"."edge_kind";--> statement-breakpoint
CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"channel_id" uuid NOT NULL,
	"text_version" text NOT NULL,
	"language" "notice_language" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_staff_user_id" uuid,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" "consent_end_reason",
	CONSTRAINT "consent_record_text_version" CHECK ("consent_record"."text_version" ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'),
	CONSTRAINT "consent_record_ended" CHECK (("consent_record"."ended_at" is null) = ("consent_record"."end_reason" is null)),
	CONSTRAINT "consent_record_actor" CHECK ("consent_record"."actor_type" in ('participant', 'user') and ("consent_record"."actor_type" = 'user') = ("consent_record"."actor_staff_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "one_time_code_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"purpose" "one_time_code_purpose" NOT NULL,
	"kind" "contact_channel_kind" NOT NULL,
	"address" text NOT NULL,
	"code_hash" text NOT NULL,
	"delivery_status" "activation_delivery_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" "challenge_invalidation",
	CONSTRAINT "one_time_code_challenge_code_hash" CHECK ("one_time_code_challenge"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "one_time_code_challenge_lifetime" CHECK ("one_time_code_challenge"."expires_at" = "one_time_code_challenge"."created_at" + interval '15 minutes'),
	CONSTRAINT "one_time_code_challenge_attempts" CHECK ("one_time_code_challenge"."failed_attempts" between 0 and 5),
	CONSTRAINT "one_time_code_challenge_invalidated" CHECK (("one_time_code_challenge"."invalidated_at" is null) = ("one_time_code_challenge"."invalidation_reason" is null)),
	CONSTRAINT "one_time_code_challenge_one_end" CHECK (num_nonnulls("one_time_code_challenge"."consumed_at", "one_time_code_challenge"."invalidated_at") <= 1)
);
--> statement-breakpoint
CREATE TABLE "participant_account" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activation_code_id" uuid NOT NULL,
	"identity_assurance" "identity_assurance" NOT NULL,
	"identity_assured_by" uuid,
	"identity_assured_at" timestamp with time zone,
	"language" "notice_language" NOT NULL,
	CONSTRAINT "participant_account_photo_id" CHECK (("participant_account"."identity_assurance" = 'photo_id') = ("participant_account"."identity_assured_by" is not null) and ("participant_account"."identity_assured_by" is null) = ("participant_account"."identity_assured_at" is null))
);
--> statement-breakpoint
CREATE TABLE "participant_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"kind" "contact_channel_kind" NOT NULL,
	"address" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_by" "channel_verification" NOT NULL,
	"consent_id" uuid NOT NULL,
	"notice_sent_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspension_reason" "channel_suspension_reason",
	"removed_at" timestamp with time zone,
	"removed_reason" "channel_removal_reason",
	CONSTRAINT "participant_channel_address" CHECK (case "participant_channel"."kind" when 'email' then "participant_channel"."address" ~ '^[^@[:space:]A-Z]+@[^@[:space:]A-Z]+[.][^@[:space:]A-Z]+$' and length("participant_channel"."address") <= 254 else "participant_channel"."address" ~ '^[+][1-9][0-9]{7,14}$' end),
	CONSTRAINT "participant_channel_suspended" CHECK (("participant_channel"."suspended_at" is null) = ("participant_channel"."suspension_reason" is null)),
	CONSTRAINT "participant_channel_removed" CHECK (("participant_channel"."removed_at" is null) = ("participant_channel"."removed_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "participant_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"state" "participant_session_state" NOT NULL,
	"activation_code_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" "participant_session_end_reason",
	"birth_date_checked_at" timestamp with time zone,
	"delivery_address_checked_at" timestamp with time zone,
	"step_up_method" "step_up_method",
	"step_up_at" timestamp with time zone,
	CONSTRAINT "participant_session_token_hash" CHECK ("participant_session"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "participant_session_ended" CHECK (("participant_session"."ended_at" is null) = ("participant_session"."end_reason" is null)),
	CONSTRAINT "participant_session_step_up" CHECK (("participant_session"."step_up_method" is null) = ("participant_session"."step_up_at" is null)),
	CONSTRAINT "participant_session_activating" CHECK (("participant_session"."state" = 'activating') = ("participant_session"."activation_code_id" is not null) and ("participant_session"."state" = 'activating' or "participant_session"."birth_date_checked_at" is null and "participant_session"."delivery_address_checked_at" is null))
);
--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_code_challenge" ADD CONSTRAINT "one_time_code_challenge_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_code_challenge" ADD CONSTRAINT "one_time_code_challenge_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_account" ADD CONSTRAINT "participant_account_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_account" ADD CONSTRAINT "participant_account_identity_assured_by_staff_user_id_fk" FOREIGN KEY ("identity_assured_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_account" ADD CONSTRAINT "participant_account_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_account" ADD CONSTRAINT "participant_account_activation_code_fk" FOREIGN KEY ("activation_code_id","project_id") REFERENCES "public"."activation_code"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_channel" ADD CONSTRAINT "participant_channel_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_channel" ADD CONSTRAINT "participant_channel_consent_id_consent_record_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consent_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_channel" ADD CONSTRAINT "participant_channel_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_session" ADD CONSTRAINT "participant_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_session" ADD CONSTRAINT "participant_session_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_session" ADD CONSTRAINT "participant_session_activation_code_fk" FOREIGN KEY ("activation_code_id","project_id") REFERENCES "public"."activation_code"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_record_participation_idx" ON "consent_record" USING btree ("participation_id");--> statement-breakpoint
CREATE INDEX "one_time_code_challenge_address_idx" ON "one_time_code_challenge" USING btree ("kind","address","created_at");--> statement-breakpoint
CREATE INDEX "one_time_code_challenge_participation_idx" ON "one_time_code_challenge" USING btree ("participation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_channel_address_idx" ON "participant_channel" USING btree ("kind","address") WHERE "participant_channel"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "participant_channel_participation_idx" ON "participant_channel" USING btree ("participation_id");--> statement-breakpoint
CREATE INDEX "participant_session_participation_idx" ON "participant_session" USING btree ("participation_id");