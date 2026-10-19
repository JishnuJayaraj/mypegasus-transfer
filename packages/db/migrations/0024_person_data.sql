ALTER TYPE "public"."audit_event_type" ADD VALUE 'participant_data_changed';--> statement-breakpoint
CREATE TABLE "participant_details" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"address_street" text,
	"address_postal_code" text,
	"address_city" text,
	"address_country" text,
	"phone" text,
	"mobile" text,
	"private_email" text,
	"work_email" text,
	"old_employment_end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_details_address_whole" CHECK (num_nulls("participant_details"."address_street", "participant_details"."address_postal_code", "participant_details"."address_city", "participant_details"."address_country") in (0, 4)),
	CONSTRAINT "participant_details_address_street_text" CHECK ("participant_details"."address_street" = btrim("participant_details"."address_street") and length("participant_details"."address_street") between 1 and 200 and "participant_details"."address_street" !~ '[[:cntrl:]]'),
	CONSTRAINT "participant_details_address_city_text" CHECK ("participant_details"."address_city" = btrim("participant_details"."address_city") and length("participant_details"."address_city") between 1 and 200 and "participant_details"."address_city" !~ '[[:cntrl:]]'),
	CONSTRAINT "participant_details_address_country_code" CHECK ("participant_details"."address_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "participant_details_address_country_de" CHECK ("participant_details"."address_country" = 'DE'),
	CONSTRAINT "participant_details_postal_code_de" CHECK ("participant_details"."address_country" <> 'DE' or "participant_details"."address_postal_code" ~ '^[0-9]{5}$'),
	CONSTRAINT "participant_details_phone_text" CHECK ("participant_details"."phone" = btrim("participant_details"."phone") and length("participant_details"."phone") between 1 and 30 and "participant_details"."phone" !~ '[[:cntrl:]]'),
	CONSTRAINT "participant_details_mobile_text" CHECK ("participant_details"."mobile" = btrim("participant_details"."mobile") and length("participant_details"."mobile") between 1 and 30 and "participant_details"."mobile" !~ '[[:cntrl:]]'),
	CONSTRAINT "participant_details_private_email_text" CHECK ("participant_details"."private_email" = btrim("participant_details"."private_email") and length("participant_details"."private_email") between 1 and 254 and "participant_details"."private_email" !~ '[[:cntrl:]]'),
	CONSTRAINT "participant_details_work_email_text" CHECK ("participant_details"."work_email" = btrim("participant_details"."work_email") and length("participant_details"."work_email") between 1 and 254 and "participant_details"."work_email" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "participant_identity" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"personnel_number" text NOT NULL,
	"last_name" text NOT NULL,
	"first_name" text NOT NULL,
	"birth_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_identity_project_personnel_number_unique" UNIQUE("project_id","personnel_number"),
	CONSTRAINT "participant_identity_personnel_number_text" CHECK ("participant_identity"."personnel_number" = btrim("participant_identity"."personnel_number") and length("participant_identity"."personnel_number") between 1 and 50 and "participant_identity"."personnel_number" !~ '[[:cntrl:]]'),
	CONSTRAINT "participant_identity_last_name_text" CHECK ("participant_identity"."last_name" = btrim("participant_identity"."last_name") and length("participant_identity"."last_name") between 1 and 100 and "participant_identity"."last_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "participant_identity_first_name_text" CHECK ("participant_identity"."first_name" = btrim("participant_identity"."first_name") and length("participant_identity"."first_name") between 1 and 100 and "participant_identity"."first_name" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_lifecycle_has_participation";--> statement-breakpoint
ALTER TABLE "participant_details" ADD CONSTRAINT "participant_details_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_details" ADD CONSTRAINT "participant_details_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_identity" ADD CONSTRAINT "participant_identity_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_identity" ADD CONSTRAINT "participant_identity_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_lifecycle_has_participation" CHECK ("audit_event"."participation_id" is not null or "audit_event"."event_type"::text not in ('participation_created', 'status_changed', 'entry_wave_assigned', 'profiling_exception_requested', 'profiling_exception_approved', 'profiling_exception_rejected', 'profiling_exception_revoked', 'profiling_exception_superseded', 'end_reason_corrected', 'participant_data_changed', 'sensitive_read', 'sensitive_write', 'break_glass_access', 'document_opened'));