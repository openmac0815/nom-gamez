#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3001}"

echo "[start-prod] Starting NOM-GAMEZ backend on ${HOST}:${PORT}"
exec node server.js
