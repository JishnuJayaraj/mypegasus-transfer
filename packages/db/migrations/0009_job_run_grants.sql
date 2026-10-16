-- Hand-written (plan 5.4 grants, PR 1h-1): one row per job and run day, written once and never
-- changed, so the runtime role may only read and insert. pg-boss's own schema and its grants are
-- installed after these migrations by runMigrations (jobs-schema.ts), not here.
GRANT SELECT, INSERT ON TABLE "job_run" TO transfer_app;
