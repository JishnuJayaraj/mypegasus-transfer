ALTER TYPE "public"."audit_event_type" ADD VALUE 'legal_hold_placed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'legal_hold_released';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'retention_applied';--> statement-breakpoint
CREATE TABLE "legal_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"classes" text[] NOT NULL,
	"record_kinds" text[] NOT NULL,
	"document_ids" uuid[] NOT NULL,
	"reason" text NOT NULL,
	"basis" text NOT NULL,
	"placed_by" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"release_source" text,
	CONSTRAINT "legal_hold_released" CHECK (("legal_hold"."released_at" is null) = ("legal_hold"."released_by" is null) and ("legal_hold"."released_at" is null) = ("legal_hold"."release_source" is null)),
	CONSTRAINT "legal_hold_scope" CHECK (cardinality("legal_hold"."classes") + cardinality("legal_hold"."record_kinds") + cardinality("legal_hold"."document_ids") > 0 and not "legal_hold"."classes" @> array['personnel_file', 'health_record', 'form_working_copy', 'evidence_set']),
	CONSTRAINT "legal_hold_reason" CHECK ("legal_hold"."reason" in ('litigation', 'authority_request', 'documented_dispute', 'dpo_instruction'))
);
--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "evidence_set_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_placed_by_staff_user_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_released_by_staff_user_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_participation_project_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_hold_participation_idx" ON "legal_hold" USING btree ("participation_id");