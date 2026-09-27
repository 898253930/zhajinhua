param([switch]$Lan, [switch]$LocalOnly, [int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$env:HOST = if ($LocalOnly) { '127.0.0.1' } else { '0.0.0.0' }
$env:PORT = [string]$Port
Set-Location -LiteralPath $PSScriptRoot
Write-Host "Open http://localhost:$Port in your browser. Press Ctrl+C to stop."
node (Join-Path $PSScriptRoot 'server.mjs')
