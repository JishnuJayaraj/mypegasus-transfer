#!/bin/bash
# Runs at the start of every Claude Code session (see .claude/settings.json).
# Only does work in cloud sessions; on a laptop it exits immediately.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 0

# Start the pre-installed PostgreSQL (not running by default in cloud sessions)
service postgresql start >/dev/null 2>&1 || true

# Install dependencies once the skeleton exists
if [ -f package.json ]; then
  corepack enable >/dev/null 2>&1 || true
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || true
fi

exit 0
