ALTER TABLE "project" DROP CONSTRAINT "project_tg_dates_ordered";--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT "project_ta_only_has_no_tg_dates";--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "signing_deadline";--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "default_tg_start";--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "default_tg_end";