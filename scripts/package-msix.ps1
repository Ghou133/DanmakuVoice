param(
    [Parameter(Mandatory = $true)][string]$AuditZip,
    [Parameter(Mandatory = $true)][string]$ApplicationExe,
    [Parameter(Mandatory = $true)][string]$FfmpegBinary,
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$SourceZip,
    [string]$OutputDirectory = 'dist/store-submission',
    [switch]$DevelopmentSnapshot
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw "Refusing to overwrite $output" }
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -match '^10\.0\.\d+\.0$' -and (Test-Path (Join-Path $_.FullName 'x64/makeappx.exe')) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK MakeAppx.exe is required' }
$makeappx = Join-Path $sdk.FullName 'x64/makeappx.exe'
$stage = "$output-stage"
$stageArgs = @('stage', '--audit', $AuditZip, '--exe', $ApplicationExe, '--ffmpeg', $FfmpegBinary,
    '--commit', $Commit, '--version', $Version, '--output', $stage)
if ($SourceZip) { $stageArgs += @('--source', $SourceZip) }
if ($DevelopmentSnapshot) { $stageArgs += '--development' }
& python (Join-Path $PSScriptRoot 'package_msix.py') @stageArgs
if ($LASTEXITCODE -ne 0) { throw 'MSIX staging failed' }
New-Item -ItemType Directory -Path $output | Out-Null
$name = if ($DevelopmentSnapshot) { 'DanmakuVoice-development-unsigned.msix' } else { 'DanmakuVoice-store-submission.msix' }
$msix = Join-Path $output $name
# Keep semantic validation enabled. No certificate is created or installed here.
& $makeappx pack /d $stage /p $msix /no
if ($LASTEXITCODE -ne 0) { throw 'MakeAppx validation or packaging failed' }
& python (Join-Path $PSScriptRoot 'package_msix.py') verify --msix $msix --stage-dir $stage
if ($LASTEXITCODE -ne 0) { throw 'MSIX contents do not match staging' }
if ($SourceZip) { Copy-Item -LiteralPath $SourceZip -Destination (Join-Path $output 'DanmakuVoice-source.zip') }
@(
    'This is an UNSIGNED Microsoft Store submission package, not a public installer.'
    'Upload the MSIX to Partner Center product 9P4DFD8HGN03; Store certification/signing is still required.'
    'Do not tell users to install a test certificate or disable Smart App Control.'
    'Publish the exact source archive and privacy policy before submission.'
    "Source commit: $Commit"
    "Application version: $Version"
    "Development snapshot: $DevelopmentSnapshot"
) | Set-Content -LiteralPath (Join-Path $output 'SUBMISSION-README.txt') -Encoding utf8NoBOM
Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
} | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8NoBOM
Write-Host "PASS: MakeAppx validated and all staged bytes verified: $msix"
