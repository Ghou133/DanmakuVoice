param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$Output = (Join-Path $PSScriptRoot '../target/native-window-lifecycle/x-close'),
    [string]$FixtureDirectory,
    [ValidateSet('ui', 'window', 'repeat', 'force')][string]$ExitMode = 'ui',
    [switch]$ExternalFixture,
    [int]$OverlayPort = 0
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw 'Choose a new output directory; previous evidence is preserved.' }
New-Item -ItemType Directory -Path $Output | Out-Null
$dataDirectory = Join-Path $Output 'isolated-data'
if ($FixtureDirectory) {
    $FixtureDirectory = (Resolve-Path -LiteralPath $FixtureDirectory).Path
    if (!(Test-Path -LiteralPath (Join-Path $FixtureDirectory 'fixture-owned.txt'))) { throw 'Explicit isolated fixture marker is required.' }
    $dataDirectory = Join-Path $FixtureDirectory 'data'
} else {
    New-Item -ItemType Directory -Path $dataDirectory | Out-Null
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeLifecycleTest {
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint kind);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
}
'@
function Get-ShellProxySnapshot {
    $seen = [Collections.Generic.HashSet[long]]::new()
    $proxyMatches = @()
    $allCount = 0
    $window = [NativeLifecycleTest]::GetWindow([NativeLifecycleTest]::GetDesktopWindow(), 5)
    while ($window -ne [IntPtr]::Zero -and $seen.Add($window.ToInt64())) {
        $class = [Text.StringBuilder]::new(256)
        [void][NativeLifecycleTest]::GetClassName($window, $class, $class.Capacity)
        if ($class.ToString() -eq 'Windows.Internal.Shell.TabProxyWindow') {
            $allCount++
            $title = [Text.StringBuilder]::new(512)
            [void][NativeLifecycleTest]::GetWindowText($window, $title, $title.Capacity)
            if ($title.ToString() -match 'DanmakuVoice|超绝可爱弹幕姬') {
                $ownerPid = [uint32]0
                [void][NativeLifecycleTest]::GetWindowThreadProcessId($window, [ref]$ownerPid)
                $proxyMatches += [pscustomobject]@{ hwnd = ('0x{0:x}' -f $window.ToInt64()); pid = $ownerPid; overlay = $title.ToString().Contains('OBS 叠加层') }
            }
        }
        $window = [NativeLifecycleTest]::GetWindow($window, 2)
    }
    return [pscustomobject]@{ desktopWindows = $seen.Count; allProxyCount = $allCount; appProxies = $proxyMatches }
}
function Get-OwnedTauriWindow([int]$RootPid) {
    $seen = [Collections.Generic.HashSet[long]]::new()
    $window = [NativeLifecycleTest]::GetWindow([NativeLifecycleTest]::GetDesktopWindow(), 5)
    while ($window -ne [IntPtr]::Zero -and $seen.Add($window.ToInt64())) {
        $ownerPid = [uint32]0
        [void][NativeLifecycleTest]::GetWindowThreadProcessId($window, [ref]$ownerPid)
        if ($ownerPid -eq $RootPid) {
            $class = [Text.StringBuilder]::new(256)
            [void][NativeLifecycleTest]::GetClassName($window, $class, $class.Capacity)
            if ($class.ToString() -eq 'Tauri Window') { return $window }
        }
        $window = [NativeLifecycleTest]::GetWindow($window, 2)
    }
    return [IntPtr]::Zero
}
function Get-OwnedProcessTree([int]$RootPid) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)
    return @(Select-AuditProcessTree $all $RootPid | Select-Object ProcessId,ParentProcessId,Name,CreationDate)
}

