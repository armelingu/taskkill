@echo off
setlocal

cd /d %~dp0\..

if not exist ".venv" (
  python -m venv .venv
)

".venv\Scripts\python.exe" -m pip install -r requirements.txt

echo.
echo Sync de Chamados iniciando...
echo - Le variaveis do .env automaticamente
echo - Para habilitar: CHAMADOS_SYNC_ENABLED=1
echo.

".venv\Scripts\python.exe" "scripts\sync_chamados.py"

endlocal

