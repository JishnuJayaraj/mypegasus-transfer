CREATE TYPE "public"."import_target" AS ENUM('personnelNumber', 'lastName', 'firstName', 'birthDate', 'oldEmploymentEndDate', 'addressStreet', 'addressPostalCode', 'addressCity', 'addressCountry', 'phone', 'mobile', 'privateEmail', 'workEmail');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'import_confirmed';--> statement-breakpoint
CREATE TABLE "import_column_mapping" (
	"project_id" uuid NOT NULL,
	"header_hmac" text NOT NULL,
	"target" "import_target" NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_column_mapping_pkey" PRIMARY KEY("project_id","header_hmac"),
	CONSTRAINT "import_column_mapping_header_hmac" CHECK ("import_column_mapping"."header_hmac" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "import_column_mapping" ADD CONSTRAINT "import_column_mapping_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_column_mapping" ADD CONSTRAINT "import_column_mapping_updated_by_staff_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;