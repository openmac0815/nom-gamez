#!/bin/zsh
set -euo pipefail

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3001}"
URL="http://${HOST}:${PORT}/ready"

curl --fail --silent --show-error --max-time 10 "$URL"
