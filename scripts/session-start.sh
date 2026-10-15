#!/bin/bash
# Runs at the start of every Claude Code session (see .claude/settings.json).
# Only does work in cloud sessions; on a laptop it exits immediately.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 1

# Start the pre-installed PostgreSQL (not running by default in cloud sessions)
service postgresql start >/dev/null 2>&1 || true

# The pre-installed Chromium doesn't match the pinned Playwright's browser revision, so
# Playwright launches it through this variable (spike S2, ADR-0003). CI installs its own.
if [ -n "$CLAUDE_ENV_FILE" ] && [ -x /opt/pw-browsers/chromium ]; then
  echo "export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium" >>"$CLAUDE_ENV_FILE"
fi

# Install exactly what the lockfile says. No fallback to a plain `pnpm install`: that would
# silently change the lockfile. If this fails, fix the lockfile deliberately and commit it.
if [ -f package.json ]; then
  command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1
  log="$(mktemp)"
  if ! pnpm install --frozen-lockfile >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    echo "session-start: 'pnpm install --frozen-lockfile' failed (output above)." >&2
    echo "If pnpm-lock.yaml is out of date, run 'pnpm install' on purpose and commit the lockfile." >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
fi

exit 0
