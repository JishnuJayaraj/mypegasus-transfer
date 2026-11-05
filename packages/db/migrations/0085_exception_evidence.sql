CREATE TYPE "public"."exception_evidence_kind" AS ENUM('documents', 'ba_confirmation');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'exception_evidence_recorded';--> statement-breakpoint
CREATE TABLE "profiling_exception_evidence_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"kind" "exception_evidence_kind" NOT NULL,
	"document_ids" uuid[],
	"agentur_key" text,
	"reference" text,
	"confirmed_on" date,
	"fingerprint" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiling_exception_evidence_record_id_participation_unique" UNIQUE("id","participation_id"),
	CONSTRAINT "profiling_exception_evidence_record_fingerprint" CHECK ("profiling_exception_evidence_record"."fingerprint" ~ '^sha256:v1:[0-9a-f]{64}$'),
	CONSTRAINT "profiling_exception_evidence_record_source" CHECK (case "profiling_exception_evidence_record"."kind"::text
        when 'documents' then "profiling_exception_evidence_record"."document_ids" is not null
          and cardinality("profiling_exception_evidence_record"."document_ids") between 1 and 20
          and "profiling_exception_evidence_record"."agentur_key" is null and "profiling_exception_evidence_record"."reference" is null and "profiling_exception_evidence_record"."confirmed_on" is null
        else "profiling_exception_evidence_record"."document_ids" is null and "profiling_exception_evidence_record"."agentur_key" is not null
          and "profiling_exception_evidence_record"."reference" is not null and "profiling_exception_evidence_record"."confirmed_on" is not null end),
	CONSTRAINT "profiling_exception_evidence_record_agentur_key" CHECK ("profiling_exception_evidence_record"."agentur_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "profiling_exception_evidence_record_reference" CHECK (char_length("profiling_exception_evidence_record"."reference") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "profiling_exception_evidence_record" ADD CONSTRAINT "profiling_exception_evidence_record_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_exception_evidence_record" ADD CONSTRAINT "profiling_exception_evidence_record_created_by_staff_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_exception_evidence_record" ADD CONSTRAINT "profiling_exception_evidence_record_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profiling_exception_evidence_record_participation_idx" ON "profiling_exception_evidence_record" USING btree ("participation_id");--> statement-breakpoint
ALTER TABLE "profiling_exception_request" ADD CONSTRAINT "profiling_exception_request_evidence_fk" FOREIGN KEY ("evidence_record_id","participation_id") REFERENCES "public"."profiling_exception_evidence_record"("id","participation_id") ON DELETE no action ON UPDATE no action;