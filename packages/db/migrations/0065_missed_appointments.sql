CREATE TYPE "public"."missed_resolution" AS ENUM('participant_declined', 'information_delivered_otherwise', 'no_longer_needed');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'missed_appointment_resolved';--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "follow_up_of" uuid;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "missed_resolution" "missed_resolution";--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "missed_resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "missed_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_missed_resolved_by_staff_user_id_fk" FOREIGN KEY ("missed_resolved_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_id_participation_unique" UNIQUE("id","participation_id");--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_follow_up_fk" FOREIGN KEY ("follow_up_of","participation_id") REFERENCES "public"."appointment_booking"("id","participation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_booking_follow_up_idx" ON "appointment_booking" USING btree ("follow_up_of");--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_follow_up" CHECK ("appointment_booking"."follow_up_of" is null or ("appointment_booking"."follow_up_of" <> "appointment_booking"."id" and "appointment_booking"."origin" = 'staff'));--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_missed" CHECK (("appointment_booking"."missed_resolution" is null) = ("appointment_booking"."missed_resolved_by" is null) and ("appointment_booking"."missed_resolution" is null) = ("appointment_booking"."missed_resolved_at" is null) and ("appointment_booking"."missed_resolution" is null or "appointment_booking"."attendance" = 'absent'));