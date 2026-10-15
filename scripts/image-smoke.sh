#!/bin/bash
# Smoke test for the production image (AC-22, plan section 5.8), used by the CI `image` job.
#   scripts/image-smoke.sh <image>
# Needs a PostgreSQL with the dev roles (`pnpm db:setup`) on the host, reachable through
# DATABASE_URL and DATABASE_MIGRATION_URL. Runs the migration, starts the server and checks
# /api/v1/health/ready, / and /portal/. Synthetic setup only; no data is read.
set -euo pipefail

image="${1:?usage: scripts/image-smoke.sh <image>}"
: "${DATABASE_URL:?}" "${DATABASE_MIGRATION_URL:?}"
port="${SMOKE_PORT:-8080}"
base="http://localhost:${port}"
name="transfer-smoke-$$"

fail() {
  echo "image-smoke: $*" >&2
  docker logs "$name" >&2 2>/dev/null || true
  exit 1
}
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

# Runs as the non-root `node` user.
uid="$(docker run --rm "$image" id -u)"
[ "$uid" != "0" ] || fail "the image runs as root"

# Migrations are a separate command (a Job on the cluster).
docker run --rm --network host -e DATABASE_MIGRATION_URL "$image" node dist/migrate.js ||
  fail "node dist/migrate.js failed"

# The server. NODE_ENV=development and AUTH_MODE=dev because the image refuses to start in
# production with the dev auth stub, and OIDC only comes in Slice 3 (plan section 5.4).
docker run -d --name "$name" --network host -e PORT="$port" -e NODE_ENV=development \
  -e AUTH_MODE=dev -e APP_ORIGINS="$base" -e DATABASE_URL -e LOG_LEVEL=warn "$image" >/dev/null

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
check / 200 '<title>Transferplattform</title>'
check /projects/new 200 '<title>Transferplattform</title>'
check /portal/ 200 '<title>Teilnehmerportal</title>'
check /api/v1/unknown 404 'urn:transfer:problem:not-found'

asset="$(curl -fsS "$base/portal/" | grep -o '/portal/assets/[^"]*\.js' | head -n 1)"
[ -n "$asset" ] || fail "no script in /portal/"
curl -fsS -o /dev/null -D - "$base$asset" | grep -qi '^cache-control: .*immutable' ||
  fail "GET $asset: not cached as immutable"
echo "ok  GET $asset is immutable"
