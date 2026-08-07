#!/usr/bin/env bash
# Para o Taskkill que estiver escutando na porta configurada.
set -euo pipefail

cd "$(dirname "$0")"
PORT="${TASKKILL_PORT:-5091}"

PIDS="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -z "$PIDS" ]; then
  echo "Nada rodando na porta $PORT."
  rm -f taskkill.pid
  exit 0
fi

kill $PIDS
rm -f taskkill.pid
echo "Taskkill parado (pids: $PIDS)"
