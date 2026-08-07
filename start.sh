#!/usr/bin/env bash
# Inicia o Taskkill localmente (waitress), desacoplado do terminal.
# Uso: ./start.sh   |   parar: ./stop.sh
set -euo pipefail

cd "$(dirname "$0")"
PORT="${TASKKILL_PORT:-5091}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Taskkill ja esta rodando em http://127.0.0.1:$PORT"
  exit 0
fi

nohup .venv/bin/python3 serve.py > taskkill.local.log 2>&1 &
echo $! > taskkill.pid
sleep 2

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Taskkill iniciado (pid $(cat taskkill.pid)) -> http://127.0.0.1:$PORT"
else
  echo "Falhou ao iniciar. Veja o log:"
  tail -n 20 taskkill.local.log
  exit 1
fi
