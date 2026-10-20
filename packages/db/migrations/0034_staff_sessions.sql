CREATE TYPE "public"."staff_audit_event_type" AS ENUM('staff_login', 'staff_logout', 'staff_login_refused', 'staff_identity_bound');--> statement-breakpoint
CREATE TYPE "public"."staff_session_end_reason" AS ENUM('logout', 'deactivated', 'superseded');--> statement-breakpoint
CREATE TABLE "staff_audit_event" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "staff_audit_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" "staff_audit_event_type" NOT NULL,
	"actor_staff_user_id" uuid,
	"subject_staff_user_id" uuid,
	"reason_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	CONSTRAINT "staff_audit_event_shape" CHECK (case "staff_audit_event"."event_type"
        when 'staff_login_refused' then "staff_audit_event"."actor_staff_user_id" is null
          and "staff_audit_event"."reason_code" in ('unknown_account', 'account_deactivated', 'identity_mismatch')
          and ("staff_audit_event"."subject_staff_user_id" is null) = ("staff_audit_event"."reason_code" = 'unknown_account')
        else "staff_audit_event"."actor_staff_user_id" is not null and "staff_audit_event"."subject_staff_user_id" = "staff_audit_event"."actor_staff_user_id"
          and "staff_audit_event"."reason_code" is null
      end),
	CONSTRAINT "staff_audit_event_reason_code_is_code" CHECK ("staff_audit_event"."reason_code" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "staff_audit_event_request_id_is_id" CHECK ("staff_audit_event"."request_id" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
	CONSTRAINT "staff_audit_event_details_ids_and_codes" CHECK (jsonb_typeof("staff_audit_event"."details") = 'object' and not jsonb_path_exists("staff_audit_event"."details", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_.:+-]{1,100}$"))') and not jsonb_path_exists("staff_audit_event"."details", 'strict $.** ? (@.type() == "object").keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9]{0,62}$"))'))
);
--> statement-breakpoint
CREATE TABLE "staff_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" "staff_session_end_reason",
	CONSTRAINT "staff_session_token_hash" CHECK ("staff_session"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "staff_session_lifetime" CHECK ("staff_session"."expires_at" = "staff_session"."created_at" + interval '8 hours'),
	CONSTRAINT "staff_session_ended" CHECK (("staff_session"."ended_at" is null) = ("staff_session"."end_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "staff_user" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "staff_user" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "staff_user" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_audit_event" ADD CONSTRAINT "staff_audit_event_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_audit_event" ADD CONSTRAINT "staff_audit_event_subject_staff_user_id_staff_user_id_fk" FOREIGN KEY ("subject_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_audit_event_subject_seq_idx" ON "staff_audit_event" USING btree ("subject_staff_user_id","seq");--> statement-breakpoint
CREATE INDEX "staff_session_staff_user_idx" ON "staff_session" USING btree ("staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_user_email_lower_key" ON "staff_user" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_oidc_identity_key" UNIQUE("oidc_issuer","oidc_subject");--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_oidc_identity_complete" CHECK (("staff_user"."oidc_issuer" is null) = ("staff_user"."oidc_subject" is null));--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_oidc_issuer_format" CHECK ("staff_user"."oidc_issuer" ~ '^https?://[!-~]{1,255}$' and length("staff_user"."oidc_issuer") <= 263);--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_oidc_subject_format" CHECK ("staff_user"."oidc_subject" ~ '^[!-~]{1,255}$');