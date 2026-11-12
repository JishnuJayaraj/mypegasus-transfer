CREATE TABLE "function_source" (
	"name" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "function_source_sha256_is_hex" CHECK ("function_source"."sha256" ~ '^[0-9a-f]{64}$')
);
