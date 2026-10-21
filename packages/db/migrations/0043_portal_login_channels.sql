ALTER TYPE "public"."audit_event_type" ADD VALUE 'participant_login';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'contact_channel_removed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'consent_ended';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'contact_channels_suspended';--> statement-breakpoint
ALTER TYPE "public"."participant_session_end_reason" ADD VALUE 'lost_access';--> statement-breakpoint
ALTER TYPE "public"."participant_session_end_reason" ADD VALUE 'no_channel';