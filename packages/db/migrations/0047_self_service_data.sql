CREATE TYPE "public"."consent_source" AS ENUM('portal', 'paper_form');--> statement-breakpoint
CREATE TYPE "public"."driving_licence_class" AS ENUM('AM', 'A1', 'A2', 'A', 'B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE', 'L', 'T');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'diverse', 'not_specified');--> statement-breakpoint
CREATE TYPE "public"."marital_status" AS ENUM('single', 'married');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'self_service_notice_acknowledged';--> statement-breakpoint
ALTER TYPE "public"."consent_purpose" ADD VALUE 'kug200b_profile_access';--> statement-breakpoint
CREATE TABLE "participant_profile" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"gender" "gender",
	"marital_status" "marital_status",
	"education_history" jsonb,
	"work_history" jsonb,
	"language_skills" jsonb,
	"driving_licence" "driving_licence_class"[],
	"vehicle_available" boolean,
	"working_time_preferences" jsonb,
	"job_wishes" jsonb,
	"desired_work_locations" text,
	"max_commute_distance" jsonb,
	"earliest_start_date" date,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_profile_revision" CHECK ("participant_profile"."revision" >= 1),
	CONSTRAINT "participant_profile_education_history" CHECK (jsonb_typeof("participant_profile"."education_history") = 'array' and jsonb_array_length("participant_profile"."education_history") between 1 and 20),
	CONSTRAINT "participant_profile_work_history" CHECK (jsonb_typeof("participant_profile"."work_history") = 'array' and jsonb_array_length("participant_profile"."work_history") between 1 and 20),
	CONSTRAINT "participant_profile_language_skills" CHECK (jsonb_typeof("participant_profile"."language_skills") = 'object'),
	CONSTRAINT "participant_profile_working_time" CHECK (jsonb_typeof("participant_profile"."working_time_preferences") = 'object'),
	CONSTRAINT "participant_profile_job_wishes" CHECK (jsonb_typeof("participant_profile"."job_wishes") = 'object'),
	CONSTRAINT "participant_profile_max_commute_distance" CHECK (jsonb_typeof("participant_profile"."max_commute_distance") = 'object'),
	CONSTRAINT "participant_profile_custom_fields" CHECK (jsonb_typeof("participant_profile"."custom_fields") = 'object'),
	CONSTRAINT "participant_profile_driving_licence" CHECK (array_position("participant_profile"."driving_licence", null) is null),
	CONSTRAINT "participant_profile_desired_work_locations_text" CHECK ("participant_profile"."desired_work_locations" = btrim("participant_profile"."desired_work_locations") and length("participant_profile"."desired_work_locations") between 1 and 500 and "participant_profile"."desired_work_locations" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "self_service_notice_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"notice_version" text NOT NULL,
	"language" "notice_language" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_staff_user_id" uuid,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_service_notice_acknowledgement_version_unique" UNIQUE("participation_id","notice_version"),
	CONSTRAINT "self_service_notice_acknowledgement_version" CHECK ("self_service_notice_acknowledgement"."notice_version" ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$'),
	CONSTRAINT "self_service_notice_acknowledgement_actor" CHECK ("self_service_notice_acknowledgement"."actor_type" in ('participant', 'user') and ("self_service_notice_acknowledgement"."actor_type" = 'user') = ("self_service_notice_acknowledgement"."actor_staff_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "consent_record" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_record" ADD COLUMN "source" "consent_source" DEFAULT 'portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_details" ADD COLUMN "participant_maintained" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_details" ADD COLUMN "participant_address_written_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participant_profile" ADD CONSTRAINT "participant_profile_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_profile" ADD CONSTRAINT "participant_profile_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_service_notice_acknowledgement" ADD CONSTRAINT "self_service_notice_acknowledgement_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_service_notice_acknowledgement" ADD CONSTRAINT "self_service_notice_acknowledgement_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_service_notice_acknowledgement" ADD CONSTRAINT "self_service_notice_acknowledgement_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_channel" CHECK (("consent_record"."purpose" = 'portal_contact') = ("consent_record"."channel_id" is not null) and ("consent_record"."purpose" <> 'portal_contact' or "consent_record"."source" = 'portal'));--> statement-breakpoint
ALTER TABLE "participant_details" ADD CONSTRAINT "participant_details_participant_maintained" CHECK ("participant_details"."participant_maintained" <@ '{address,phone,mobile,privateEmail}'::text[] and array_position("participant_details"."participant_maintained", null) is null);--> statement-breakpoint
ALTER TABLE "participant_details" ADD CONSTRAINT "participant_details_address_written" CHECK ("participant_details"."participant_address_written_at" is null or 'address' = any("participant_details"."participant_maintained"));