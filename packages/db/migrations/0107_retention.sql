CREATE TYPE "public"."funded110" AS ENUM('known_yes', 'known_no', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'settlement_dates_set';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'funding_status_set';--> statement-breakpoint
CREATE TABLE "retention_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_day" date NOT NULL,
	"dry_run" boolean NOT NULL,
	"opened_txid" bigint NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"summary" jsonb,
	CONSTRAINT "retention_run_closed" CHECK (("retention_run"."closed_at" is null) = ("retention_run"."summary" is null))
);
--> statement-breakpoint
ALTER TABLE "document" DROP CONSTRAINT "document_deleted";--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "funded110" "funded110" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "funded110_source" text;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "funded110_set_by" uuid;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "funded110_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "kug_final_settlement_date" date;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "measure110_settlement_date" date;--> statement-breakpoint
CREATE INDEX "retention_run_opened_at_idx" ON "retention_run" USING btree ("opened_at");--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_funded110_set_by_staff_user_id_fk" FOREIGN KEY ("funded110_set_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_deleted" CHECK (("document"."deleted_at" is null) = ("document"."deleted_by" is null) and ("document"."deleted_by" is null or "document"."deleted_by" in ('participant', 'user', 'system')) and coalesce("document"."deleted_by" = 'user', false) = ("document"."deleted_by_staff_user_id" is not null) and coalesce("document"."deleted_by" = 'user', false) = ("document"."delete_reason" is not null) and ("document"."deleted_at" is null or "document"."file_name" is null));--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_funded110_recorded" CHECK (("participation"."funded110_set_at" is null) = ("participation"."funded110_set_by" is null) and ("participation"."funded110_set_at" is null) = ("participation"."funded110_source" is null) and ("participation"."funded110_source" is null or char_length("participation"."funded110_source") between 1 and 200 and "participation"."funded110_source" = btrim("participation"."funded110_source") and "participation"."funded110_source" !~ '[[:cntrl:]]'));