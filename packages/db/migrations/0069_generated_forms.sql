CREATE TYPE "public"."form_code" AS ENUM('tl407', 'kug200b', 'kug200a');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'form_generated';--> statement-breakpoint
-- Hand-edited (ADR-0002, migrations): 0070 inserts the catalog's version 3 policy rows with
-- 'tl407_form' in the same migration transaction, where a value from ADD VALUE would be an unsafe
-- use; the type is recreated instead, as 0041 did. The four functions that name it in their
-- signature are dropped here and created again by 0070, unchanged.
ALTER TABLE "document" DROP CONSTRAINT "document_policy_fk";--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "document_type_policy" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP FUNCTION "public"."current_document_policy"("public"."document_type");--> statement-breakpoint
DROP FUNCTION "public"."add_document"("public"."audit_context", uuid, uuid, "public"."document_type", "public"."document_media_type", integer, text, text, text, bytea, text);--> statement-breakpoint
DROP FUNCTION "public"."record_document_upload_rejected"("public"."audit_context", uuid, "public"."document_type", text, text);--> statement-breakpoint
DROP FUNCTION "public"."document_link_content"(text, "public"."document_session_kind", text);--> statement-breakpoint
DROP TYPE "public"."document_type";--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('tl407_signed_scan', 'kug200b_signed_scan', 'dsv_signed_scan', 'dsv_cancellation', 'asu_proof', 'profiling_exception_evidence', 'cv', 'participant_upload', 'qualification_certificate', 'tl407_form');--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "type" SET DATA TYPE "public"."document_type" USING "type"::"public"."document_type";--> statement-breakpoint
ALTER TABLE "document_type_policy" ALTER COLUMN "type" SET DATA TYPE "public"."document_type" USING "type"::"public"."document_type";--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_policy_fk" FOREIGN KEY ("type","catalog_version","retention_class") REFERENCES "public"."document_type_policy"("type","catalog_version","retention_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "form_generation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"form_code" "form_code" NOT NULL,
	"form_version" text NOT NULL,
	"profile_revision" integer NOT NULL,
	"profiling_revision" integer NOT NULL,
	"assessment_revision" integer NOT NULL,
	"unemployment_revision" integer NOT NULL,
	"jobboerse_choice" "jobboerse_choice",
	"ba_contact_consent" boolean,
	"confirmed_warnings" text[] NOT NULL,
	"anlage" boolean NOT NULL,
	"generated_by" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_generation_document_unique" UNIQUE("document_id"),
	CONSTRAINT "form_generation_form_version" CHECK ("form_generation"."form_version" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$'),
	CONSTRAINT "form_generation_revisions" CHECK ("form_generation"."profile_revision" >= 0 and "form_generation"."profiling_revision" >= 0 and "form_generation"."assessment_revision" >= 0 and "form_generation"."unemployment_revision" >= 0),
	CONSTRAINT "form_generation_confirmed_warnings" CHECK ("form_generation"."confirmed_warnings" <@ array['age_implausible', 'entry_before_birth', 'range_reversed', 'school_qualification_none']::text[])
);
--> statement-breakpoint
ALTER TABLE "document_type_policy" ADD COLUMN "generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_generated_by_staff_user_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_generation_participation_idx" ON "form_generation" USING btree ("participation_id","form_code","generated_at");