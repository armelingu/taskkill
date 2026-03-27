param(
  [switch]$Waitress = $true
)

$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)\..

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

& ".venv\Scripts\python.exe" -m pip install -r requirements.txt

Write-Host ""
Write-Host "Taskkill + Sync (local) iniciando..."
Write-Host "- Se for o primeiro uso, edite .env"
Write-Host "- Para uso local, recomendo TASKKILL_COOKIE_SECURE=0"
Write-Host "- Para habilitar o sync: CHAMADOS_SYNC_ENABLED=1"
Write-Host ""

$env:TASKKILL_COOKIE_SECURE = "0"
$env:TASKKILL_HOST = "127.0.0.1"
$env:TASKKILL_PORT = "5091"

# Abre o sync em outra janela para você visualizar logs separadamente
$syncCmd = "& `"$PWD\.venv\Scripts\python.exe`" `"$PWD\scripts\sync_chamados.py`""
Start-Process powershell -WindowStyle Normal -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-NoExit",
  "-Command", $syncCmd
) -WorkingDirectory $PWD

if ($Waitress) {
  & ".venv\Scripts\python.exe" "serve.py"
} else {
  & ".venv\Scripts\python.exe" "app.py"
}

