ALTER TYPE "public"."export_kind" ADD VALUE 'kug200b_batch_artifact';--> statement-breakpoint
ALTER TYPE "public"."export_kind" ADD VALUE 'kug200b_batch_scans';--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "t_kug_number" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "employer_betriebsnummer" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "employer_economic_class" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_t_kug_number" CHECK ("project"."t_kug_number" ~ '^[0-9A-Za-z][0-9A-Za-z./-]{0,29}$' and "project"."t_kug_number" !~* '^TK-');--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_employer_betriebsnummer" CHECK ("project"."employer_betriebsnummer" ~ '^[0-9]{8}$');--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_employer_economic_class" CHECK (char_length("project"."employer_economic_class") between 1 and 100 and "project"."employer_economic_class" = btrim("project"."employer_economic_class") and "project"."employer_economic_class" !~ '[[:cntrl:]]');