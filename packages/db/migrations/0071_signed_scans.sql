CREATE TYPE "public"."document_quarantine_reason" AS ENUM('suspected_wrong_person', 'suspected_wrong_acceptance');--> statement-breakpoint
CREATE TYPE "public"."scan_origin" AS ENUM('generated', 'external_paper');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'document_quarantined';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'document_quarantine_lifted';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'signed_declaration_recorded';--> statement-breakpoint
CREATE TABLE "signed_declaration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"form_code" "form_code" NOT NULL,
	"form_version" text NOT NULL,
	"declaration" text NOT NULL,
	"value" text,
	"signed_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signed_declaration_unique" UNIQUE("document_id","declaration"),
	CONSTRAINT "signed_declaration_form_version" CHECK ("signed_declaration"."form_version" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$'),
	CONSTRAINT "signed_declaration_value" CHECK ("signed_declaration"."declaration" = 'jobboerseChoice' and ("signed_declaration"."value" is null or "signed_declaration"."value" in ('full', 'anonymous_callme', 'anonymous_no_contact', 'none')) or "signed_declaration"."declaration" = 'baContactConsent' and ("signed_declaration"."value" is null or "signed_declaration"."value" in ('yes', 'no')))
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "scan_origin" "scan_origin";--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "generation_document_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "form_code" "form_code";--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "form_version" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "signed_on" date;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "countersigned_on" date;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "review_confirmations" text[];--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "quarantine_reason" "document_quarantine_reason";--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "quarantined_by" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "quarantine_lifted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "invalidated_by_correction" uuid;--> statement-breakpoint
ALTER TABLE "signed_declaration" ADD CONSTRAINT "signed_declaration_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_declaration" ADD CONSTRAINT "signed_declaration_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_declaration" ADD CONSTRAINT "signed_declaration_recorded_by_staff_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_declaration" ADD CONSTRAINT "signed_declaration_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signed_declaration_participation_idx" ON "signed_declaration" USING btree ("participation_id","recorded_at");--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_quarantined_by_staff_user_id_fk" FOREIGN KEY ("quarantined_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-edited (ADR-0002, migrations): the UNIQUE the scan's composite FK references comes first.
ALTER TABLE "form_generation" ADD CONSTRAINT "form_generation_scan_target" UNIQUE("document_id","participation_id","form_code");--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_generation_fk" FOREIGN KEY ("generation_document_id","participation_id","form_code") REFERENCES "public"."form_generation"("document_id","participation_id","form_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_scan" CHECK (("document"."type" = 'tl407_signed_scan') = ("document"."scan_origin" is not null) and coalesce("document"."scan_origin" = 'generated', false) = ("document"."generation_document_id" is not null) and ("document"."form_code" is null) = ("document"."form_version" is null) and ("document"."form_version" is null or "document"."form_version" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$') and ("document"."scan_origin" is null or "document"."form_code" is not null or "document"."scan_origin" = 'external_paper' and "document"."review_state" <> 'accepted'));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_scan_review" CHECK (("document"."signed_on" is null) = ("document"."countersigned_on" is null) and ("document"."signed_on" is null) = ("document"."review_confirmations" is null) and ("document"."signed_on" is not null) = ("document"."scan_origin" is not null and "document"."review_state" = 'accepted') and ("document"."review_confirmations" is null or "document"."review_confirmations" @> array['signatures_present', 'all_pages_present']::text[]));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_quarantine" CHECK (("document"."quarantine_reason" is null) = ("document"."quarantined_at" is null) and ("document"."quarantined_at" is null) = ("document"."quarantined_by" is null));