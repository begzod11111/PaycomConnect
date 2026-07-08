#!/usr/bin/env bash
set -euo pipefail

# Pull the latest code and rebuild + restart the PaycomConnect container.
#
# Usage (on the VM, inside the repo directory):
#   ./deploy/deploy.sh                 # git pull -> build -> up -d -> health check
#   NO_PULL=1 ./deploy/deploy.sh       # rebuild the current checkout (skip git pull)
#   GIT_BRANCH=master ./deploy/deploy.sh
#
# Requires git to be configured first (see ./deploy/setup-git.sh) and a filled .env.

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
GIT_BRANCH="${GIT_BRANCH:-master}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:9010/api/health}"

cd "$REPO_DIR"

# Pick the available docker compose flavour (v2 plugin or legacy binary).
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "ERROR: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

if [ "${NO_PULL:-0}" != "1" ]; then
  echo "==> Pulling latest code ($GIT_BRANCH)"
  git fetch origin "$GIT_BRANCH"
  git pull --ff-only origin "$GIT_BRANCH"
fi

if [ ! -f .env ]; then
  echo "WARNING: .env not found. Copy .env.example to .env and fill in secrets first." >&2
fi

echo "==> Building image"
$COMPOSE build

echo "==> Starting/updating container"
$COMPOSE up -d

echo "==> Pruning dangling images to reclaim disk"
docker image prune -f >/dev/null 2>&1 || true

echo "==> Waiting for health at $HEALTH_URL"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done

if [ "$healthy" = "1" ]; then
  echo "==> Healthy:"
  curl -s "$HEALTH_URL"; echo
  echo "Deploy complete."
else
  echo "ERROR: health check did not pass in time. Recent logs:" >&2
  $COMPOSE logs --tail=60 paycomconnect || true
  exit 1
fi
