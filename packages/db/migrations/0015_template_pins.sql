ALTER TYPE "public"."audit_event_type" ADD VALUE 'config_template_pinned';--> statement-breakpoint
CREATE TABLE "config_template_version" (
	"agentur_key" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_template_version_pkey" PRIMARY KEY("agentur_key","version"),
	CONSTRAINT "config_template_version_version_positive" CHECK ("config_template_version"."version" >= 1),
	CONSTRAINT "config_template_version_sha256_hex" CHECK ("config_template_version"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "config_template_version_content_matches_key" CHECK ("config_template_version"."content" ->> 'kind' = 'regional_template' and "config_template_version"."content" ->> 'agenturKey' = "config_template_version"."agentur_key" and "config_template_version"."content" -> 'version' = to_jsonb("config_template_version"."version"))
);
--> statement-breakpoint
CREATE TABLE "project_template_pin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "project_template_pin_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"agentur_key" text NOT NULL,
	"version" integer NOT NULL,
	"pinned_by" uuid NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_template_pin" ADD CONSTRAINT "project_template_pin_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_pin" ADD CONSTRAINT "project_template_pin_pinned_by_staff_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_pin" ADD CONSTRAINT "project_template_pin_version_fk" FOREIGN KEY ("agentur_key","version") REFERENCES "public"."config_template_version"("agentur_key","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_template_pin_project_agentur_seq_idx" ON "project_template_pin" USING btree ("project_id","agentur_key","seq");