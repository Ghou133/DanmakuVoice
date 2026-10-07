param([int]$RootProcessId, [string]$PhaseFile, [string]$Output, [int]$Seconds=180)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
if (Test-Path -LiteralPath $Output) { throw 'Choose a new evidence output.' }
$rows = @()
$prior = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()
$priorTime = 0.0
while ($clock.Elapsed.TotalSeconds -lt $Seconds -and (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
    $phaseStart = if (Test-Path -LiteralPath $PhaseFile) { (Get-Content -LiteralPath $PhaseFile -Raw).Trim() } else {'starting'}
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)
    $ids = @(Select-AuditProcessTree $all $RootProcessId | ForEach-Object { [int]$_.ProcessId })
    $now = $clock.Elapsed.TotalSeconds
    $processes = @()
    foreach ($id in $ids) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (!$process) { continue }
        $identity = "$id`:$($process.StartTime.ToUniversalTime().Ticks)"
        $cpu = [double]$process.CPU
        $delta = if ($prior.ContainsKey($identity)) { [Math]::Max(0, $cpu-$prior[$identity]) } else { $null }
        $group = if ($id -eq $RootProcessId) { 'main' } elseif ($process.ProcessName -match 'msedgewebview2') { 'webview' } elseif ($process.ProcessName -match 'python|ffmpeg') { 'tts' } else { 'other' }
        $processes += [pscustomobject]@{pid=$id; group=$group; cpuOneCorePercent=$(if ($null -ne $delta) {$delta/($now-$priorTime)*100} else {$null}); workingSetBytes=$process.WorkingSet64; privateBytes=$process.PrivateMemorySize64; handles=$process.HandleCount}
        $prior[$identity]=$cpu
    }
    $gpu = @()
    $gpuError = $null
    try {
        $sample = Get-Counter '\GPU Engine(*)\Utilization Percentage','\GPU Process Memory(*)\Dedicated Usage','\GPU Process Memory(*)\Shared Usage' -ErrorAction Stop
        foreach ($counter in $sample.CounterSamples) {
            if ($counter.InstanceName -match '^pid_(\d+)_' -and [int]$Matches[1] -in $ids) {
                $gpu += [pscustomobject]@{instance=$counter.InstanceName; counter=($counter.Path -split '\\')[-1]; value=$counter.CookedValue}
            }
        }
    } catch { $gpuError=$_.Exception.Message }
    $phase = if (Test-Path -LiteralPath $PhaseFile) { (Get-Content -LiteralPath $PhaseFile -Raw).Trim() } else {'starting'}
    if ($phase -ne $phaseStart) { $phase='transition' }
    $rows += [pscustomobject]@{seconds=$now; phase=$phase; processes=$processes; gpu=$gpu; gpuError=$gpuError}
    $priorTime=$now
    $rows | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Output -Encoding UTF8
    Start-Sleep -Seconds 1
}