$before = Get-ShellProxySnapshot
$owned = $null
$handle = [IntPtr]::Zero
$result = [ordered]@{ passed = $false; evidence = 'Real native isolated offline application; UIAutomation invokes the actual titlebar X; only this newly created process is closed. Daily app, OBS, Explorer and existing TTS are unchanged.'; executable = $Executable; executableSha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant(); isolatedDataDirectory = $dataDirectory; before = $before }
try {
    $arguments = @('--data-dir', ('"{0}"' -f $dataDirectory))
    if (!$FixtureDirectory) { $arguments += '--disable-network' }
    $owned = Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $result.pid = $owned.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $owned.Refresh()
        if ($owned.HasExited) { throw "Isolated candidate exited before its window appeared: $($owned.ExitCode)" }
        $handle = Get-OwnedTauriWindow $owned.Id
        if ($handle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($handle -eq [IntPtr]::Zero) { throw 'No native main window appeared.' }
    $condition = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, '关闭'),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
    )
    $close = $null
    do {
        $root = [Windows.Automation.AutomationElement]::FromHandle($handle)
        $close = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if ($close) { break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$close) { throw 'Actual titlebar close button was not exposed to UIAutomation.' }
    $fixtureRecords = @()
    if ($FixtureDirectory) {
        $fixtureDeadline = [DateTime]::UtcNow.AddSeconds(35)
        do {
            $serviceRecord = Join-Path $FixtureDirectory 'service/service.json'
            $workerRecord = Join-Path $FixtureDirectory 'service/worker.json'
            if ((Test-Path -LiteralPath $serviceRecord) -and (Test-Path -LiteralPath $workerRecord)) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $fixtureDeadline)
        $fixtureRecords = @((Get-Content -LiteralPath $serviceRecord -Raw | ConvertFrom-Json), (Get-Content -LiteralPath $workerRecord -Raw | ConvertFrom-Json))
        $result.fixtureRecords = $fixtureRecords
        $result.fixtureMode = (Get-Content -LiteralPath (Join-Path $FixtureDirectory 'service/mode.txt') -Raw).Trim()
        $result.externalFixture = $ExternalFixture.IsPresent
        $result.evidence = 'Native application with explicitly seeded test-only loopback service and no account credentials. No real TTS, audio, OBS, or broadcast action.'
    }
    $overlayClient = $null
    if ($OverlayPort) {
        $overlayClient = [Net.Sockets.TcpClient]::new('127.0.0.1', $OverlayPort)
        $partialRequest = [Text.Encoding]::ASCII.GetBytes("GET / HTTP/1.1`r`nHost: localhost`r`n")
        $overlayClient.GetStream().Write($partialRequest, 0, $partialRequest.Length)
    }
    $result.beforeCloseProcesses = @(Get-OwnedProcessTree $owned.Id)
    $result.whileRunning = Get-ShellProxySnapshot
    $result.buttonName = $close.Current.Name
    $pattern = $close.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $result.exitMode = $ExitMode
    switch ($ExitMode) {
        'ui' { $pattern.Invoke() }
        'window' { [void][NativeLifecycleTest]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
        'repeat' { 1..5 | ForEach-Object { [void][NativeLifecycleTest]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } }
        'force' { $owned.Kill() }
    }
    if (!$owned.WaitForExit(20000)) { throw 'Actual X did not exit the isolated main process within 20 seconds.' }
    $clock.Stop()
    $result.exitMilliseconds = $clock.ElapsedMilliseconds
    $result.exitCode = $owned.ExitCode
    $result.mainHwndGone = ![NativeLifecycleTest]::IsWindow($handle)
    $remaining = @()
    $descendantDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $current = @(Get-CimInstance Win32_Process -Property ProcessId,CreationDate)
        $remaining = @(Select-AuditSurvivingProcesses $result.beforeCloseProcesses $current)
        if (!$remaining.Count) { break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $descendantDeadline)
    $result.remainingOwnedPids = @($remaining | ForEach-Object {$_.ProcessId})
    $result.after = Get-ShellProxySnapshot
    if (($ExitMode -ne 'force' -and $owned.ExitCode -ne 0) -or !$result.mainHwndGone -or $remaining.Count) { throw 'Own main HWND/process or WebView2 descendants survived exit.' }
    $result.portChecks = @()
    foreach ($record in $fixtureRecords) {
        if ($ExternalFixture) {
            if (!(Get-Process -Id $record.pid -ErrorAction SilentlyContinue)) { throw 'An external fixture was terminated by app exit.' }
            $client = [Net.Sockets.TcpClient]::new('127.0.0.1', $record.port)
            $client.Dispose()
            $result.portChecks += [pscustomobject]@{ port=$record.port; result='external preserved' }
        } else {
            if (Get-Process -Id $record.pid -ErrorAction SilentlyContinue) { throw 'Owned service descendant survived app exit.' }
            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $record.port)
            try { $listener.Start(); $result.portChecks += [pscustomobject]@{ port=$record.port; result='released and rebound' } } finally { $listener.Stop() }
        }
    }
    if ($overlayClient) {
        $overlayClient.ReceiveTimeout = 1500
        try { $read = $overlayClient.GetStream().ReadByte(); if ($read -ne -1) { throw 'Incomplete HTTP client did not close.' } }
        catch [Net.Sockets.SocketException] { }
        catch [IO.IOException] { if ($_.Exception.InnerException.SocketErrorCode -eq [Net.Sockets.SocketError]::TimedOut) { throw } }
        finally { $overlayClient.Dispose() }
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $OverlayPort)
        try { $listener.Start(); $result.overlayPortReleased = $true } finally { $listener.Stop() }
    }
    if ($result.after.appProxies.Count -gt $before.appProxies.Count) { throw 'Isolated lifecycle left additional app Shell proxy windows.' }
    $result.passed = $true
} catch {
    $result.error = $_.Exception.Message
    throw
} finally {
    # Cooperative cleanup is restricted to the handle created above. No
    # arbitrary process termination and no operation on the daily instance.
    if ($owned -and !$owned.HasExited -and $handle -ne [IntPtr]::Zero) {
        [void][NativeLifecycleTest]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        [void]$owned.WaitForExit(15000)
    }
    $result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $Output 'results.json') -Encoding UTF8
}
$result | ConvertTo-Json -Depth 7
