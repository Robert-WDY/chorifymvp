$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeExecutable = 'C:/Users/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
Set-Location -LiteralPath $projectRoot
$listener = Get-NetTCPConnection -LocalPort 3212 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $history = Invoke-RestMethod 'http://127.0.0.1:3212/api/sessions'
    foreach ($entry in $history.sessions) {
        $snapshot = Invoke-RestMethod ('http://127.0.0.1:3212/api/session/' + $entry.id)
        if ($snapshot.status -eq 'running' -or $snapshot.pendingTasks) {
            throw 'A conversation is still running. Wait for it to finish before restarting.'
        }
    }
    $backendProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
    if ($backendProcess.ExecutablePath -ne $nodeExecutable.Replace('/', '\') -or $backendProcess.CommandLine -notlike '*server/index.mjs*') {
        throw 'The process on port 3212 is not the expected local backend.'
    }
    Stop-Process -Id $listener.OwningProcess
}
$env:PORT = '3212'
$env:MVP_DATA_DIR = Join-Path $projectRoot 'data/manual-fixed-server'
& $nodeExecutable --env-file-if-exists=.env server/index.mjs
