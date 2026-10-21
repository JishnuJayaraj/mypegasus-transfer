ALTER TYPE "public"."audit_event_type" ADD VALUE 'placement_agentur_set';--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "placement_agentur_key" text;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "placement_agentur_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_placement_agentur_key_format" CHECK ("participation"."placement_agentur_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_placement_agentur_set_at_with_key" CHECK ((placement_agentur_key is not null) = ("placement_agentur_set_at" is not null));