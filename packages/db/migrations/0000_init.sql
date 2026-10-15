CREATE TYPE "public"."project_type" AS ENUM('ta_only', 'ta_tg');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('admin', 'regional_admin', 'project_lead', 'consultant', 'back_office');--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"customer_name" text NOT NULL,
	"type" "project_type" NOT NULL,
	"signing_deadline" date,
	"default_tg_start" date,
	"default_tg_end" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "project_tg_dates_ordered" CHECK ("project"."default_tg_start" <= "project"."default_tg_end"),
	CONSTRAINT "project_ta_only_has_no_tg_dates" CHECK ("project"."type" <> 'ta_only' or ("project"."signing_deadline" is null and "project"."default_tg_start" is null and "project"."default_tg_end" is null))
);
--> statement-breakpoint
CREATE TABLE "staff_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_staff_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_created_at_id_idx" ON "project" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);