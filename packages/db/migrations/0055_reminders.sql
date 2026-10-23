CREATE TYPE "public"."reminder_cancel_reason" AS ENUM('channel_unavailable', 'consent_ended', 'participation_closed', 'nothing_open', 'requester_no_longer_authorized', 'delivery_unavailable');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('open_items');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('queued', 'dispatching', 'sent', 'failed', 'delivery_unknown', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'reminder_queued';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'reminder_delivery';--> statement-breakpoint
ALTER TYPE "public"."consent_end_reason" ADD VALUE 'superseded';--> statement-breakpoint
CREATE TABLE "participant_reminder" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"message_version" text NOT NULL,
	"language" "notice_language" NOT NULL,
	"channel_id" uuid NOT NULL,
	"channel_kind" "contact_channel_kind" NOT NULL,
	"consent_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_on" date NOT NULL,
	"status" "reminder_status" DEFAULT 'queued' NOT NULL,
	"cancel_reason" "reminder_cancel_reason",
	"claimed_at" timestamp with time zone,
	"outcome_at" timestamp with time zone,
	CONSTRAINT "participant_reminder_message_version" CHECK ("participant_reminder"."message_version" ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'),
	CONSTRAINT "participant_reminder_cancelled" CHECK (("participant_reminder"."status" = 'cancelled') = ("participant_reminder"."cancel_reason" is not null)),
	CONSTRAINT "participant_reminder_outcome" CHECK (("participant_reminder"."status" in ('queued', 'dispatching')) = ("participant_reminder"."outcome_at" is null) and ("participant_reminder"."status" <> 'dispatching' or "participant_reminder"."claimed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_channel_id_participant_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."participant_channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_consent_id_consent_record_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consent_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_requested_by_staff_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "participant_reminder_participation_idx" ON "participant_reminder" USING btree ("participation_id","requested_at");