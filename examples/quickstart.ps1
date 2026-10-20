# quickstart.ps1 - run one tick and print the artifact paths.
# ASCII only (the .ps1 is deliberately free of non-ASCII text so that any
# cmd.exe / PowerShell 5.1 / 7 encoding path reads it the same way).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\examples\quickstart.ps1
#   powershell -ExecutionPolicy Bypass -File .\examples\quickstart.ps1 -StateHome <dir>
#
# Default state home = .ops-demo-home under the CURRENT directory.
# It never touches the user's ~/.dsh.
[CmdletBinding()]
param(
  [string]$StateHome = (Join-Path (Get-Location) '.ops-demo-home')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tick = Join-Path $root 'bin\ops-tickd.mjs'

if (-not (Test-Path -LiteralPath $tick)) {
  Write-Error ("[quickstart] not found: " + $tick)
  exit 2
}

Write-Host ("[quickstart] package root : " + $root)
Write-Host ("[quickstart] state home   : " + $StateHome)
Write-Host ""

& node $tick --once --home $StateHome
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ("[quickstart] ops-tickd exited with " + $code)
  exit $code
}

Write-Host ""
Write-Host "[quickstart] artifacts:"

$reportsDir = Join-Path $StateHome 'ops-reports'
$report = $null
if (Test-Path -LiteralPath $reportsDir) {
  $report = Get-ChildItem -LiteralPath $reportsDir -Filter *.md |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if ($report) { Write-Host ("  report  : " + $report.FullName + " (" + $report.Length + " bytes)") }
else { Write-Host "  report  : (missing - run with -Verbose to see the job result)" }

$auditDir = Join-Path $StateHome 'ops-audit'
$audit = $null
if (Test-Path -LiteralPath $auditDir) {
  $audit = Get-ChildItem -LiteralPath $auditDir -Filter *.jsonl |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if ($audit) { Write-Host ("  audit   : " + $audit.FullName + " (" + $audit.Length + " bytes)") }
else { Write-Host "  audit   : (missing)" }

$outbox = Join-Path $StateHome 'ops-notify-outbox.jsonl'
if (Test-Path -LiteralPath $outbox) {
  Write-Host ("  outbox  : " + $outbox + " (" + (Get-Item -LiteralPath $outbox).Length + " bytes)")
} else {
  Write-Host "  outbox  : (empty - add an item to ops-queue.json to produce one)"
}

Write-Host ""
Write-Host "[quickstart] next: open the report above, or run again to check that the report is not rewritten."
exit 0
