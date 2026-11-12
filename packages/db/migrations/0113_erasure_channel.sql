ALTER TYPE "public"."channel_removal_reason" ADD VALUE 'retention_erasure';--> statement-breakpoint
ALTER TABLE "participant_channel" ALTER COLUMN "address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participant_channel" ADD CONSTRAINT "participant_channel_address_retained" CHECK ("participant_channel"."address" is not null or "participant_channel"."removed_at" is not null);