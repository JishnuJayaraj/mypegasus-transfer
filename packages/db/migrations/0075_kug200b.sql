CREATE TYPE "public"."export_kind" AS ENUM('kug200b_print');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'kug200b_offer_declined';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'declaration_withdrawal_recorded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'declaration_withdrawal_ba_notified';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'export_downloaded';--> statement-breakpoint
-- Hand-edited (ADR-0002, migrations): 0076 inserts the catalog's version 6 policy rows with
-- 'kug200b_form' in the same migration transaction, where a value from ADD VALUE would be an unsafe
-- use; the type is recreated instead, as 0069 did. The five functions that name it in their
-- signature are dropped here and created again by 0076.
ALTER TABLE "document" DROP CONSTRAINT "document_policy_fk";--> statement-breakpoint
ALTER TABLE "document" DROP CONSTRAINT "document_scan";--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "document_type_policy" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP FUNCTION "public"."current_document_policy"("public"."document_type");--> statement-breakpoint
DROP FUNCTION "public"."add_document"("public"."audit_context", uuid, uuid, "public"."document_type", "public"."document_media_type", integer, text, text, text, bytea, text, "public"."scan_origin", uuid);--> statement-breakpoint
DROP FUNCTION "public"."record_document_upload_rejected"("public"."audit_context", uuid, "public"."document_type", text, text);--> statement-breakpoint
DROP FUNCTION "public"."document_link_content"(text, "public"."document_session_kind", text);--> statement-breakpoint
DROP FUNCTION "public"."scan_form"("public"."document_type");--> statement-breakpoint
DROP TYPE "public"."document_type";--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('tl407_signed_scan', 'kug200b_signed_scan', 'dsv_signed_scan', 'dsv_cancellation', 'asu_proof', 'profiling_exception_evidence', 'cv', 'participant_upload', 'qualification_certificate', 'tl407_form', 'kug200b_form');--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "type" SET DATA TYPE "public"."document_type" USING "type"::"public"."document_type";--> statement-breakpoint
ALTER TABLE "document_type_policy" ALTER COLUMN "type" SET DATA TYPE "public"."document_type" USING "type"::"public"."document_type";--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_policy_fk" FOREIGN KEY ("type","catalog_version","retention_class") REFERENCES "public"."document_type_policy"("type","catalog_version","retention_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "export_link" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "export_kind" NOT NULL,
	"document_ids" uuid[] NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"session_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_link_token_hash" CHECK ("export_link"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "export_link_session_hash" CHECK ("export_link"."session_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "export_link_expires" CHECK ("export_link"."expires_at" > "export_link"."created_at"),
	CONSTRAINT "export_link_documents" CHECK (cardinality("export_link"."document_ids") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "kug200b_decline" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"declined_on" date NOT NULL,
	"declined_by" uuid NOT NULL,
	"declined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kug200b_withdrawal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ba_notified_on" date,
	"ba_notified_by" uuid,
	"ba_notified_at" timestamp with time zone,
	CONSTRAINT "kug200b_withdrawal_consent_unique" UNIQUE("consent_id"),
	CONSTRAINT "kug200b_withdrawal_notice" CHECK (("kug200b_withdrawal"."ba_notified_on" is null) = ("kug200b_withdrawal"."ba_notified_by" is null) and ("kug200b_withdrawal"."ba_notified_by" is null) = ("kug200b_withdrawal"."ba_notified_at" is null) and ("kug200b_withdrawal"."ba_notified_on" is null or "kug200b_withdrawal"."ba_notified_on" >= "kug200b_withdrawal"."received_on"))
);
--> statement-breakpoint
ALTER TABLE "document" DROP CONSTRAINT "document_scan_review";--> statement-breakpoint
ALTER TABLE "signed_declaration" DROP CONSTRAINT "signed_declaration_value";--> statement-breakpoint
ALTER TABLE "consent_record" ADD COLUMN "given_on" date;--> statement-breakpoint
ALTER TABLE "consent_record" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "form_generation" ADD COLUMN "checklist" jsonb;--> statement-breakpoint
ALTER TABLE "export_link" ADD CONSTRAINT "export_link_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_link" ADD CONSTRAINT "export_link_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_decline" ADD CONSTRAINT "kug200b_decline_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_decline" ADD CONSTRAINT "kug200b_decline_declined_by_staff_user_id_fk" FOREIGN KEY ("declined_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_decline" ADD CONSTRAINT "kug200b_decline_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_withdrawal" ADD CONSTRAINT "kug200b_withdrawal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_withdrawal" ADD CONSTRAINT "kug200b_withdrawal_consent_id_consent_record_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consent_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_withdrawal" ADD CONSTRAINT "kug200b_withdrawal_recorded_by_staff_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_withdrawal" ADD CONSTRAINT "kug200b_withdrawal_ba_notified_by_staff_user_id_fk" FOREIGN KEY ("ba_notified_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kug200b_withdrawal" ADD CONSTRAINT "kug200b_withdrawal_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kug200b_withdrawal_participation_idx" ON "kug200b_withdrawal" USING btree ("participation_id");--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_paper" CHECK (("consent_record"."source" = 'paper_form') = ("consent_record"."given_on" is not null) and ("consent_record"."document_id" is null or "consent_record"."source" = 'paper_form'));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_scan" CHECK (("document"."type" in ('tl407_signed_scan', 'kug200b_signed_scan')) = ("document"."scan_origin" is not null) and coalesce("document"."scan_origin" = 'generated', false) = ("document"."generation_document_id" is not null) and ("document"."form_code" is null) = ("document"."form_version" is null) and ("document"."form_version" is null or "document"."form_version" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$') and ("document"."scan_origin" is null or "document"."form_code" is not null or "document"."scan_origin" = 'external_paper' and "document"."review_state" <> 'accepted'));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_scan_review" CHECK (("document"."signed_on" is null) = ("document"."review_confirmations" is null) and ("document"."signed_on" is not null) = ("document"."scan_origin" is not null and "document"."review_state" = 'accepted') and ("document"."countersigned_on" is not null) = ("document"."signed_on" is not null and "document"."type" = 'tl407_signed_scan') and ("document"."review_confirmations" is null or "document"."type" = 'tl407_signed_scan' and "document"."review_confirmations" @> array['signatures_present', 'all_pages_present']::text[] or "document"."type" = 'kug200b_signed_scan' and "document"."review_confirmations" @> array['declarations_ticked', 'mandatory_completed', 'signature_present']::text[]));--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_kug200b" CHECK (("form_generation"."form_code" = 'kug200b') = ("form_generation"."checklist" is not null) and ("form_generation"."form_code" <> 'kug200b' or "form_generation"."jobboerse_choice" is null and "form_generation"."ba_contact_consent" is null and cardinality("form_generation"."confirmed_warnings") = 0 and not "form_generation"."anlage"));--> statement-breakpoint
ALTER TABLE "signed_declaration" ADD CONSTRAINT "signed_declaration_value" CHECK ("signed_declaration"."declaration" = 'jobboerseChoice' and ("signed_declaration"."value" is null or "signed_declaration"."value" in ('full', 'anonymous_callme', 'anonymous_no_contact', 'none')) or "signed_declaration"."declaration" = 'baContactConsent' and ("signed_declaration"."value" is null or "signed_declaration"."value" in ('yes', 'no')) or "signed_declaration"."declaration" in ('kug200bJobSeeking', 'kug200bProfileAccess') and "signed_declaration"."value" = 'yes');