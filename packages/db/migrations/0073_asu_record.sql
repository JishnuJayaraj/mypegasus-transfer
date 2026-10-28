CREATE TYPE "public"."asu_attestation_source" AS ENUM('ba_document_inspected', 'ba_online_account_inspected', 'ba_confirmed_by_phone');--> statement-breakpoint
CREATE TYPE "public"."asu_channel" AS ENUM('kug_200b', 'online_self', 'in_person');--> statement-breakpoint
CREATE TYPE "public"."asu_proof_kind" AS ENUM('kug200b_submission', 'ba_confirmation', 'ba_customer_number');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'asu_route_set';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'asu_registration_recorded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'asu_proof_linked';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'knowledge_date_set';--> statement-breakpoint
CREATE TABLE "asu_record" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"channel" "asu_channel" NOT NULL,
	"version" integer NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asu_record_version" CHECK ("asu_record"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "asu_registration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"channel" "asu_channel" NOT NULL,
	"registered_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proof_kind" "asu_proof_kind",
	"proof_document_id" uuid,
	"attestation_source" "asu_attestation_source",
	"proof_linked_by" uuid,
	"proof_linked_at" timestamp with time zone,
	CONSTRAINT "asu_registration_participation_unique" UNIQUE("participation_id"),
	CONSTRAINT "asu_registration_proof_document_unique" UNIQUE("proof_document_id"),
	CONSTRAINT "asu_registration_proof_whole" CHECK (("asu_registration"."proof_kind" is null) = ("asu_registration"."proof_linked_at" is null) and ("asu_registration"."proof_linked_at" is null) = ("asu_registration"."proof_linked_by" is null)),
	CONSTRAINT "asu_registration_proof_kind" CHECK (coalesce("asu_registration"."proof_kind" = 'ba_confirmation', false) = ("asu_registration"."proof_document_id" is not null) and coalesce("asu_registration"."proof_kind" = 'ba_customer_number', false) = ("asu_registration"."attestation_source" is not null) and ("asu_registration"."proof_kind" is null or ("asu_registration"."proof_kind" = 'kug200b_submission') = ("asu_registration"."channel" = 'kug_200b'))),
	CONSTRAINT "asu_registration_linked_after" CHECK ("asu_registration"."proof_linked_at" >= "asu_registration"."recorded_at")
);
--> statement-breakpoint
ALTER TABLE "participant_details" ADD COLUMN "knowledge_date" date;--> statement-breakpoint
ALTER TABLE "participant_identifier_data" ADD COLUMN "ba_customer_number" "bytea";--> statement-breakpoint
ALTER TABLE "participant_identifier_data" ADD COLUMN "ba_customer_number_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "asu_record" ADD CONSTRAINT "asu_record_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_record" ADD CONSTRAINT "asu_record_set_by_staff_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_record" ADD CONSTRAINT "asu_record_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_recorded_by_staff_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_proof_document_id_document_id_fk" FOREIGN KEY ("proof_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_proof_linked_by_staff_user_id_fk" FOREIGN KEY ("proof_linked_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asu_registration" ADD CONSTRAINT "asu_registration_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_identifier_data" ADD CONSTRAINT "participant_identifier_data_ba_customer_number_present" CHECK (("participant_identifier_data"."ba_customer_number" is not null) = "participant_identifier_data"."ba_customer_number_present");