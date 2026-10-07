param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$TestExecutable,
    [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$TestExecutable = (Resolve-Path -LiteralPath $TestExecutable).Path
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw 'Choose a new evidence directory.' }
New-Item -ItemType Directory -Path $Output | Out-Null
$fixtureExe = Join-Path $Output 'fixture.exe'
& rustc --edition 2024 -O (Join-Path $PSScriptRoot 'fixtures/lifecycle_service.rs') -o $fixtureExe
if ($LASTEXITCODE) { throw 'Fixture compilation failed.' }
function Get-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
$results = @()
$cases = @(
    @{name='ready-x'; mode='ready'; exit='ui'},
    @{name='starting-close'; mode='starting'; exit='window'},
    @{name='ready-repeat'; mode='ready'; exit='repeat'},
    @{name='failed-start'; mode='fail'; exit='ui'},
    @{name='ready-force'; mode='ready'; exit='force'},
    @{name='external-x'; mode='ready'; exit='ui'; external=$true},
    @{name='restart-x-1'; mode='ready'; exit='ui'},
    @{name='restart-x-2'; mode='ready'; exit='ui'}
)
foreach ($case in $cases) {
    $root = Join-Path $Output $case.name
    $service = Join-Path $root 'service'
    New-Item -ItemType Directory -Path (Join-Path $service 'runtime'), (Join-Path $service 'GPT_SoVITS/configs') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'fixture-owned.txt') -Value 'Test-only isolated native lifecycle fixture.'
    Set-Content -LiteralPath (Join-Path $service 'mode.txt') -Value $case.mode
    Set-Content -LiteralPath (Join-Path $service 'api_v2.py') -Value '# Never executed: test fixture'
    Set-Content -LiteralPath (Join-Path $service 'GPT_SoVITS/configs/tts_infer.yaml') -Value '# Test fixture'
    Copy-Item -LiteralPath $fixtureExe -Destination (Join-Path $service 'runtime/python.exe')
    $port = Get-FreePort
    $overlayPort = Get-FreePort
    $env:DANMAKUVOICE_NATIVE_LIFECYCLE_DIR = $root
    $env:DANMAKUVOICE_NATIVE_LIFECYCLE_PORT = [string]$port
    $env:DANMAKUVOICE_NATIVE_OVERLAY_PORT = [string]$overlayPort
    try {
        & $TestExecutable 'app::tests::prepare_isolated_native_lifecycle_fixture' --exact --nocapture > (Join-Path $root 'prepare.log')
        if ($LASTEXITCODE -or !(Test-Path -LiteralPath (Join-Path $root 'data'))) { throw 'Isolated configuration preparation failed.' }
    } finally {
        Remove-Item Env:DANMAKUVOICE_NATIVE_LIFECYCLE_DIR, Env:DANMAKUVOICE_NATIVE_LIFECYCLE_PORT, Env:DANMAKUVOICE_NATIVE_OVERLAY_PORT
    }
    $external = $null
    try {
        if ($case.external) {
            $external = Start-Process -FilePath (Join-Path $service 'runtime/python.exe') -ArgumentList @('-p', $port) -WorkingDirectory $service -WindowStyle Hidden -PassThru
            $deadline = [DateTime]::UtcNow.AddSeconds(5)
            while (!(Test-Path -LiteralPath (Join-Path $service 'worker.json')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
        }
        $childArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-native-window-lifecycle.ps1'), '-Executable', $Executable, '-Output', (Join-Path $root 'evidence'), '-FixtureDirectory', $root, '-ExitMode', $case.exit, '-OverlayPort', [string]$overlayPort)
        if ($case.external) { $childArguments += '-ExternalFixture' }
        # A separate PowerShell process keeps each native helper type isolated.
        & powershell.exe @childArguments > (Join-Path $root 'native.log')
        if ($LASTEXITCODE) { throw "Native lifecycle failed: $($case.name)" }
        $results += Get-Content -LiteralPath (Join-Path $root 'evidence/results.json') -Raw | ConvertFrom-Json
        Write-Output "PASS $($case.name)"
    } finally {
        if ($external) {
            # Only test-owned external fixtures are cleaned up, after verifying
            # that application exit left them alive and listening.
            foreach ($recordName in @('worker.json', 'service.json')) {
                $recordPath = Join-Path $service $recordName
                if (Test-Path -LiteralPath $recordPath) {
                    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
                    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
                    if ($process -and $process.Path -eq (Join-Path $service 'runtime/python.exe')) { $process.Kill(); [void]$process.WaitForExit(5000) }
                }
            }
        }
        $results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $Output 'results.json') -Encoding UTF8
    }
}
