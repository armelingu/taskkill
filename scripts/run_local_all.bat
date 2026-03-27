@echo off
setlocal

cd /d %~dp0\..

if not exist ".venv" (
  python -m venv .venv
)

".venv\Scripts\python.exe" -m pip install -r requirements.txt

echo.
echo Taskkill + Sync (local) iniciando...
echo - Se for o primeiro uso, edite .env
echo - Para uso local, recomendo TASKKILL_COOKIE_SECURE=0
echo - Para habilitar o sync: CHAMADOS_SYNC_ENABLED=1
echo.

set TASKKILL_COOKIE_SECURE=0
set TASKKILL_HOST=127.0.0.1
set TASKKILL_PORT=5091

start "Taskkill - Sync Chamados" cmd /k ""%CD%\.venv\Scripts\python.exe" "%CD%\scripts\sync_chamados.py""

".venv\Scripts\python.exe" "serve.py"

endlocal

