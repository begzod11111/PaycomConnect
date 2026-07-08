#!/usr/bin/env bash
# (Re)deploy the PaycomConnect app container on the VM. Run from the repo root
# on the VM (e.g. /home/cursor-gcp-vm/paycomconnect). Requires sudo + .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "!! .env is missing. Create it from .env.example and fill secrets." >&2
  exit 1
fi

echo "== Build + start =="
sudo docker compose up -d --build

echo "== Wait for health =="
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9010/api/health >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "== Status =="
sudo docker compose ps
echo
echo "== Health =="
curl -s http://127.0.0.1:9010/api/health; echo
