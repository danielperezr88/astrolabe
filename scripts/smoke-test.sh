#!/usr/bin/env bash
# smoke-test.sh — Basic health check against a running Astrolabe container.
# Usage: ./scripts/smoke-test.sh [image_tag]
#
# Expects the container to expose the HTTP server on port 4747.
# Returns 0 on success, 1 on failure.

set -euo pipefail

IMAGE_TAG="${1:-latest}"
CONTAINER_NAME="astrolabe-smoke-$$"
PORT="4747"
TIMEOUT="30"

echo "── Smoke test: ghcr.io/danielperezr88/astrolabe:${IMAGE_TAG}"

# Start container
echo "Starting container..."
docker run -d --name "${CONTAINER_NAME}" \
  -p "${PORT}:${PORT}" \
  "ghcr.io/danielperezr88/astrolabe:${IMAGE_TAG}" \
  >/dev/null

# Ensure cleanup on exit
cleanup() {
  docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait for the server to respond
echo "Waiting up to ${TIMEOUT}s for server..."
elapsed=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
  if curl -sf "http://localhost:${PORT}/api/health" -o /dev/null 2>/dev/null; then
    echo "✓ Server responded on port ${PORT}"
    echo "✓ Smoke test PASSED"
    exit 0
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

# Timeout — dump container logs for debugging
echo "✗ Server did not respond within ${TIMEOUT}s"
echo "── Container logs ──"
docker logs "${CONTAINER_NAME}" 2>&1 | tail -20
echo "✗ Smoke test FAILED"
exit 1
