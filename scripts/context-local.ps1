param([ValidateSet('Start','Stop','Status')][string]$Action='Start')
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$entry=Join-Path $repoRoot 'scripts\context-local.mjs'
$runDir=Join-Path $repoRoot 'data\local-service'
$recordFile=Join-Path $runDir 'process.json'
$address='http://127.0.0.1:3217'
function Get-OwnedProcess {
 if(!(Test-Path -LiteralPath $recordFile)){return $null}
 $record=Get-Content -Raw -LiteralPath $recordFile | ConvertFrom-Json
 $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$record.pid)
 if(!$process){return $null}
 if($record.entry -ne $entry -or $process.ExecutablePath -ne $record.executable -or $process.CommandLine -notlike ('*"'+$entry+'"*') -or $process.CreationDate.ToUniversalTime().ToString('o') -ne $record.creationTime){throw 'Recorded PID does not match this instance; refusing to control it.'}
 return $process
}
$owned=Get-OwnedProcess
if($Action -eq 'Stop'){
 if($owned){Stop-Process -Id $owned.ProcessId; Wait-Process -Id $owned.ProcessId -Timeout 10 -ErrorAction SilentlyContinue}
 Write-Output 'Only this isolated instance was stopped. Data retained.'
 exit 0
}
if($Action -eq 'Status'){
 if(!$owned){Write-Output 'Isolated local instance is not running.';exit 0}
 $listener=Get-NetTCPConnection -LocalPort 3217 -State Listen -ErrorAction Stop
 if($listener.OwningProcess -ne $owned.ProcessId){throw 'Port owner does not match this instance.'}
 $config=Invoke-RestMethod ($address+'/api/config')
 [pscustomobject]@{pid=$owned.ProcessId;url=$address;repository=$repoRoot;engine=$config.engine;model=$config.model;modelEnabled=$config.modelEnabled;mediaMode=$config.mediaMode} | ConvertTo-Json
 exit 0
}
if($owned){Write-Output ('Already running: '+$address);exit 0}
$listener=Get-NetTCPConnection -LocalPort 3217 -State Listen -ErrorAction SilentlyContinue
if($listener){throw 'Port 3217 is occupied; no other process will be stopped.'}
if(!(Test-Path -LiteralPath (Join-Path $repoRoot '.env.local'))){throw 'Missing this checkout''s .env.local; configure it before starting.'}
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$logStamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdout=Join-Path $runDir ($logStamp+'-stdout.log')
$stderr=Join-Path $runDir ($logStamp+'-stderr.log')
$nodeExe=(Get-Command node -CommandType Application | Select-Object -First 1).Source
# Clear project-related inherited settings for the child, restoring this shell afterward.
$inherited=@{}
foreach($item in @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(LLM_|DEEPSEEK_|DOUBAO_|CONTEXT_AGENT_|NODE_OPTIONS$|NODE_PATH$|PORT$|MVP_DATA_DIR$)' })){$inherited[$item.Name]=$item.Value;Remove-Item -LiteralPath ('Env:'+ $item.Name)}
try{
 & $nodeExe $entry --check
 if($LASTEXITCODE -ne 0){throw 'Local configuration validation failed.'}
 $child=Start-Process -FilePath $nodeExe -ArgumentList ('"'+$entry+'"') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
}finally{foreach($key in $inherited.Keys){Set-Item -LiteralPath ('Env:'+$key) -Value $inherited[$key]}}
$identity=Get-CimInstance Win32_Process -Filter ('ProcessId='+$child.Id)
if(!$identity){throw 'Local service exited before startup completed; see stderr.log.'}
@{pid=$child.Id;entry=$entry;executable=$identity.ExecutablePath;creationTime=$identity.CreationDate.ToUniversalTime().ToString('o');url=$address;repository=$repoRoot;stdout=$stdout;stderr=$stderr} | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding utf8
for($attempt=0;$attempt -lt 30;$attempt++){
 try{$config=Invoke-RestMethod ($address+'/api/config');$listener=Get-NetTCPConnection -LocalPort 3217 -State Listen -ErrorAction Stop;if($config.engine -eq 'context-agent' -and $listener.OwningProcess -eq $child.Id){Write-Output ('Started isolated Chorify: '+$address+' (PID '+$child.Id+')');exit 0}}catch{}
 if(!(Get-Process -Id $child.Id -ErrorAction SilentlyContinue)){throw ('Service exited; inspect '+$stderr)}
 Start-Sleep -Milliseconds 300
}
throw 'Startup timed out; inspect this instance with -Action Status. No other service was touched.'
