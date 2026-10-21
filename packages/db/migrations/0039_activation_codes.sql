CREATE TYPE "public"."activation_channel" AS ENUM('letter', 'sheet', 'in_person');--> statement-breakpoint
CREATE TYPE "public"."activation_delivery_kind" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."activation_delivery_status" AS ENUM('pending', 'sent', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."activation_purpose" AS ENUM('activation', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."activation_revoke_reason" AS ENUM('reissued', 'not_handed_over', 'lost', 'delivery_failed', 'participation_closed');--> statement-breakpoint
CREATE TYPE "public"."identity_check" AS ENUM('none', 'photo_id');--> statement-breakpoint
CREATE TYPE "public"."notice_language" AS ENUM('de', 'en');--> statement-breakpoint
CREATE TYPE "public"."notice_method" AS ENUM('letter', 'sheet', 'email', 'sms', 'in_person_print');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'activation_code_issued';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'activation_code_delivery';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'activation_code_handed_over';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'activation_code_revoked';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'privacy_notice_provided';--> statement-breakpoint
CREATE TABLE "activation_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"purpose" "activation_purpose" DEFAULT 'activation' NOT NULL,
	"code_hash" text NOT NULL,
	"channel" "activation_channel" NOT NULL,
	"notice_language" "notice_language" NOT NULL,
	"identity_check" "identity_check" DEFAULT 'none' NOT NULL,
	"identity_checked_by" uuid,
	"identity_checked_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"handed_over_by" uuid,
	"handed_over_at" timestamp with time zone,
	"delivery_kind" "activation_delivery_kind",
	"delivery_address_hash" text,
	"delivery_status" "activation_delivery_status",
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoke_reason" "activation_revoke_reason",
	"used_at" timestamp with time zone,
	CONSTRAINT "activation_code_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "activation_code_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "activation_code_code_hash" CHECK ("activation_code"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "activation_code_delivery_address_hash" CHECK ("activation_code"."delivery_address_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "activation_code_lifetime" CHECK ("activation_code"."expires_at" = "activation_code"."issued_at" + interval '30 days'),
	CONSTRAINT "activation_code_attempts" CHECK ("activation_code"."failed_attempts" between 0 and 5),
	CONSTRAINT "activation_code_identity_check" CHECK (("activation_code"."identity_check" = 'photo_id') = ("activation_code"."identity_checked_by" is not null) and ("activation_code"."identity_checked_by" is null) = ("activation_code"."identity_checked_at" is null)),
	CONSTRAINT "activation_code_in_person_delivery" CHECK (("activation_code"."channel" = 'in_person') = ("activation_code"."delivery_kind" is not null) and ("activation_code"."delivery_kind" is null) = ("activation_code"."delivery_address_hash" is null) and ("activation_code"."delivery_kind" is null) = ("activation_code"."delivery_status" is null)),
	CONSTRAINT "activation_code_printed" CHECK (("activation_code"."channel" in ('letter', 'sheet')) = ("activation_code"."printed_at" is not null)),
	CONSTRAINT "activation_code_handover" CHECK (("activation_code"."handed_over_at" is null) = ("activation_code"."handed_over_by" is null) and ("activation_code"."handed_over_at" is null or "activation_code"."channel" = 'sheet')),
	CONSTRAINT "activation_code_revoked" CHECK (("activation_code"."revoked_at" is null) = ("activation_code"."revoke_reason" is null) and ("activation_code"."revoked_at" is null or "activation_code"."revoked_by" is not null or "activation_code"."revoke_reason" = 'participation_closed')),
	CONSTRAINT "activation_code_one_terminal" CHECK (num_nonnulls("activation_code"."locked_at", "activation_code"."revoked_at", "activation_code"."used_at") <= 1)
);
--> statement-breakpoint
CREATE TABLE "privacy_notice_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"notice_version" text NOT NULL,
	"language" "notice_language" NOT NULL,
	"method" "notice_method" NOT NULL,
	"activation_code_id" uuid,
	"provided_by" uuid NOT NULL,
	"provided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_notice_delivery_version" CHECK ("privacy_notice_delivery"."notice_version" ~ '^[a-z][a-z0-9-]{0,40}:v[1-9][0-9]*$')
);
--> statement-breakpoint
ALTER TABLE "activation_code" ADD CONSTRAINT "activation_code_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_code" ADD CONSTRAINT "activation_code_identity_checked_by_staff_user_id_fk" FOREIGN KEY ("identity_checked_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_code" ADD CONSTRAINT "activation_code_handed_over_by_staff_user_id_fk" FOREIGN KEY ("handed_over_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_code" ADD CONSTRAINT "activation_code_issued_by_staff_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_code" ADD CONSTRAINT "activation_code_revoked_by_staff_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_code" ADD CONSTRAINT "activation_code_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_notice_delivery" ADD CONSTRAINT "privacy_notice_delivery_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_notice_delivery" ADD CONSTRAINT "privacy_notice_delivery_provided_by_staff_user_id_fk" FOREIGN KEY ("provided_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_notice_delivery" ADD CONSTRAINT "privacy_notice_delivery_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_notice_delivery" ADD CONSTRAINT "privacy_notice_delivery_activation_code_fk" FOREIGN KEY ("activation_code_id","project_id") REFERENCES "public"."activation_code"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_code_one_open_idx" ON "activation_code" USING btree ("participation_id") WHERE "activation_code"."revoked_at" is null and "activation_code"."used_at" is null and "activation_code"."locked_at" is null;--> statement-breakpoint
CREATE INDEX "activation_code_participation_issued_idx" ON "activation_code" USING btree ("participation_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "privacy_notice_delivery_participation_idx" ON "privacy_notice_delivery" USING btree ("participation_id","provided_at");