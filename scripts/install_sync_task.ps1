param(
  [string]$TaskName = "Taskkill - Sync Chamados",
  [switch]$Hidden
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")).Path
$psExe = (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe")
$runSync = (Join-Path $projectRoot "scripts\run_sync.ps1")

if (-not (Test-Path $runSync)) {
  throw "Arquivo não encontrado: $runSync"
}

$windowStyle = if ($Hidden) { "Hidden" } else { "Normal" }

# Cria uma tarefa por usuário, no logon, para manter o sync sempre rodando.
$action = "`"$psExe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle $windowStyle -File `"$runSync`""

schtasks /Create /F /SC ONLOGON /TN "$TaskName" /TR $action | Out-Null

Write-Host "OK: tarefa criada no Agendador."
Write-Host "- Nome: $TaskName"
Write-Host "- Para remover: scripts\\uninstall_sync_task.ps1"

