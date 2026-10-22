CREATE TYPE "public"."document_delete_reason" AS ENUM('wrong_person', 'wrong_file', 'duplicate', 'participant_request');--> statement-breakpoint
CREATE TYPE "public"."document_media_type" AS ENUM('application/pdf', 'image/jpeg', 'image/png');--> statement-breakpoint
CREATE TYPE "public"."document_review_reason" AS ENUM('unreadable', 'wrong_document', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."document_review_state" AS ENUM('unreviewed', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."document_session_kind" AS ENUM('staff', 'participant');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('tl407_signed_scan', 'kug200b_signed_scan', 'dsv_signed_scan', 'dsv_cancellation', 'asu_proof', 'profiling_exception_evidence', 'cv', 'participant_upload', 'qualification_certificate');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'document_added';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'document_reviewed';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'document_deleted';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'document_upload_rejected';--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"type" "document_type" NOT NULL,
	"catalog_version" integer NOT NULL,
	"retention_class" text NOT NULL,
	"media_type" "document_media_type" NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"file_name" text,
	"key_id" text NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"added_by" "actor_type" NOT NULL,
	"added_by_staff_user_id" uuid,
	"added_on_behalf" boolean NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_state" "document_review_state" DEFAULT 'unreviewed' NOT NULL,
	"review_reason" "document_review_reason",
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" "actor_type",
	"deleted_by_staff_user_id" uuid,
	"delete_reason" "document_delete_reason",
	"purged_at" timestamp with time zone,
	CONSTRAINT "document_size" CHECK ("document"."size_bytes" between 1 and 10485760),
	CONSTRAINT "document_content_sha256" CHECK ("document"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_key_id" CHECK ("document"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "document_wrapped_key" CHECK (octet_length("document"."wrapped_key") = 60),
	CONSTRAINT "document_file_name" CHECK (char_length("document"."file_name") between 1 and 200),
	CONSTRAINT "document_added_by" CHECK ("document"."added_by" in ('participant', 'user') and ("document"."added_by" = 'user') = ("document"."added_by_staff_user_id" is not null) and ("document"."added_by" = 'user' or not "document"."added_on_behalf")),
	CONSTRAINT "document_review" CHECK (("document"."review_state" = 'rejected') = ("document"."review_reason" is not null) and ("document"."review_state" = 'unreviewed') = ("document"."reviewed_at" is null) and ("document"."reviewed_at" is null) = ("document"."reviewed_by" is null)),
	CONSTRAINT "document_deleted" CHECK (("document"."deleted_at" is null) = ("document"."deleted_by" is null) and ("document"."deleted_by" is null or "document"."deleted_by" in ('participant', 'user')) and coalesce("document"."deleted_by" = 'user', false) = ("document"."deleted_by_staff_user_id" is not null) and coalesce("document"."deleted_by" = 'user', false) = ("document"."delete_reason" is not null) and ("document"."deleted_at" is null or "document"."file_name" is null)),
	CONSTRAINT "document_purged" CHECK ("document"."purged_at" is null or "document"."deleted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "document_link" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"session_kind" "document_session_kind" NOT NULL,
	"session_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_link_token_hash" CHECK ("document_link"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_link_session_hash" CHECK ("document_link"."session_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_link_expires" CHECK ("document_link"."expires_at" > "document_link"."created_at")
);
--> statement-breakpoint
CREATE TABLE "document_type_policy" (
	"type" "document_type" NOT NULL,
	"catalog_version" integer NOT NULL,
	"retention_class" text NOT NULL,
	"file_name" boolean NOT NULL,
	"signed" boolean NOT NULL,
	"add_roles" text[] NOT NULL,
	"review_roles" text[] NOT NULL,
	"delete_roles" text[] NOT NULL,
	"open_roles" text[] NOT NULL,
	CONSTRAINT "document_type_policy_pkey" PRIMARY KEY("type","catalog_version"),
	CONSTRAINT "document_type_policy_retention_unique" UNIQUE("type","catalog_version","retention_class")
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_added_by_staff_user_id_staff_user_id_fk" FOREIGN KEY ("added_by_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_reviewed_by_staff_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_deleted_by_staff_user_id_staff_user_id_fk" FOREIGN KEY ("deleted_by_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_policy_fk" FOREIGN KEY ("type","catalog_version","retention_class") REFERENCES "public"."document_type_policy"("type","catalog_version","retention_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_participation_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_participation_idx" ON "document" USING btree ("participation_id","added_at");--> statement-breakpoint
CREATE INDEX "document_link_document_idx" ON "document_link" USING btree ("document_id");