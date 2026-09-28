param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [ValidateRange(2, 3600)][int]$Seconds = 30,
    [ValidateRange(1, 60)][int]$IntervalSeconds = 1,
    [string]$Scenario = 'foreground-idle',
    [string]$OutputCsv
)

$ErrorActionPreference = 'Stop'
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
$previousCpu = $null
$previousTime = $null
$finish = (Get-Date).AddSeconds($Seconds)
do {
    $now = Get-Date
    $ids = @(Get-ProcessTreeIds $RootProcessId)
    if ($ids.Count -eq 0) {
        if ($rows.Count -eq 0) { throw "Process $RootProcessId is not running" }
        break
    }
    $processes = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    $cpuSeconds = ($processes | Measure-Object -Property CPU -Sum).Sum
    $workingBytes = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum
    $privateBytes = ($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
    $handles = ($processes | Measure-Object -Property Handles -Sum).Sum
    $cpuPercent = $null
    if ($null -ne $previousCpu) {
        $wallSeconds = ($now - $previousTime).TotalSeconds
        if ($wallSeconds -gt 0) {
            $cpuPercent = [math]::Round(
                [math]::Max(0.0, ($cpuSeconds - $previousCpu) / $wallSeconds * 100), 2)
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
    $previousCpu = $cpuSeconds
    $previousTime = $now
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
}
