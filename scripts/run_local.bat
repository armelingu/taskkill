@echo off
setlocal

cd /d %~dp0\..

if not exist ".venv" (
  python -m venv .venv
)

".venv\Scripts\python.exe" -m pip install -r requirements.txt

echo.
echo Taskkill (local) iniciando...
echo - Se for o primeiro uso, edite .env e defina TASKKILL_ADMIN_PASSWORD
echo - Para uso local, recomendo TASKKILL_COOKIE_SECURE=0
echo.

".venv\Scripts\python.exe" "serve.py"

endlocal

