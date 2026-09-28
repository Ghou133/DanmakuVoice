param(
    [Parameter(Mandatory = $true)][string]$ApplicationExe,
    [ValidateRange(2, 60)][int]$ObserveSeconds = 8
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The single-EXE launch smoke test requires Windows' }
$originalExe = (Resolve-Path -LiteralPath $ApplicationExe).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("DanmakuVoice-single-exe-smoke-{0}" -f [guid]::NewGuid().ToString('N'))
$appDir = Join-Path $scratch 'app'
$data = Join-Path $scratch 'isolated-data'
$app = Join-Path $appDir ([IO.Path]::GetFileName($originalExe))
$ffmpeg = Join-Path $data 'cache\ffmpeg\ffmpeg-8fb7ecc11f4f7a441ae7075a81c984289250b166e78dedf51900bbeb1a96ef4d.exe'
$process = $null

try {
    New-Item -ItemType Directory -Path $appDir, $data -Force | Out-Null
    Copy-Item -LiteralPath $originalExe -Destination $app
    # A path saved by an older build must not override the embedded decoder.
    Set-Content -LiteralPath (Join-Path $data 'desktop-paths.json') `
        -Value '{"ffmpeg_path":"C:\\old-missing\\ffmpeg.exe"}' -Encoding UTF8
    if (@(Get-ChildItem -LiteralPath $appDir -File).Count -ne 1) {
        throw 'The smoke directory must contain only the application EXE'
    }

    # A fresh directory prevents the smoke test from reading or changing the
    # current user's normal settings, credentials, or local TTS configuration.
    $arguments = '--data-dir "{0}" --disable-network' -f $data
    $previousPath = $env:PATH
    try {
        $env:PATH = Join-Path $env:SystemRoot 'System32'
        $process = Start-Process -FilePath $app -ArgumentList $arguments `
            -WorkingDirectory $appDir -WindowStyle Hidden -PassThru
    } finally {
        $env:PATH = $previousPath
    }
    for ($second = 0; $second -lt $ObserveSeconds; $second++) {
        Start-Sleep -Seconds 1
        $process.Refresh()
        if ($process.HasExited) {
            throw "The single-file application exited during first launch (code $($process.ExitCode)); check WebView2 Runtime and Windows dependencies"
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $data 'danmakuvoice.sqlite3') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $data 'webview\EBWebView') -PathType Container)) {
        throw 'The application stayed alive but did not initialize its database and WebView2 profile'
    }
    if (-not (Test-Path -LiteralPath $ffmpeg -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $ffmpeg).Hash -ne
        '8FB7ECC11F4F7A441AE7075A81C984289250B166E78DEDF51900BBEB1A96EF4D') {
        throw 'Application did not materialize the pinned embedded FFmpeg in its private data directory'
    }
    Write-Host "PASS: single EXE initialized WebView2 and extracted its hash-checked FFmpeg without a sidecar for $ObserveSeconds seconds with network disabled and a restricted PATH"
} finally {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
        $process.Dispose()
    }
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    if (-not $resolvedScratch.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove smoke directory outside the temporary root: $resolvedScratch"
    }
    if (Test-Path -LiteralPath $resolvedScratch) {
        for ($attempt = 0; $attempt -lt 8 -and (Test-Path -LiteralPath $resolvedScratch); $attempt++) {
            try { Remove-Item -LiteralPath $resolvedScratch -Recurse -Force -ErrorAction Stop }
            catch {
                if ($attempt -eq 7) {
                    Write-Warning "Smoke directory could not be removed: $resolvedScratch ($_)"
                } else {
                    # WebView2 may still be closing files after its parent exits.
                    Start-Sleep -Milliseconds 350
                }
            }
        }
    }
}
