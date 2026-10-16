CREATE TABLE "job_run" (
	"job_name" text NOT NULL,
	"run_date" date NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_run_pkey" PRIMARY KEY("job_name","run_date"),
	CONSTRAINT "job_run_job_name_is_name" CHECK ("job_run"."job_name" ~ '^[a-z][a-z0-9_.-]{0,62}$'),
	CONSTRAINT "job_run_scheduled_on_run_date" CHECK (("job_run"."scheduled_at" at time zone 'Europe/Berlin')::date = "job_run"."run_date")
);
