#!/bin/bash
# Smoke test for the production image (AC-22, plan section 5.8; AC-41, Slice 1 plan 5.9), used by
# the CI `image` job.
#   scripts/image-smoke.sh <image>
# Needs a PostgreSQL with the dev roles (`pnpm db:setup`) on the host, reachable through
# DATABASE_URL and DATABASE_MIGRATION_URL, and psql. Runs the migration (twice: installing the
# pgboss schema and its grants is idempotent), starts the server with pg-boss as the runtime role
# and checks /api/v1/health/ready, / and /portal/, and the template catalog from the bundle's
# config (AC-12) as a synthetic PL that exists only during the run. Synthetic setup only.
set -euo pipefail

image="${1:?usage: scripts/image-smoke.sh <image>}"
: "${DATABASE_URL:?}" "${DATABASE_MIGRATION_URL:?}"
port="${SMOKE_PORT:-8080}"
base="http://localhost:${port}"
name="transfer-smoke-$$"
jar="$(mktemp)"
# A synthetic staff user for the catalog check; removed again on exit.
smoke_user=00000000-0000-4000-8000-0000000000aa
sql() { psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 "$DATABASE_MIGRATION_URL" -c "$1"; }

fail() {
  echo "image-smoke: $*" >&2
  docker logs "$name" >&2 2>/dev/null || true
  exit 1
}
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -f "$jar"
  sql "delete from staff_user where id = '$smoke_user'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Runs as the non-root `node` user.
uid="$(docker run --rm "$image" id -u)"
[ "$uid" != "0" ] || fail "the image runs as root"

# Migrations are a separate command (a Job on the cluster); they also install pg-boss's schema.
for run in first second; do
  docker run --rm --network host -e DATABASE_MIGRATION_URL "$image" node dist/migrate.js ||
    fail "node dist/migrate.js failed ($run run)"
done

# The server. NODE_ENV=development and AUTH_MODE=dev because the image refuses to start in
# production with the dev auth stub, and OIDC needs an identity provider (the API tests run OIDC
# against a local test issuer). The dev login starts a session in the store like OIDC does. Jobs are
# on by default: pg-boss starts as transfer_app before the server listens, or the start fails.
docker run -d --name "$name" --network host -e PORT="$port" -e NODE_ENV=development \
  -e AUTH_MODE=dev -e APP_ORIGINS="$base" -e DATABASE_URL -e LOG_LEVEL=info "$image" >/dev/null

for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "$base/api/v1/health" 2>/dev/null && break
  sleep 1
done

check() { # <path> <expected status> <expected body pattern>
  local body status
  body="$(curl -sS -w '\n%{http_code}' "$base$1")" || fail "GET $1: no response"
  status="${body##*$'\n'}"
  [ "$status" = "$2" ] || fail "GET $1: status $status, expected $2"
  grep -q -- "$3" <<<"$body" || fail "GET $1: body does not match '$3'"
  echo "ok  GET $1 -> $status"
}

check /api/v1/health/ready 200 '"status":"ok"'
# Captured first: with pipefail, `docker logs | grep -q` fails when grep exits on its first match
# and docker logs dies of SIGPIPE (exit 141).
logs="$(docker logs "$name" 2>&1)"
grep -q '"msg":"jobs started"' <<<"$logs" || fail "pg-boss did not start"
echo "ok  pg-boss started (jobs on)"
check / 200 '<title>Transferplattform</title>'
check /projects/new 200 '<title>Transferplattform</title>'
check /portal/ 200 '<title>Teilnehmerportal</title>'
check /api/v1/unknown 404 'urn:transfer:problem:not-found'

# The template catalog, read from CONFIG_DIR (dist/config) at start (AC-12, spike S2).
# A staff user who may create projects reads the catalog (no flat role since Slice 3, Q126).
sql "insert into staff_user (id, display_name, email, may_create_projects) values ('$smoke_user',
  'Smoke Projektleitung', 'smoke-project-lead@example.org', true) on conflict do nothing"
curl -fsS -o /dev/null -c "$jar" -X POST -H 'Content-Type: application/json' -H "Origin: $base" \
  -d "{\"staffUserId\":\"$smoke_user\"}" "$base/api/v1/dev/session" || fail "dev login failed"
catalog="$(curl -fsS -b "$jar" "$base/api/v1/config/templates")" ||
  fail "GET /api/v1/config/templates failed"
grep -q '"agenturKey":"beispielstadt-nord","version":1,' <<<"$catalog" ||
  fail "GET /api/v1/config/templates: the sample template is missing"
echo "ok  GET /api/v1/config/templates -> 200 (the catalog from dist/config)"

portal="$(curl -fsS "$base/portal/")" || fail "GET /portal/: no response"
asset="$(grep -o '/portal/assets/[^"]*\.js' <<<"$portal" | sed -n 1p || true)"
[ -n "$asset" ] || fail "no script in /portal/"
curl -fsS -o /dev/null -D - "$base$asset" | grep -qi '^cache-control: .*immutable' ||
  fail "GET $asset: not cached as immutable"
echo "ok  GET $asset is immutable"
