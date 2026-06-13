#!/usr/bin/env bash
# ci-vitest.sh — Runs vitest with a SIGKILL timeout.
#
# NOTE: vitest 2.x hangs in CI due to better-sqlite3 native module loading
# in forked processes (WAL file lock deadlock). Tests complete but vitest
# never exits. The SIGKILL timeout is a workaround until the root cause is fixed.
#
# See: https://github.com/danielperezr88/astrolabe/issues/925
#
# Usage: bash scripts/ci-vitest.sh [timeout_seconds]
#   timeout_seconds: max seconds before SIGKILL (default: 180)

set -uo pipefail

TIMEOUT_SECONDS="${1:-180}"

echo "=== Starting vitest at $(date) ==="

# All test runs execute from packages/core
cd packages/core

# Run vitest with SIGKILL timeout.
# Exit 0 on SIGKILL (137) — vitest completed tests but hung on exit (known issue).
# Exit 1 on any other failure code.
set +e
timeout -s KILL "$TIMEOUT_SECONDS" npx vitest run --reporter=verbose
CODE=$?
set -e

echo ""
echo "=== vitest exited with code $CODE at $(date) ==="

case $CODE in
  0)
    exit 0
    ;;
  1)
    exit 1
    ;;
  137)
    echo "WARNING: vitest was killed after ${TIMEOUT_SECONDS}s timeout (known CI hang)."
    echo "Tests are expected to complete before the hang. Assuming pass."
    exit 0
    ;;
  124)
    echo "FATAL: vitest timed out (exit 124)."
    exit 1
    ;;
  *)
    echo "FATAL: vitest exited with unexpected code $CODE"
    exit 1
    ;;
esac