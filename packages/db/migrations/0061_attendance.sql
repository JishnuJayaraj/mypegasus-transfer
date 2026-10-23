CREATE TYPE "public"."attendance" AS ENUM('attended', 'absent');--> statement-breakpoint
CREATE TYPE "public"."attendance_after_close_reason" AS ENUM('late_entry', 'correction');--> statement-breakpoint
CREATE TYPE "public"."attendance_conflict_resolution" AS ENUM('replacement_basis', 'information_delivered_otherwise');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'attendance_recorded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'attendance_superseded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'information_delivery_confirmed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'attendance_conflict_escalated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'attendance_conflict_resolved';--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "attendance" "attendance";--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "attendance_recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "attendance_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "after_close_reason" "attendance_after_close_reason";--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "informed_basis_by" uuid;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "informed_basis_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "conflict_escalated_by" uuid;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "conflict_escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "conflict_resolution" "attendance_conflict_resolution";--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "conflict_resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "conflict_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "attendance_superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD COLUMN "attendance_superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_attendance_recorded_by_staff_user_id_fk" FOREIGN KEY ("attendance_recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_informed_basis_by_staff_user_id_fk" FOREIGN KEY ("informed_basis_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_conflict_escalated_by_staff_user_id_fk" FOREIGN KEY ("conflict_escalated_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_conflict_resolved_by_staff_user_id_fk" FOREIGN KEY ("conflict_resolved_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_attendance_superseded_by_staff_user_id_fk" FOREIGN KEY ("attendance_superseded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_attendance" CHECK (("appointment_booking"."attendance" is null) = ("appointment_booking"."attendance_recorded_by" is null) and ("appointment_booking"."attendance" is null) = ("appointment_booking"."attendance_recorded_at" is null) and ("appointment_booking"."after_close_reason" is null or "appointment_booking"."attendance" is not null) and ("appointment_booking"."origin" <> 'walk_in' or "appointment_booking"."attendance" is not null));--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_basis" CHECK (("appointment_booking"."informed_basis_by" is null) = ("appointment_booking"."informed_basis_at" is null) and ("appointment_booking"."informed_basis_at" is null or "appointment_booking"."attendance" is not null));--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_conflict" CHECK (("appointment_booking"."conflict_escalated_by" is null) = ("appointment_booking"."conflict_escalated_at" is null) and ("appointment_booking"."conflict_resolution" is null) = ("appointment_booking"."conflict_resolved_by" is null) and ("appointment_booking"."conflict_resolution" is null) = ("appointment_booking"."conflict_resolved_at" is null) and ("appointment_booking"."informed_basis_at" is not null or ("appointment_booking"."conflict_escalated_at" is null and "appointment_booking"."conflict_resolution" is null)));--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_superseded" CHECK (("appointment_booking"."attendance_superseded_by" is null) = ("appointment_booking"."attendance_superseded_at" is null) and ("appointment_booking"."attendance_superseded_at" is null or ("appointment_booking"."attendance" = 'absent' and "appointment_booking"."cancel_reason" = 'appointment_cancelled')));