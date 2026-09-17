$ErrorActionPreference='Stop'
$launcher=Join-Path $PSScriptRoot 'context-local.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Stop
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Start
exit $LASTEXITCODE
