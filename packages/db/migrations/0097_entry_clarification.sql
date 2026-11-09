ALTER TYPE "public"."audit_event_type" ADD VALUE 'entry_clarification_recorded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'entry_clarification_escalated';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'entry_clarification_instructed';--> statement-breakpoint
CREATE TABLE "entry_clarification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"opened_on" date NOT NULL,
	"pending_code" text,
	"pending_source" text,
	"pending_recorded_at" timestamp with time zone,
	"pending_recorded_by" uuid,
	"escalated_at" timestamp with time zone,
	"escalated_by" uuid,
	"instruction_code" text,
	"instruction_source" text,
	"instruction_at" timestamp with time zone,
	"instruction_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_clarification_once" UNIQUE("participation_id","opened_on"),
	CONSTRAINT "entry_clarification_codes" CHECK (("entry_clarification"."pending_code" is null or "entry_clarification"."pending_code" in ('awaiting_countersignature', 'awaiting_asu_proof', 'awaiting_profiling', 'awaiting_legal_advice'))
        and ("entry_clarification"."instruction_code" is null or "entry_clarification"."instruction_code" in ('legal_advice_obtained', 'dpo_instruction', 'authority_or_court_decision', 'parties_agreement'))),
	CONSTRAINT "entry_clarification_steps" CHECK ((("entry_clarification"."pending_code" is null) = ("entry_clarification"."pending_source" is null))
        and (("entry_clarification"."instruction_code" is null) = ("entry_clarification"."instruction_source" is null))
        and ("entry_clarification"."escalated_at" is null or "entry_clarification"."pending_code" is not null)
        and ("entry_clarification"."instruction_code" is null or "entry_clarification"."escalated_at" is not null)
        and (("entry_clarification"."instruction_code" is null) = ("entry_clarification"."instruction_at" is null))
        and (("entry_clarification"."instruction_code" is null) = ("entry_clarification"."instruction_by" is null))
        and (("entry_clarification"."escalated_at" is null) = ("entry_clarification"."escalated_by" is null))),
	CONSTRAINT "entry_clarification_sources" CHECK (char_length(coalesce("entry_clarification"."pending_source", '')) <= 200 and char_length(coalesce("entry_clarification"."instruction_source", '')) <= 200)
);
--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD CONSTRAINT "entry_clarification_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD CONSTRAINT "entry_clarification_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD CONSTRAINT "entry_clarification_pending_recorded_by_staff_user_id_fk" FOREIGN KEY ("pending_recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD CONSTRAINT "entry_clarification_escalated_by_staff_user_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD CONSTRAINT "entry_clarification_instruction_by_staff_user_id_fk" FOREIGN KEY ("instruction_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD CONSTRAINT "entry_clarification_participation_project_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;