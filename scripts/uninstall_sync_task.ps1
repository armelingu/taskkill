param(
  [string]$TaskName = "Taskkill - Sync Chamados"
)

$ErrorActionPreference = "Stop"

schtasks /Delete /F /TN "$TaskName" | Out-Null

Write-Host "OK: tarefa removida do Agendador."
Write-Host "- Nome: $TaskName"

