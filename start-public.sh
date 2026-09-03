#!/bin/zsh
set -e
cd "$(dirname "$0")"
if ! curl -fsS http://localhost:${PORT:-3210}/health >/dev/null 2>&1; then
  nohup npm start >doc-free.log 2>&1 &
  sleep 1
fi
if ! nc -z 127.0.0.1 ${COLLAB_PORT:-1234} >/dev/null 2>&1; then
  nohup npm run start:collab >collab.log 2>&1 &
  sleep 1
fi
exec cloudflared tunnel --url "http://localhost:${PORT:-3210}"
