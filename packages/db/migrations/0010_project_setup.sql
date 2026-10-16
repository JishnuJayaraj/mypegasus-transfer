CREATE TYPE "public"."project_role" AS ENUM('project_lead', 'consultant', 'back_office');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'active');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'project_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'project_changed';--> statement-breakpoint
CREATE TABLE "project_membership" (
	"project_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_membership_pkey" PRIMARY KEY("project_id","staff_user_id","role")
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "status" "project_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "project_agentur_key" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "activated_by" uuid;--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_membership_staff_user_idx" ON "project_membership" USING btree ("staff_user_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_activated_by_staff_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_activated" CHECK (("project"."status" = 'active') = ("project"."activated_at" is not null) and ("project"."activated_at" is null) = ("project"."activated_by" is null));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_agentur_key_format" CHECK ("project"."project_agentur_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');