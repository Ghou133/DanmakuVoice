param(
    [int]$RootProcessId,
    [ValidateRange(2, 3600)][int]$Seconds = 30,
    [ValidateRange(1, 60)][int]$IntervalSeconds = 1,
    [string]$Scenario = 'foreground-idle',
    [string]$OutputCsv,
    [switch]$FunctionsOnly
)

$ErrorActionPreference = 'Stop'

# Difference each stable process identity separately. Subtracting aggregate
# lifetime CPU loses work whenever FFmpeg or a WebView2 child exits; PID alone
# also confuses a replacement process with the prior occupant of that PID.
function Get-CpuSampleDelta([hashtable]$Previous, [object[]]$Current, [long]$PreviousUtcTicks) {
    $next = @{}
    $delta = 0.0
    foreach ($sample in $Current) {
        $next[$sample.Identity] = [double]$sample.CpuSeconds
        if ($Previous.ContainsKey($sample.Identity)) {
            $delta += [math]::Max(0.0, $sample.CpuSeconds - $Previous[$sample.Identity])
        } elseif ($sample.StartedUtcTicks -gt $PreviousUtcTicks) {
            # A child born since the prior sample contributes all its CPU.
            $delta += [double]$sample.CpuSeconds
        }
    }
    return [pscustomobject]@{ DeltaCpuSeconds = $delta; Current = $next }
}
if ($FunctionsOnly) { return }
if ($RootProcessId -le 0) { throw 'RootProcessId must identify a running application process' }
if (-not $OutputCsv) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputCsv = Join-Path $PSScriptRoot "..\dist\measure-$Scenario-$stamp.csv"
}
$OutputCsv = [IO.Path]::GetFullPath($OutputCsv)
if (Test-Path -LiteralPath $OutputCsv) {
    throw "Refusing to overwrite measurement: $OutputCsv"
}
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputCsv) -Force | Out-Null

# Resolve the full descendant tree on each sample so transient ffmpeg.exe
# subprocesses count toward the same scenario as the desktop process.
function Get-ProcessTreeIds([int]$rootId) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
    if (-not @($all | Where-Object { $_.ProcessId -eq $rootId }).Count) {
        return @()
    }
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($rootId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $all) {
            if ($ids.Contains([int]$process.ParentProcessId) -and
                $ids.Add([int]$process.ProcessId)) {
                $changed = $true
            }
        }
    }
    return @($ids)
}

$rows = [Collections.Generic.List[object]]::new()
$previousCpu = @{}
$previousTime = $null
$timer = [Diagnostics.Stopwatch]::StartNew()
$previousElapsed = 0.0
$finish = (Get-Date).AddSeconds($Seconds)
do {
    $now = Get-Date
    $ids = @(Get-ProcessTreeIds $RootProcessId)
    if ($ids.Count -eq 0) {
        if ($rows.Count -eq 0) { throw "Process $RootProcessId is not running" }
        break
    }
    $processes = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    $elapsed = $timer.Elapsed.TotalSeconds
    $cpuSamples = @($processes | ForEach-Object {
        try {
            $started = $_.StartTime.ToUniversalTime().Ticks
            [pscustomobject]@{
                Identity = "$($_.Id):$started"
                StartedUtcTicks = $started
                CpuSeconds = [double]$_.CPU
            }
        } catch { } # A child can exit between enumeration and opening its handle.
    })
    $workingBytes = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum
    $privateBytes = ($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
    $handles = ($processes | Measure-Object -Property Handles -Sum).Sum
    $cpuPercent = $null
    $cpuDelta = Get-CpuSampleDelta $previousCpu $cpuSamples $(if ($previousTime) { $previousTime.ToUniversalTime().Ticks } else { $now.ToUniversalTime().Ticks })
    if ($null -ne $previousTime) {
        $wallSeconds = $elapsed - $previousElapsed
        if ($wallSeconds -gt 0) {
            $cpuPercent = [math]::Round(
                $cpuDelta.DeltaCpuSeconds / $wallSeconds * 100, 2)
        }
    }
    $rows.Add([pscustomobject]@{
        Utc = $now.ToUniversalTime().ToString('o')
        Scenario = $Scenario
        ProcessCount = $processes.Count
        ProcessIds = (($processes | Select-Object -ExpandProperty Id) -join ',')
        WorkingSetBytes = [long]$workingBytes
        PrivateBytes = [long]$privateBytes
        Handles = [int]$handles
        CpuOneCorePercent = $cpuPercent
    })
    $previousCpu = $cpuDelta.Current
    $previousTime = $now
    $previousElapsed = $elapsed
    if ((Get-Date) -ge $finish) { break }
    Start-Sleep -Seconds $IntervalSeconds
} while ((Get-Date) -lt $finish)

$rows | Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding UTF8
$working = $rows | Measure-Object -Property WorkingSetBytes -Average -Maximum
$private = $rows | Measure-Object -Property PrivateBytes -Average -Maximum
$cpu = $rows | Where-Object { $null -ne $_.CpuOneCorePercent } |
    Measure-Object -Property CpuOneCorePercent -Average -Maximum
[pscustomobject]@{
    Scenario = $Scenario
    RootProcessId = $RootProcessId
    Samples = $rows.Count
    AverageWorkingSetBytes = [long]$working.Average
    MaximumWorkingSetBytes = [long]$working.Maximum
    AveragePrivateBytes = [long]$private.Average
    MaximumPrivateBytes = [long]$private.Maximum
    AverageCpuOneCorePercent = [math]::Round($cpu.Average, 2)
    MaximumCpuOneCorePercent = [math]::Round($cpu.Maximum, 2)
    Csv = $OutputCsv
    CpuSamplingLimit = 'Child processes born and exited entirely between samples are not observable; one-core CPU percent is not normalized by logical processor count.'
}
