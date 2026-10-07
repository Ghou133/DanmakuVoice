# Pure identity filters shared by the isolated native test harnesses.
# A PID alone is not a process identity: Windows can reuse a dead parent's PID.
function Select-AuditProcessTree([object[]]$Processes, [int]$RootPid) {
    $byId = @{}
    foreach ($item in $Processes) { $byId[[int]$item.ProcessId] = $item }
    if (!$byId.ContainsKey($RootPid)) { return @() }
    $seen = [Collections.Generic.HashSet[int]]::new()
    [void]$seen.Add($RootPid)
    $tree = @($byId[$RootPid])
    $frontier = @($RootPid)
    while ($frontier.Count) {
        $children = @($Processes | Where-Object {
            $parent = $byId[[int]$_.ParentProcessId]
            $_.ParentProcessId -in $frontier -and $parent -and
                $null -ne $_.CreationDate -and $null -ne $parent.CreationDate -and
                $_.CreationDate -ge $parent.CreationDate -and $seen.Add([int]$_.ProcessId)
        })
        $tree += $children
        $frontier = @($children | ForEach-Object { [int]$_.ProcessId })
    }
    return $tree
}

function Select-AuditSurvivingProcesses([object[]]$Recorded, [object[]]$Current) {
    $byId = @{}
    foreach ($item in $Current) { $byId[[int]$item.ProcessId] = $item }
    return @($Recorded | Where-Object {
        $live = $byId[[int]$_.ProcessId]
        $live -and $null -ne $_.CreationDate -and $live.CreationDate -eq $_.CreationDate
    })
}
