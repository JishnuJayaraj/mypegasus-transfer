CREATE TYPE "public"."access_category" AS ENUM('case_internal', 'confidential', 'health', 'disability', 'identifiers', 'residence_social', 'profiling_assessment', 'signed_tl407', 'signed_kug200b', 'employment_contract', 'absence');--> statement-breakpoint
CREATE TYPE "public"."audit_stream" AS ENUM('case', 'profiling', 'dsv', 'payroll', 'security', 'review');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'audit_history_opened';--> statement-breakpoint
CREATE TABLE "audit_event_projection" (
	"event_type" text NOT NULL,
	"field" "status_field",
	"stream" "audit_stream",
	"shows_change" boolean NOT NULL,
	"shows_reason" boolean NOT NULL,
	"detail_keys" text[] NOT NULL,
	CONSTRAINT "audit_event_projection_unique" UNIQUE NULLS NOT DISTINCT("event_type","field"),
	CONSTRAINT "audit_event_projection_event_type" CHECK ("audit_event_projection"."event_type" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "audit_event_projection_field" CHECK (("audit_event_projection"."field" is null) = ("audit_event_projection"."event_type" <> 'status_changed'))
);
--> statement-breakpoint
CREATE TABLE "field_access_category" (
	"field_key" text PRIMARY KEY NOT NULL,
	"access_category" "access_category" NOT NULL,
	CONSTRAINT "field_access_category_key" CHECK ("field_access_category"."field_key" ~ '^[a-z][A-Za-z0-9]{0,62}$' or "field_access_category"."field_key" = 'custom.*')
);
--> statement-breakpoint
CREATE TABLE "role_field_knowledge" (
	"project_role" "project_role" NOT NULL,
	"access_category" "access_category" NOT NULL,
	CONSTRAINT "role_field_knowledge_pkey" PRIMARY KEY("project_role","access_category")
);
