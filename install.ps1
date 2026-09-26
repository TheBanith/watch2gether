# Watch2Gether local runner for Windows (development / LAN use).
#
#   ./install.ps1              # install deps + start on http://localhost:3000
#   ./install.ps1 -Port 8080   # custom port
#   ./install.ps1 -NoStart     # just install dependencies
#
# For a public HTTPS deployment use install.sh on a Linux server instead.
param(
  [int]$Port = 3000,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: '$name' not found. $hint" -ForegroundColor Red
    exit 1
  }
}

Need node "Install Node.js 18+ from https://nodejs.org"
$nodeMajor = (node -v) -replace 'v(\d+).*', '$1'
if ([int]$nodeMajor -lt 18) {
  Write-Host "ERROR: Node.js 18+ required (found $(node -v))." -ForegroundColor Red
  exit 1
}
Write-Host "Node $(node -v), npm $(npm -v)" -ForegroundColor Cyan

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "Note: ffmpeg not found - uploads will stream as-is without transcoding." -ForegroundColor Yellow
}

Write-Host "Installing dependencies..." -ForegroundColor Cyan
Push-Location $root
try {
  if (Test-Path (Join-Path $root 'package-lock.json')) {
    npm ci
    if ($LASTEXITCODE -ne 0) { npm install }
  } else {
    npm install
  }
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

  New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\uploads') | Out-Null

  if ($NoStart) {
    Write-Host "Dependencies installed. Run 'npm start' to launch." -ForegroundColor Green
  } else {
    Write-Host "Starting on http://localhost:$Port ..." -ForegroundColor Green
    $env:PORT = "$Port"
    node src/server.js
  }
} finally {
  Pop-Location
}
