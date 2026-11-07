CREATE TYPE "public"."dsv_deadline_kind" AS ENUM('wave', 'explicit');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'dsv_form_generated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'dsv_template_pinned';--> statement-breakpoint
-- Hand-edited (ADR-0002, migrations): 0090 inserts the catalog's version 8 policy rows with
-- 'dsv_form' in the same migration transaction, where a value from ADD VALUE would be an unsafe
-- use; the type is recreated instead, as 0069 and 0075 did. The constraints that compare it with
-- a literal and the six functions that name it in their signature are dropped here; the
-- constraints are added again below as they were, the functions by 0090 as 0076 and 0080 wrote
-- them.
ALTER TABLE "document" DROP CONSTRAINT "document_policy_fk";--> statement-breakpoint
ALTER TABLE "document" DROP CONSTRAINT "document_scan";--> statement-breakpoint
ALTER TABLE "document" DROP CONSTRAINT "document_scan_review";--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "document_type_policy" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP FUNCTION "public"."current_document_policy"("public"."document_type");--> statement-breakpoint
DROP FUNCTION "public"."scan_form"("public"."document_type");--> statement-breakpoint
DROP FUNCTION "public"."add_document"("public"."audit_context", uuid, uuid, "public"."document_type", "public"."document_media_type", integer, text, text, text, bytea, text, "public"."scan_origin", uuid);--> statement-breakpoint
DROP FUNCTION "public"."record_document_upload_rejected"("public"."audit_context", uuid, "public"."document_type", text, text);--> statement-breakpoint
DROP FUNCTION "public"."document_link_content"(text, "public"."document_session_kind", text);--> statement-breakpoint
DROP FUNCTION "public"."export_link_content"("public"."audit_context", text, text);--> statement-breakpoint
DROP TYPE "public"."document_type";--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('tl407_signed_scan', 'kug200b_signed_scan', 'dsv_signed_scan', 'dsv_cancellation', 'asu_proof', 'profiling_exception_evidence', 'cv', 'participant_upload', 'qualification_certificate', 'tl407_form', 'kug200b_form', 'dsv_form');--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "type" SET DATA TYPE "public"."document_type" USING "type"::"public"."document_type";--> statement-breakpoint
ALTER TABLE "document_type_policy" ALTER COLUMN "type" SET DATA TYPE "public"."document_type" USING "type"::"public"."document_type";--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_policy_fk" FOREIGN KEY (type, catalog_version, retention_class) REFERENCES document_type_policy(type, catalog_version, retention_class);--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_scan" CHECK ((((type = ANY (ARRAY['tl407_signed_scan'::document_type, 'kug200b_signed_scan'::document_type])) = (scan_origin IS NOT NULL)) AND (COALESCE((scan_origin = 'generated'::scan_origin), false) = (generation_document_id IS NOT NULL)) AND ((form_code IS NULL) = (form_version IS NULL)) AND ((form_version IS NULL) OR (form_version ~ '^(0[1-9]|1[0-2])-[0-9]{4}$'::text)) AND ((scan_origin IS NULL) OR (form_code IS NOT NULL) OR ((scan_origin = 'external_paper'::scan_origin) AND (review_state <> 'accepted'::document_review_state)))));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_scan_review" CHECK ((((signed_on IS NULL) = (review_confirmations IS NULL)) AND ((signed_on IS NOT NULL) = ((scan_origin IS NOT NULL) AND (review_state = 'accepted'::document_review_state))) AND ((countersigned_on IS NOT NULL) = ((signed_on IS NOT NULL) AND (type = 'tl407_signed_scan'::document_type))) AND ((review_confirmations IS NULL) OR ((type = 'tl407_signed_scan'::document_type) AND (review_confirmations @> ARRAY['signatures_present'::text, 'all_pages_present'::text])) OR ((type = 'kug200b_signed_scan'::document_type) AND (review_confirmations @> ARRAY['declarations_ticked'::text, 'mandatory_completed'::text, 'signature_present'::text])))));--> statement-breakpoint
ALTER TYPE "public"."form_code" ADD VALUE 'dsv';--> statement-breakpoint
ALTER TABLE "form_generation" DROP CONSTRAINT "form_generation_form_version";--> statement-breakpoint
ALTER TABLE "form_generation" DROP CONSTRAINT "form_generation_kug200b";--> statement-breakpoint
ALTER TABLE "form_generation" ADD COLUMN "offer_deadline" date;--> statement-breakpoint
ALTER TABLE "form_generation" ADD COLUMN "deadline_kind" "dsv_deadline_kind";--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "dsv_template_version" text;--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_dsv" CHECK (("form_generation"."form_code"::text = 'dsv') = ("form_generation"."offer_deadline" is not null) and ("form_generation"."offer_deadline" is null) = ("form_generation"."deadline_kind" is null) and ("form_generation"."form_code"::text <> 'dsv' or "form_generation"."checklist" is not null and "form_generation"."jobboerse_choice" is null and "form_generation"."ba_contact_consent" is null and cardinality("form_generation"."confirmed_warnings") = 0 and not "form_generation"."anlage"));--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_form_version" CHECK (case when "form_generation"."form_code"::text = 'dsv' then "form_generation"."form_version" ~ '^v[1-9][0-9]{0,3}$' else "form_generation"."form_version" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$' end);--> statement-breakpoint
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_kug200b" CHECK (("form_generation"."form_code"::text in ('kug200b', 'dsv')) = ("form_generation"."checklist" is not null) and ("form_generation"."form_code" <> 'kug200b' or "form_generation"."jobboerse_choice" is null and "form_generation"."ba_contact_consent" is null and cardinality("form_generation"."confirmed_warnings") = 0 and not "form_generation"."anlage"));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_dsv_template_version" CHECK ("project"."dsv_template_version" ~ '^v[1-9][0-9]{0,3}$');