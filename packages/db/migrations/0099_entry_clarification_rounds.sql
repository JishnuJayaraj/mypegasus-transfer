ALTER TYPE "public"."audit_event_type" ADD VALUE 'entry_clarification_requested';--> statement-breakpoint
CREATE TABLE "entry_clarification_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"clarification_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"source" text NOT NULL,
	"by" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_clarification_step_seq" UNIQUE("clarification_id","seq"),
	CONSTRAINT "entry_clarification_step_kind" CHECK ("entry_clarification_step"."kind" in ('recorded', 'escalated', 'requested', 'instructed') and "entry_clarification_step"."seq" >= 1 and char_length("entry_clarification_step"."source") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "entry_clarification" DROP CONSTRAINT "entry_clarification_steps";--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD COLUMN "stage" text DEFAULT 'documented' NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The rows of 0098 become the first steps of their history: a note, its escalation, its
-- instruction, in that order. The stage and the revision follow from what the row holds.
UPDATE "entry_clarification" SET
  "stage" = CASE WHEN "instruction_code" IS NOT NULL THEN 'instructed'
    WHEN "escalated_at" IS NOT NULL THEN 'escalated' ELSE 'documented' END,
  "revision" = ("pending_code" IS NOT NULL)::int + ("escalated_at" IS NOT NULL)::int
    + ("instruction_code" IS NOT NULL)::int;--> statement-breakpoint
ALTER TABLE "entry_clarification_step" ADD CONSTRAINT "entry_clarification_step_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification_step" ADD CONSTRAINT "entry_clarification_step_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification_step" ADD CONSTRAINT "entry_clarification_step_clarification_id_entry_clarification_id_fk" FOREIGN KEY ("clarification_id") REFERENCES "public"."entry_clarification"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_clarification_step" ADD CONSTRAINT "entry_clarification_step_by_staff_user_id_fk" FOREIGN KEY ("by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entry_clarification_one_unresolved" ON "entry_clarification" USING btree ("participation_id") WHERE "entry_clarification"."stage" <> 'instructed';--> statement-breakpoint
ALTER TABLE "entry_clarification" ADD CONSTRAINT "entry_clarification_steps" CHECK ((("entry_clarification"."pending_code" is null) = ("entry_clarification"."pending_source" is null))
        and (("entry_clarification"."instruction_code" is null) = ("entry_clarification"."instruction_source" is null))
        and (("entry_clarification"."instruction_code" is null) = ("entry_clarification"."instruction_at" is null))
        and (("entry_clarification"."instruction_code" is null) = ("entry_clarification"."instruction_by" is null))
        and (("entry_clarification"."escalated_at" is null) = ("entry_clarification"."escalated_by" is null))
        and "entry_clarification"."stage" in ('documented', 'escalated', 'returned', 'instructed')
        and ("entry_clarification"."stage" <> 'documented' or ("entry_clarification"."pending_code" is not null and "entry_clarification"."escalated_at" is null and "entry_clarification"."instruction_code" is null))
        and ("entry_clarification"."stage" <> 'returned' or ("entry_clarification"."pending_code" is not null and "entry_clarification"."escalated_at" is null and "entry_clarification"."instruction_code" is null))
        and ("entry_clarification"."stage" <> 'escalated' or ("entry_clarification"."pending_code" is not null and "entry_clarification"."escalated_at" is not null and "entry_clarification"."instruction_code" is null))
        and ("entry_clarification"."stage" <> 'instructed' or ("entry_clarification"."escalated_at" is not null and "entry_clarification"."instruction_code" is not null)));
--> statement-breakpoint
INSERT INTO "entry_clarification_step" ("project_id", "participation_id", "clarification_id", "seq", "kind", "code", "source", "by", "at")
SELECT "project_id", "participation_id", "id", 1, 'recorded', "pending_code", "pending_source", "pending_recorded_by", "pending_recorded_at"
FROM "entry_clarification" WHERE "pending_code" IS NOT NULL;--> statement-breakpoint
INSERT INTO "entry_clarification_step" ("project_id", "participation_id", "clarification_id", "seq", "kind", "code", "source", "by", "at")
SELECT "project_id", "participation_id", "id", 2, 'escalated', "pending_code", "pending_source", "escalated_by", "escalated_at"
FROM "entry_clarification" WHERE "escalated_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "entry_clarification_step" ("project_id", "participation_id", "clarification_id", "seq", "kind", "code", "source", "by", "at")
SELECT "project_id", "participation_id", "id", 3, 'instructed', "instruction_code", "instruction_source", "instruction_by", "instruction_at"
FROM "entry_clarification" WHERE "instruction_code" IS NOT NULL;
