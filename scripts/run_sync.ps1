param(
  [int]$IntervalSeconds = 0
)

$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)\..

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

& ".venv\Scripts\python.exe" -m pip install -r requirements.txt

if ($IntervalSeconds -gt 0) {
  $env:CHAMADOS_POLL_SECONDS = "$IntervalSeconds"
}

Write-Host ""
Write-Host "Sync de Chamados iniciando..."
Write-Host "- Lê variáveis do .env automaticamente"
Write-Host "- Para habilitar: CHAMADOS_SYNC_ENABLED=1"
Write-Host ""

& ".venv\Scripts\python.exe" "scripts\sync_chamados.py"

