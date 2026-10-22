CREATE TYPE "public"."assisted_mode_end_reason" AS ENUM('ended', 'staff_session_ended');--> statement-breakpoint
CREATE TYPE "public"."assisted_mode_how" AS ENUM('in_person', 'phone');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'assisted_mode_started';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'assisted_mode_ended';--> statement-breakpoint
CREATE TABLE "assisted_mode" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"staff_session_hash" text NOT NULL,
	"how" "assisted_mode_how" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" "assisted_mode_end_reason",
	CONSTRAINT "assisted_mode_ended" CHECK (("assisted_mode"."ended_at" is null) = ("assisted_mode"."end_reason" is null)),
	CONSTRAINT "assisted_mode_ended_after_start" CHECK ("assisted_mode"."ended_at" >= "assisted_mode"."started_at")
);
--> statement-breakpoint
ALTER TABLE "assisted_mode" ADD CONSTRAINT "assisted_mode_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assisted_mode" ADD CONSTRAINT "assisted_mode_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assisted_mode" ADD CONSTRAINT "assisted_mode_staff_session_hash_staff_session_token_hash_fk" FOREIGN KEY ("staff_session_hash") REFERENCES "public"."staff_session"("token_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assisted_mode" ADD CONSTRAINT "assisted_mode_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assisted_mode_staff_session_idx" ON "assisted_mode" USING btree ("staff_session_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "assisted_mode_live_unique" ON "assisted_mode" USING btree ("staff_session_hash","participation_id") WHERE "assisted_mode"."ended_at" is null;