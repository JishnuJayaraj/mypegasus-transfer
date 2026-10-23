CREATE TYPE "public"."appointment_cancel_reason" AS ENUM('organiser_unavailable', 'too_few_bookings', 'did_not_take_place', 'created_in_error', 'other');--> statement-breakpoint
CREATE TYPE "public"."appointment_kind" AS ENUM('info_event', 'consultation');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."booking_cancel_reason" AS ENUM('participant_cancelled', 'staff_cancelled', 'appointment_cancelled', 'participation_closed');--> statement-breakpoint
CREATE TYPE "public"."booking_origin" AS ENUM('participant', 'staff', 'walk_in');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('booked', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'appointment_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'appointment_changed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'appointment_cancelled';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'appointment_booked';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'appointment_booking_cancelled';--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "appointment_kind" NOT NULL,
	"host_staff_user_id" uuid,
	"audience_wave_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"booking_closes_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"title" text,
	"venue" text NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"cancel_reason" "appointment_cancel_reason",
	"cancelled_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "appointment_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "appointment_times" CHECK ("appointment"."ends_at" > "appointment"."starts_at"),
	CONSTRAINT "appointment_booking_closes" CHECK ("appointment"."booking_closes_at" <= "appointment"."starts_at" and "appointment"."booking_closes_at" >= "appointment"."starts_at" - interval '14 days'),
	CONSTRAINT "appointment_capacity" CHECK ("appointment"."capacity" between 1 and 500),
	CONSTRAINT "appointment_title" CHECK ("appointment"."title" is null or (char_length("appointment"."title") between 1 and 100 and "appointment"."title" = btrim("appointment"."title") and "appointment"."title" !~ '[[:cntrl:]]')),
	CONSTRAINT "appointment_venue" CHECK (char_length("appointment"."venue") between 1 and 200 and "appointment"."venue" = btrim("appointment"."venue") and "appointment"."venue" !~ '[[:cntrl:]]'),
	CONSTRAINT "appointment_host" CHECK (("appointment"."kind" = 'consultation') = ("appointment"."host_staff_user_id" is not null)),
	CONSTRAINT "appointment_audience" CHECK ("appointment"."kind" = 'info_event' or "appointment"."audience_wave_id" is null),
	CONSTRAINT "appointment_cancelled" CHECK (("appointment"."status" = 'cancelled') = ("appointment"."cancel_reason" is not null) and ("appointment"."status" = 'cancelled') = ("appointment"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "appointment_booking" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"origin" "booking_origin" NOT NULL,
	"status" "booking_status" DEFAULT 'booked' NOT NULL,
	"cancel_reason" "booking_cancel_reason",
	"booked_by" uuid,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "appointment_booking_cancelled" CHECK (("appointment_booking"."status" = 'cancelled') = ("appointment_booking"."cancel_reason" is not null) and ("appointment_booking"."status" = 'cancelled') = ("appointment_booking"."cancelled_at" is not null)),
	CONSTRAINT "appointment_booking_booked_by" CHECK (("appointment_booking"."origin" = 'participant') = ("appointment_booking"."booked_by" is null)),
	CONSTRAINT "appointment_booking_cancelled_by" CHECK (("appointment_booking"."cancelled_by" is not null) = coalesce("appointment_booking"."cancel_reason" in ('staff_cancelled', 'appointment_cancelled'), false))
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_host_staff_user_id_staff_user_id_fk" FOREIGN KEY ("host_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_staff_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_audience_wave_fk" FOREIGN KEY ("audience_wave_id","project_id") REFERENCES "public"."project_entry_wave"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_booked_by_staff_user_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_cancelled_by_staff_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking" ADD CONSTRAINT "appointment_booking_appointment_fk" FOREIGN KEY ("appointment_id","project_id") REFERENCES "public"."appointment"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_project_idx" ON "appointment" USING btree ("project_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_host_idx" ON "appointment" USING btree ("host_staff_user_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_booking_live_unique" ON "appointment_booking" USING btree ("appointment_id","participation_id") WHERE "appointment_booking"."status" = 'booked';--> statement-breakpoint
CREATE INDEX "appointment_booking_participation_idx" ON "appointment_booking" USING btree ("participation_id");--> statement-breakpoint
CREATE INDEX "appointment_booking_appointment_idx" ON "appointment_booking" USING btree ("appointment_id");