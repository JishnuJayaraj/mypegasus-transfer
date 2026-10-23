CREATE TYPE "public"."notice_follow_up_method" AS ENUM('phone', 'in_person', 'letter', 'not_needed');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'appointment_notice_followed_up';--> statement-breakpoint
ALTER TYPE "public"."reminder_cancel_reason" ADD VALUE 'no_channel';--> statement-breakpoint
ALTER TYPE "public"."reminder_cancel_reason" ADD VALUE 'consent_required';--> statement-breakpoint
ALTER TYPE "public"."reminder_cancel_reason" ADD VALUE 'appointment_unavailable';--> statement-breakpoint
ALTER TYPE "public"."reminder_kind" ADD VALUE 'appointment_invitation';--> statement-breakpoint
ALTER TYPE "public"."reminder_kind" ADD VALUE 'appointment_changed';--> statement-breakpoint
ALTER TYPE "public"."reminder_kind" ADD VALUE 'appointment_cancelled';--> statement-breakpoint
ALTER TABLE "participant_reminder" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_reminder" ALTER COLUMN "channel_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_reminder" ALTER COLUMN "consent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_reminder" ALTER COLUMN "requested_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD COLUMN "followed_up_method" "notice_follow_up_method";--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD COLUMN "followed_up_by" uuid;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD COLUMN "followed_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_booking_id_appointment_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."appointment_booking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_followed_up_by_staff_user_id_fk" FOREIGN KEY ("followed_up_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_appointment_fk" FOREIGN KEY ("appointment_id","project_id") REFERENCES "public"."appointment"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "participant_reminder_appointment_idx" ON "participant_reminder" USING btree ("appointment_id","participation_id");--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_kind" CHECK (("participant_reminder"."kind"::text = 'open_items') = ("participant_reminder"."appointment_id" is null) and ("participant_reminder"."kind"::text in ('appointment_changed', 'appointment_cancelled')) = ("participant_reminder"."booking_id" is not null) and ("participant_reminder"."kind"::text in ('appointment_changed', 'appointment_cancelled')) = ("participant_reminder"."requested_by" is null));--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_channel" CHECK (("participant_reminder"."channel_id" is null) = coalesce("participant_reminder"."cancel_reason"::text in ('no_channel', 'consent_required'), false) and ("participant_reminder"."channel_id" is null) = ("participant_reminder"."channel_kind" is null) and ("participant_reminder"."channel_id" is null) = ("participant_reminder"."consent_id" is null) and ("participant_reminder"."channel_id" is not null or ("participant_reminder"."kind"::text <> 'open_items' and "participant_reminder"."claimed_at" is null)));--> statement-breakpoint
ALTER TABLE "participant_reminder" ADD CONSTRAINT "participant_reminder_follow_up" CHECK (("participant_reminder"."followed_up_method" is null) = ("participant_reminder"."followed_up_by" is null) and ("participant_reminder"."followed_up_method" is null) = ("participant_reminder"."followed_up_at" is null) and ("participant_reminder"."followed_up_method" is null or ("participant_reminder"."kind"::text in ('appointment_changed', 'appointment_cancelled') and ("participant_reminder"."status" in ('failed', 'delivery_unknown') or "participant_reminder"."status" = 'cancelled' and "participant_reminder"."cancel_reason" <> 'participation_closed'))));