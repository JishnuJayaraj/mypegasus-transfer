CREATE TYPE "public"."agentur_submission_channel" AS ENUM('paper_courier', 'paper_post', 'scan_email', 'upload', 'email', 'paper_original');--> statement-breakpoint
CREATE TYPE "public"."kug200b_batch_artifact" AS ENUM('kug200a', 'accepted_alternative');--> statement-breakpoint
CREATE TYPE "public"."kug200b_batch_channel" AS ENUM('paper_courier', 'paper_post', 'scan_email', 'upload');--> statement-breakpoint
CREATE TYPE "public"."kug200b_batch_status" AS ENUM('open', 'submitted', 'discarded');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'kug200b_batch_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'kug200b_batch_submitted';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'kug200b_batch_discarded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'agentur_submission_recorded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'asu_confirmation_recorded';--> statement-breakpoint
ALTER TYPE "public"."export_kind" ADD VALUE 'kug200b_batch_index';--> statement-breakpoint
CREATE TABLE "agentur_submission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"form_code" "form_code" NOT NULL,
	"form_version" text NOT NULL,
	"agentur_key" text NOT NULL,
	"channel" "agentur_submission_channel" NOT NULL,
	"batch_id" uuid,
	"submitted_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentur_submission_batch_member_unique" UNIQUE("batch_id","participation_id"),
	CONSTRAINT "agentur_submission_form_version" CHECK ("agentur_submission"."form_version" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$'),
	CONSTRAINT "agentur_submission_batch" CHECK (("agentur_submission"."form_code" = 'kug200b') = ("agentur_submission"."batch_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "kug200b_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"agentur_key" text NOT NULL,
	"channel" "kug200b_batch_channel" NOT NULL,
	"artifact" "kug200b_batch_artifact" NOT NULL,
	"status" "kug200b_batch_status" DEFAULT 'open' NOT NULL,
	"member_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_on" date,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"discarded_by" uuid,
	"discarded_at" timestamp with time zone,
	CONSTRAINT "kug200b_batch_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "kug200b_batch_agentur_key" CHECK ("kug200b_batch"."agentur_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "kug200b_batch_members" CHECK ("kug200b_batch"."member_count" between 1 and 200),
	CONSTRAINT "kug200b_batch_status" CHECK (("kug200b_batch"."status" = 'submitted') = ("kug200b_batch"."submitted_on" is not null) and ("kug200b_batch"."submitted_on" is null) = ("kug200b_batch"."submitted_by" is null) and ("kug200b_batch"."submitted_by" is null) = ("kug200b_batch"."submitted_at" is null) and ("kug200b_batch"."status" = 'discarded') = ("kug200b_batch"."discarded_at" is not null) and ("kug200b_batch"."discarded_at" is null) = ("kug200b_batch"."discarded_by" is null)),
	CONSTRAINT "kug200b_batch_submitted_on" CHECK ("kug200b_batch"."submitted_on" >= ("kug200b_batch"."created_at" at time zone 'Europe/Berlin')::date)
);
--> statement-breakpoint
CREATE TABLE "kug200b_batch_member" (
	"batch_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"form_version" text NOT NULL,
	"asu_channel" "asu_channel",
	"placement_agentur_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "kug200b_batch_member_pkey" PRIMARY KEY("batch_id","participation_id"),
	CONSTRAINT "kug200b_batch_member_form_version" CHECK ("kug200b_batch_member"."form_version" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$')
);
--> statement-breakpoint
ALTER TABLE "export_link" DROP CONSTRAINT "export_link_documents";--> statement-breakpoint
ALTER TABLE "asu_registration" ADD COLUMN "agentur_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD COLUMN "confirmed_on" date;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "export_link" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "agentur_submission" ADD CONSTRAINT "agentur_submission_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentur_submission" ADD CONSTRAINT "agentur_submission_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentur_submission" ADD CONSTRAINT "agentur_submission_recorded_by_staff_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentur_submission" ADD CONSTRAINT "agentur_submission_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentur_submission" ADD CONSTRAINT "agentur_submission_batch_fk" FOREIGN KEY ("batch_id","project_id") REFERENCES "public"."kug200b_batch"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch" ADD CONSTRAINT "kug200b_batch_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch" ADD CONSTRAINT "kug200b_batch_created_by_staff_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch" ADD CONSTRAINT "kug200b_batch_submitted_by_staff_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch" ADD CONSTRAINT "kug200b_batch_discarded_by_staff_user_id_fk" FOREIGN KEY ("discarded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch_member" ADD CONSTRAINT "kug200b_batch_member_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch_member" ADD CONSTRAINT "kug200b_batch_member_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch_member" ADD CONSTRAINT "kug200b_batch_member_batch_fk" FOREIGN KEY ("batch_id","project_id") REFERENCES "public"."kug200b_batch"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_batch_member" ADD CONSTRAINT "kug200b_batch_member_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agentur_submission_participation_idx" ON "agentur_submission" USING btree ("participation_id");--> statement-breakpoint
CREATE INDEX "kug200b_batch_project_idx" ON "kug200b_batch" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kug200b_batch_member_live_unique" ON "kug200b_batch_member" USING btree ("participation_id") WHERE "kug200b_batch_member"."active";--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_agentur_submission_id_agentur_submission_id_fk" FOREIGN KEY ("agentur_submission_id") REFERENCES "public"."agentur_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_confirmed_by_staff_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_link" ADD CONSTRAINT "export_link_batch_id_kug200b_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."kug200b_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_submission_unique" UNIQUE("agentur_submission_id");--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_submission" CHECK (coalesce("asu_registration"."proof_kind" = 'kug200b_submission', false) = ("asu_registration"."agentur_submission_id" is not null));--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_confirmation" CHECK (("asu_registration"."confirmed_on" is null) = ("asu_registration"."confirmed_by" is null) and ("asu_registration"."confirmed_by" is null) = ("asu_registration"."confirmed_at" is null) and ("asu_registration"."confirmed_on" is null or "asu_registration"."channel" = 'kug_200b' and "asu_registration"."confirmed_on" >= "asu_registration"."registered_on"));--> statement-breakpoint
ALTER TABLE "export_link" ADD CONSTRAINT "export_link_batch" CHECK (("export_link"."batch_id" is null) = ("export_link"."kind" = 'kug200b_print'));--> statement-breakpoint
ALTER TABLE "export_link" ADD CONSTRAINT "export_link_documents" CHECK ("export_link"."batch_id" is null and cardinality("export_link"."document_ids") between 1 and 100 or "export_link"."batch_id" is not null and cardinality("export_link"."document_ids") = 0);