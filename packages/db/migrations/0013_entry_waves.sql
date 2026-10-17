ALTER TYPE "public"."audit_event_type" ADD VALUE 'entry_wave_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'entry_wave_changed';--> statement-breakpoint
ALTER TABLE "project_entry_wave" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "project_entry_wave" ADD CONSTRAINT "project_entry_wave_signing_before_start" CHECK ("project_entry_wave"."signing_deadline" <= "project_entry_wave"."default_tg_start");--> statement-breakpoint
ALTER TABLE "project_entry_wave" ADD CONSTRAINT "project_entry_wave_signing_before_latest_entry" CHECK ("project_entry_wave"."signing_deadline" <= "project_entry_wave"."latest_entry_date");--> statement-breakpoint
ALTER TABLE "project_entry_wave" ADD CONSTRAINT "project_entry_wave_start_before_latest_entry" CHECK ("project_entry_wave"."default_tg_start" <= "project_entry_wave"."latest_entry_date");