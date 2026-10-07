$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
$start = [DateTime]::Parse('2026-10-06T18:19:00Z').ToUniversalTime()
function ProcessRecord([int]$Id, [int]$Parent, [int]$Offset) {
    [pscustomobject]@{ ProcessId=$Id; ParentProcessId=$Parent; CreationDate=$start.AddSeconds($Offset) }
}
$root = ProcessRecord 10 1 0
$child = ProcessRecord 20 10 1
$leaf = ProcessRecord 30 20 2
# Old compiler helper still names PID 20, which the test child now reuses.
$unrelated = ProcessRecord 40 20 -180
$oldLeaf = ProcessRecord 41 40 -179
$all = @($root, $child, $leaf, $unrelated, $oldLeaf)
$tree = @(Select-AuditProcessTree $all 10)
if (($tree.ProcessId -join ',') -ne '10,20,30') { throw 'Reused parent PID admitted an older unrelated process.' }
if (@(Select-AuditProcessTree $all 99).Count) { throw 'Missing root produced a tree.' }
$current = @($leaf, (ProcessRecord 20 99 90), $unrelated)
$survivors = @(Select-AuditSurvivingProcesses $tree $current)
if (($survivors.ProcessId -join ',') -ne '30') { throw 'Reused child PID was treated as the recorded process.' }
if (@(Select-AuditSurvivingProcesses $tree @()).Count) { throw 'Exited processes reported alive.' }
Write-Output '4 process-identity regression checks passed; no real process was started or stopped.'
