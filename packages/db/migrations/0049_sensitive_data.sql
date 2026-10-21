CREATE TYPE "public"."sensitive_step_up_method" AS ENUM('birth_date', 'photo_id_and_code');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'step_up_completed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'step_up_failed';--> statement-breakpoint
ALTER TYPE "public"."one_time_code_purpose" ADD VALUE 'step_up';--> statement-breakpoint
ALTER TYPE "public"."participant_session_end_reason" ADD VALUE 'step_up_failed';--> statement-breakpoint
CREATE TABLE "participant_health_data" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"health_restrictions" "bytea",
	"health_restrictions_present" boolean DEFAULT false NOT NULL,
	"severe_disability" "bytea",
	"severe_disability_present" boolean DEFAULT false NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_health_data_key_id" CHECK ("participant_health_data"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "participant_health_data_health_restrictions_present" CHECK (("participant_health_data"."health_restrictions" is not null) = "participant_health_data"."health_restrictions_present"),
	CONSTRAINT "participant_health_data_severe_disability_present" CHECK (("participant_health_data"."severe_disability" is not null) = "participant_health_data"."severe_disability_present")
);
--> statement-breakpoint
CREATE TABLE "participant_identifier_data" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"pension_insurance_number" "bytea",
	"pension_insurance_number_present" boolean DEFAULT false NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_identifier_data_key_id" CHECK ("participant_identifier_data"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "participant_identifier_data_pension_insurance_number_present" CHECK (("participant_identifier_data"."pension_insurance_number" is not null) = "participant_identifier_data"."pension_insurance_number_present")
);
--> statement-breakpoint
CREATE TABLE "participant_residence_social_data" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"nationality" "bytea",
	"nationality_present" boolean DEFAULT false NOT NULL,
	"entry_to_germany_date" "bytea",
	"entry_to_germany_date_present" boolean DEFAULT false NOT NULL,
	"residence_status" "bytea",
	"residence_status_present" boolean DEFAULT false NOT NULL,
	"buergergeld" "bytea",
	"buergergeld_present" boolean DEFAULT false NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_residence_social_data_key_id" CHECK ("participant_residence_social_data"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "participant_residence_social_data_nationality_present" CHECK (("participant_residence_social_data"."nationality" is not null) = "participant_residence_social_data"."nationality_present"),
	CONSTRAINT "participant_residence_social_data_entry_to_germany_date_present" CHECK (("participant_residence_social_data"."entry_to_germany_date" is not null) = "participant_residence_social_data"."entry_to_germany_date_present"),
	CONSTRAINT "participant_residence_social_data_residence_status_present" CHECK (("participant_residence_social_data"."residence_status" is not null) = "participant_residence_social_data"."residence_status_present"),
	CONSTRAINT "participant_residence_social_data_buergergeld_present" CHECK (("participant_residence_social_data"."buergergeld" is not null) = "participant_residence_social_data"."buergergeld_present")
);
--> statement-breakpoint
ALTER TABLE "participant_session" ADD COLUMN "sensitive_step_up_method" "sensitive_step_up_method";--> statement-breakpoint
ALTER TABLE "participant_session" ADD COLUMN "sensitive_step_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participant_session" ADD COLUMN "step_up_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_health_data" ADD CONSTRAINT "participant_health_data_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_health_data" ADD CONSTRAINT "participant_health_data_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_identifier_data" ADD CONSTRAINT "participant_identifier_data_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_identifier_data" ADD CONSTRAINT "participant_identifier_data_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_residence_social_data" ADD CONSTRAINT "participant_residence_social_data_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_residence_social_data" ADD CONSTRAINT "participant_residence_social_data_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_session" ADD CONSTRAINT "participant_session_sensitive_step_up" CHECK (("participant_session"."sensitive_step_up_method" is null) = ("participant_session"."sensitive_step_up_at" is null) and ("participant_session"."state" = 'active' or "participant_session"."sensitive_step_up_method" is null));--> statement-breakpoint
ALTER TABLE "participant_session" ADD CONSTRAINT "participant_session_step_up_failures" CHECK ("participant_session"."step_up_failures" between 0 and 5);