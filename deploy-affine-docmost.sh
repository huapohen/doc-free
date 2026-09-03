#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Open Docker Desktop, then rerun this script." >&2
  exit 1
fi
if [[ ! -f .env.affine-docmost ]]; then
  echo "Missing .env.affine-docmost. Copy .env.affine-docmost.example and set secrets." >&2
  exit 1
fi
docker compose --env-file .env.affine-docmost -f docker-compose.affine-docmost.yml up -d
docker compose --env-file .env.affine-docmost -f docker-compose.affine-docmost.yml ps
