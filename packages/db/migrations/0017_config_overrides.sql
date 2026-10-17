CREATE TABLE "project_config_override" (
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_config_override_pkey" PRIMARY KEY("project_id","version"),
	CONSTRAINT "project_config_override_version_positive" CHECK ("project_config_override"."version" >= 1),
	CONSTRAINT "project_config_override_is_override" CHECK (jsonb_typeof("project_config_override"."content") = 'object' and "project_config_override"."content" ->> 'kind' = 'project_override')
);
--> statement-breakpoint
ALTER TABLE "project_config_override" ADD CONSTRAINT "project_config_override_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_override" ADD CONSTRAINT "project_config_override_created_by_staff_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;