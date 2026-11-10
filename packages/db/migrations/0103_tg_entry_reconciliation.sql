ALTER TYPE "public"."audit_event_type" ADD VALUE 'tg_entry_reconciled';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'reconciliation_reviewed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'reconciliation_replied';--> statement-breakpoint
CREATE TABLE "tg_entry_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"evidence" jsonb NOT NULL,
	"confirmed" boolean NOT NULL,
	"reconciled_by" uuid NOT NULL,
	"reconciled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_event_id" uuid,
	"stage" text DEFAULT 'requested' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tg_entry_reconciliation_once" UNIQUE("participation_id"),
	CONSTRAINT "tg_entry_reconciliation_valid" CHECK ("tg_entry_reconciliation"."confirmed" and jsonb_typeof("tg_entry_reconciliation"."evidence") = 'array'
        and jsonb_array_length("tg_entry_reconciliation"."evidence") between 1 and 3 and "tg_entry_reconciliation"."revision" >= 0
        and "tg_entry_reconciliation"."stage" in ('requested', 'no_objection', 'clarification_requested', 'replied', 'escalated_to_dpo', 'resolved_no_objection'))
);
--> statement-breakpoint
CREATE TABLE "tg_entry_reconciliation_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"code" text,
	"source" text,
	"by" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_entry_reconciliation_step_seq" UNIQUE("reconciliation_id","seq"),
	CONSTRAINT "tg_entry_reconciliation_step_kind" CHECK ("tg_entry_reconciliation_step"."seq" >= 1 and (
        ("tg_entry_reconciliation_step"."kind" = 'no_objection' and "tg_entry_reconciliation_step"."code" is null and "tg_entry_reconciliation_step"."source" is null)
        or ("tg_entry_reconciliation_step"."kind" = 'clarification_requested' and "tg_entry_reconciliation_step"."code" in ('evidence_unclear', 'date_unclear', 'other_documented'))
        or ("tg_entry_reconciliation_step"."kind" = 'replied' and "tg_entry_reconciliation_step"."code" in ('evidence_supplemented', 'explained', 'correction_requested'))
        or ("tg_entry_reconciliation_step"."kind" in ('resolved_no_objection', 'escalated_to_dpo') and "tg_entry_reconciliation_step"."code" is null))
        and ("tg_entry_reconciliation_step"."kind" = 'no_objection' or char_length("tg_entry_reconciliation_step"."source") between 1 and 200))
);
--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation" ADD CONSTRAINT "tg_entry_reconciliation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation" ADD CONSTRAINT "tg_entry_reconciliation_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation" ADD CONSTRAINT "tg_entry_reconciliation_reconciled_by_staff_user_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation" ADD CONSTRAINT "tg_entry_reconciliation_participation_project_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation_step" ADD CONSTRAINT "tg_entry_reconciliation_step_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation_step" ADD CONSTRAINT "tg_entry_reconciliation_step_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation_step" ADD CONSTRAINT "tg_entry_reconciliation_step_reconciliation_id_tg_entry_reconciliation_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."tg_entry_reconciliation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_entry_reconciliation_step" ADD CONSTRAINT "tg_entry_reconciliation_step_by_staff_user_id_fk" FOREIGN KEY ("by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;