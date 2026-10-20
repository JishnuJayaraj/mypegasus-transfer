-- Roles and databases for dev, CI and Compose (ADR-0002).
-- Idempotent. Run as a superuser through psql (`pnpm db:setup`); \gexec and \connect are psql.
-- The passwords only protect local databases with synthetic data. They are not secrets.
-- On the cluster, CloudNativePG manages roles with the same names (Slice 9).
\set ON_ERROR_STOP on

-- transfer_owner owns the databases and tables and runs migrations and seeds.
-- transfer_app is the runtime role: CONNECT, USAGE on public and only the table grants
-- that migrations give it explicitly. No default privileges.
SELECT 'CREATE ROLE transfer_owner LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'transfer_owner') \gexec
SELECT 'CREATE ROLE transfer_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'transfer_app') \gexec
ALTER ROLE transfer_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'transfer_owner_dev';
ALTER ROLE transfer_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'transfer_app_dev';

SELECT format('CREATE DATABASE %I OWNER transfer_owner', name)
FROM unnest(ARRAY['transfer', 'transfer_test', 'transfer_e2e']) AS name
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = name) \gexec

GRANT CONNECT ON DATABASE transfer, transfer_test, transfer_e2e TO transfer_app;

\connect transfer
GRANT USAGE ON SCHEMA public TO transfer_app;
\connect transfer_test
GRANT USAGE ON SCHEMA public TO transfer_app;
\connect transfer_e2e
GRANT USAGE ON SCHEMA public TO transfer_app;
