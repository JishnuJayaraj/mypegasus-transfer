CREATE TYPE "public"."jobboerse_choice" AS ENUM('full', 'anonymous_callme', 'anonymous_no_contact', 'none');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'profiling_session_changed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'profiling_declarations_recorded';--> statement-breakpoint
CREATE TABLE "participant_profiling" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"jobboerse_choice" "jobboerse_choice",
	"ba_contact_consent" boolean,
	"declarations_recorded_by" uuid,
	"declarations_recorded_at" timestamp with time zone,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_profiling_revision" CHECK ("participant_profiling"."revision" >= 1),
	CONSTRAINT "participant_profiling_declarations_recorded" CHECK (("participant_profiling"."declarations_recorded_by" is null) = ("participant_profiling"."declarations_recorded_at" is null))
);
--> statement-breakpoint
CREATE TABLE "participant_profiling_assessment" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"school_qualification" "bytea",
	"school_qualification_present" boolean DEFAULT false NOT NULL,
	"vocational_qualification" "bytea",
	"vocational_qualification_present" boolean DEFAULT false NOT NULL,
	"work_experience" "bytea",
	"work_experience_present" boolean DEFAULT false NOT NULL,
	"language_skills" "bytea",
	"language_skills_present" boolean DEFAULT false NOT NULL,
	"other_qualification" "bytea",
	"other_qualification_present" boolean DEFAULT false NOT NULL,
	"intellectual_capacity" "bytea",
	"intellectual_capacity_present" boolean DEFAULT false NOT NULL,
	"work_and_social_behaviour" "bytea",
	"work_and_social_behaviour_present" boolean DEFAULT false NOT NULL,
	"other_performance" "bytea",
	"other_performance_present" boolean DEFAULT false NOT NULL,
	"initiative" "bytea",
	"initiative_present" boolean DEFAULT false NOT NULL,
	"learning_readiness" "bytea",
	"learning_readiness_present" boolean DEFAULT false NOT NULL,
	"other_motivation" "bytea",
	"other_motivation_present" boolean DEFAULT false NOT NULL,
	"local_mobility" "bytea",
	"local_mobility_present" boolean DEFAULT false NOT NULL,
	"other_conditions" "bytea",
	"other_conditions_present" boolean DEFAULT false NOT NULL,
	"overall_assessment" "bytea",
	"overall_assessment_present" boolean DEFAULT false NOT NULL,
	"next_steps" "bytea",
	"next_steps_present" boolean DEFAULT false NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "participant_profiling_assessment_key_id" CHECK ("participant_profiling_assessment"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "participant_profiling_assessment_school_qualification_present" CHECK (("participant_profiling_assessment"."school_qualification" is not null) = "participant_profiling_assessment"."school_qualification_present"),
	CONSTRAINT "participant_profiling_assessment_vocational_qualification_present" CHECK (("participant_profiling_assessment"."vocational_qualification" is not null) = "participant_profiling_assessment"."vocational_qualification_present"),
	CONSTRAINT "participant_profiling_assessment_work_experience_present" CHECK (("participant_profiling_assessment"."work_experience" is not null) = "participant_profiling_assessment"."work_experience_present"),
	CONSTRAINT "participant_profiling_assessment_language_skills_present" CHECK (("participant_profiling_assessment"."language_skills" is not null) = "participant_profiling_assessment"."language_skills_present"),
	CONSTRAINT "participant_profiling_assessment_other_qualification_present" CHECK (("participant_profiling_assessment"."other_qualification" is not null) = "participant_profiling_assessment"."other_qualification_present"),
	CONSTRAINT "participant_profiling_assessment_intellectual_capacity_present" CHECK (("participant_profiling_assessment"."intellectual_capacity" is not null) = "participant_profiling_assessment"."intellectual_capacity_present"),
	CONSTRAINT "participant_profiling_assessment_work_and_social_behaviour_present" CHECK (("participant_profiling_assessment"."work_and_social_behaviour" is not null) = "participant_profiling_assessment"."work_and_social_behaviour_present"),
	CONSTRAINT "participant_profiling_assessment_other_performance_present" CHECK (("participant_profiling_assessment"."other_performance" is not null) = "participant_profiling_assessment"."other_performance_present"),
	CONSTRAINT "participant_profiling_assessment_initiative_present" CHECK (("participant_profiling_assessment"."initiative" is not null) = "participant_profiling_assessment"."initiative_present"),
	CONSTRAINT "participant_profiling_assessment_learning_readiness_present" CHECK (("participant_profiling_assessment"."learning_readiness" is not null) = "participant_profiling_assessment"."learning_readiness_present"),
	CONSTRAINT "participant_profiling_assessment_other_motivation_present" CHECK (("participant_profiling_assessment"."other_motivation" is not null) = "participant_profiling_assessment"."other_motivation_present"),
	CONSTRAINT "participant_profiling_assessment_local_mobility_present" CHECK (("participant_profiling_assessment"."local_mobility" is not null) = "participant_profiling_assessment"."local_mobility_present"),
	CONSTRAINT "participant_profiling_assessment_other_conditions_present" CHECK (("participant_profiling_assessment"."other_conditions" is not null) = "participant_profiling_assessment"."other_conditions_present"),
	CONSTRAINT "participant_profiling_assessment_overall_assessment_present" CHECK (("participant_profiling_assessment"."overall_assessment" is not null) = "participant_profiling_assessment"."overall_assessment_present"),
	CONSTRAINT "participant_profiling_assessment_next_steps_present" CHECK (("participant_profiling_assessment"."next_steps" is not null) = "participant_profiling_assessment"."next_steps_present"),
	CONSTRAINT "participant_profiling_assessment_revision" CHECK ("participant_profiling_assessment"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "participant_profiling_health_assessment" (
	"participation_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"health_rating" "bytea",
	"health_rating_present" boolean DEFAULT false NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_profiling_health_assessment_key_id" CHECK ("participant_profiling_health_assessment"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "participant_profiling_health_assessment_health_rating_present" CHECK (("participant_profiling_health_assessment"."health_rating" is not null) = "participant_profiling_health_assessment"."health_rating_present")
);
--> statement-breakpoint
CREATE TABLE "profiling_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"session_date" date NOT NULL,
	"time_from" text NOT NULL,
	"time_to" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiling_session_time_from" CHECK ("profiling_session"."time_from" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "profiling_session_time_to" CHECK ("profiling_session"."time_to" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "profiling_session_times_ordered" CHECK ("profiling_session"."time_from" < "profiling_session"."time_to")
);
--> statement-breakpoint
ALTER TABLE "participant_residence_social_data" ADD COLUMN "unemployment_period" "bytea";--> statement-breakpoint
ALTER TABLE "participant_residence_social_data" ADD COLUMN "unemployment_period_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_profiling" ADD CONSTRAINT "participant_profiling_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_profiling" ADD CONSTRAINT "participant_profiling_declarations_recorded_by_staff_user_id_fk" FOREIGN KEY ("declarations_recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_profiling" ADD CONSTRAINT "participant_profiling_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_profiling_assessment" ADD CONSTRAINT "participant_profiling_assessment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_profiling_assessment" ADD CONSTRAINT "participant_profiling_assessment_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_profiling_health_assessment" ADD CONSTRAINT "participant_profiling_health_assessment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_profiling_health_assessment" ADD CONSTRAINT "participant_profiling_health_assessment_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_session" ADD CONSTRAINT "profiling_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_session" ADD CONSTRAINT "profiling_session_recorded_by_staff_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_session" ADD CONSTRAINT "profiling_session_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profiling_session_participation_idx" ON "profiling_session" USING btree ("participation_id","session_date");--> statement-breakpoint
ALTER TABLE "participant_residence_social_data" ADD CONSTRAINT "participant_residence_social_data_unemployment_period_present" CHECK (("participant_residence_social_data"."unemployment_period" is not null) = "participant_residence_social_data"."unemployment_period_present");