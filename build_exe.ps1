param(
  [switch]$OneFile = $true,
  [switch]$NoConsole = $false
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

& ".venv\\Scripts\\python.exe" -m pip install --upgrade pip
& ".venv\\Scripts\\python.exe" -m pip install -r requirements.txt
& ".venv\\Scripts\\python.exe" -m pip install pyinstaller

$name = "Taskkill"
$entry = "serve.py"

$args = @(
  "--name", $name,
  "--clean",
  "--noconfirm",
  "--add-data", "templates;templates",
  "--add-data", "static;static"
)

if ($OneFile) { $args += "--onefile" }
if ($NoConsole) { $args += "--noconsole" }

& ".venv\\Scripts\\pyinstaller.exe" @args $entry

Write-Host ""
Write-Host "Build pronto. Confira a pasta .\\dist\\$name"

