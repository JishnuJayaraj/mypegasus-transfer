-- Hand-written (plan 5.4 grants, PR 1h-1, round 19): one row per job and run day, written once
-- and never changed. The runtime role may read it and insert only these three columns, so
-- completed_at is always the database's now() (a CHECK keeps it after scheduled_at). pg-boss's
-- own schema and its grants are installed after these migrations by runMigrations
-- (jobs-schema.ts), not here.
GRANT SELECT ON TABLE "job_run" TO transfer_app;--> statement-breakpoint
GRANT INSERT ("job_name", "run_date", "scheduled_at") ON TABLE "job_run" TO transfer_app;
