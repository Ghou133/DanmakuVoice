param(
    [Parameter(Mandatory = $true)][string]$Commit,
    [string]$OutputZip = 'dist\DanmakuVoice-source.zip',
    [string]$FfmpegSourceArchive,
    [string]$FfmpegCopying,
    [string]$FfmpegLicenseDescription,
    [switch]$RequireCleanCheckout
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = Join-Path $repoRoot 'dist'
$repoTop = (& git -C $repoRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($repoTop) -ne $repoRoot) {
    throw 'The source script must run from the DanmakuVoice Git repository'
}
$fullCommit = (& git -C $repoRoot rev-parse --verify "$Commit^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $fullCommit -notmatch '^[0-9a-f]{40}$') {
    throw "Not a Git commit: $Commit"
}
if ($RequireCleanCheckout) {
    $head = (& git -C $repoRoot rev-parse HEAD).Trim()
    $changes = @(& git -C $repoRoot status --porcelain --untracked-files=normal)
    if ($head -ne $fullCommit -or $changes.Count -gt 0) {
        throw 'The checkout must be clean and at the selected commit to match a built binary'
    }
}

$providedFfmpeg = @(@($FfmpegSourceArchive, $FfmpegCopying, $FfmpegLicenseDescription) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($providedFfmpeg.Count -ne 0 -and $providedFfmpeg.Count -ne 3) {
    throw 'Provide all three FFmpeg source/license paths together'
}
if ($RequireCleanCheckout -and $providedFfmpeg.Count -ne 3) {
    throw 'Release-matched source ZIP requires the corresponding FFmpeg source and license files'
}
if ($providedFfmpeg.Count -eq 3) {
    $FfmpegSourceArchive = (Resolve-Path -LiteralPath $FfmpegSourceArchive).Path
    $FfmpegCopying = (Resolve-Path -LiteralPath $FfmpegCopying).Path
    $FfmpegLicenseDescription = (Resolve-Path -LiteralPath $FfmpegLicenseDescription).Path
    $expected = @{
        $FfmpegSourceArchive = '8C3850283EB25FA026482078A04051E0BE17347B09EF81A0849BEC15A96E002E'
        $FfmpegCopying = '246041B6ECF9BC32D718A62C57877C78B5EB397B6467E74ED7AE2626AB189C30'
        $FfmpegLicenseDescription = '2E1D16C72FD74E12063776371DA757322F8B77589386532F4FD8634BDE7DE1AF'
    }
    foreach ($path in $expected.Keys) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
        if ($actual -ne $expected[$path]) { throw "FFmpeg source/license hash mismatch: $path" }
    }
}

if (-not [IO.Path]::IsPathRooted($OutputZip)) { $OutputZip = Join-Path $repoRoot $OutputZip }
$OutputZip = [IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $OutputZip) { throw "Output already exists: $OutputZip" }
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputZip) -Force | Out-Null

$tracked = @(& git -C $repoRoot ls-tree -r --name-only $fullCommit)
if ($LASTEXITCODE -ne 0 -or $tracked.Count -eq 0) { throw 'Could not list committed source files' }
$manifestPath = 'third-party/license-supplements/manifest.json'
if ($manifestPath -notin $tracked) { throw 'The committed Rust license supplement manifest is required' }
$manifestJson = (& git -C $repoRoot show "${fullCommit}:$manifestPath") -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Could not read committed Rust license supplement manifest' }
$manifest = $manifestJson | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw 'Unsupported Rust license supplement manifest version' }
$supplementPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
[void]$supplementPaths.Add($manifestPath)
foreach ($entry in $manifest.entries) {
    foreach ($file in $entry.files) {
        if ($file.path -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
            throw "Invalid committed supplement path: $($file.path)"
        }
        $path = "third-party/license-supplements/$($file.path)"
        if ($path -notin $tracked) { throw "Missing committed supplement file: $path" }
        [void]$supplementPaths.Add($path)
    }
}
$rootFiles = @('.gitignore', '.gitattributes', 'AGENTS.md', 'ARCHITECTURE.md', 'Cargo.toml',
    'Cargo.lock', 'LICENSE', 'NOTICE.md', 'MIGRATION.md', 'PROGRESS.md', 'README.md', 'rust-toolchain.toml')
$prefixes = @('crates/', 'docs/', 'scripts/', 'packaging/', '.github/workflows/')
foreach ($path in $tracked) {
    $allowed = ($path -in $rootFiles) -or $supplementPaths.Contains($path) -or
        @($prefixes | Where-Object { $path.StartsWith($_, [StringComparison]::Ordinal) }).Count -gt 0
    if (-not $allowed) { throw "Review unlisted tracked path before source packaging: $path" }
    if ($path -match '(?i)(^|/)(cookies\.json|session\.json|\.env(?:\..*)?|[^/]+\.(?:sqlite|db|pem|key|p12|pfx|kdbx))$') {
        throw "Refusing credential or database path in source archive: $path"
    }
}
foreach ($required in @('Cargo.lock', 'LICENSE', 'NOTICE.md', 'README.md', 'scripts/build-minimal-ffmpeg-wsl.sh',
    'scripts/package-portable.ps1', 'scripts/package-source.ps1', 'scripts/build-from-source.ps1',
    'scripts/verify-rust-license-copies.py', 'docs/RELEASE-LICENSE-AUDIT.md',
    'crates/desktop/embedded/ffmpeg.exe', $manifestPath)) {
    if ($required -notin $tracked) { throw "Required committed source missing: $required" }
}

function Get-WindowsBuildPackages([string]$sourceRoot, [string]$cargoPath) {
    $manifestFile = Join-Path $sourceRoot 'Cargo.toml'
    $json = & $cargoPath metadata --locked --format-version=1 --filter-platform x86_64-pc-windows-msvc --manifest-path $manifestFile
    if ($LASTEXITCODE -ne 0) { throw "Cargo metadata for archived source failed: $LASTEXITCODE" }
    $metadata = $json | ConvertFrom-Json
    $desktop = @($metadata.packages | Where-Object { $_.name -eq 'danmakuvoice' -and -not $_.source })
    if ($desktop.Count -ne 1) { throw 'Could not identify the archived desktop package' }
    $nodes = @{}
    $packages = @{}
    foreach ($node in $metadata.resolve.nodes) { $nodes[$node.id] = $node }
    foreach ($package in $metadata.packages) { $packages[$package.id] = $package }
    $seen = [Collections.Generic.HashSet[string]]::new()
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($desktop[0].id)
    while ($pending.Count -gt 0) {
        $id = $pending.Dequeue()
        if (-not $seen.Add($id)) { continue }
        foreach ($dependency in $nodes[$id].deps) {
            if (@($dependency.dep_kinds | Where-Object { $_.kind -ne 'dev' }).Count -gt 0) {
                $pending.Enqueue($dependency.pkg)
            }
        }
    }
    return @($seen | ForEach-Object { $packages[$_] } |
        Where-Object { $_.source } | Sort-Object name, version)
}

function Get-AllLockedRustPackages([string]$sourceRoot, [string]$cargoPath) {
    # Cargo resolves the whole lock file before a release build, including
    # dev-only and other-platform packages. Keep those sources in the source
    # ZIP too so the extracted project can build with an empty Cargo cache.
    $manifestFile = Join-Path $sourceRoot 'Cargo.toml'
    $json = & $cargoPath metadata --locked --format-version=1 --manifest-path $manifestFile
    if ($LASTEXITCODE -ne 0) { throw "Full Cargo metadata for archived source failed: $LASTEXITCODE" }
    $metadata = $json | ConvertFrom-Json
    return @($metadata.packages | Where-Object { $_.source } | Sort-Object name, version)
}

function Get-LockChecksums([string]$lockPath) {
    $text = Get-Content -LiteralPath $lockPath -Raw
    $checksums = @{}
    foreach ($block in [regex]::Matches($text, '(?ms)^\[\[package\]\]\r?\n(.*?)(?=^\[\[package\]\]|\z)')) {
        $body = $block.Groups[1].Value
        $name = [regex]::Match($body, '(?m)^name = "([^"]+)"\r?$').Groups[1].Value
        $version = [regex]::Match($body, '(?m)^version = "([^"]+)"\r?$').Groups[1].Value
        $source = [regex]::Match($body, '(?m)^source = "([^"]+)"\r?$').Groups[1].Value
        $checksum = [regex]::Match($body, '(?m)^checksum = "([0-9a-f]{64})"\r?$').Groups[1].Value
        if ($source -eq 'registry+https://github.com/rust-lang/crates.io-index') {
            if (-not $name -or -not $version -or -not $checksum) {
                throw "Incomplete crates.io package in archived Cargo.lock: $name $version"
            }
            $key = "$name $version"
            if ($checksums.ContainsKey($key)) { throw "Duplicate lock package: $key" }
            $checksums[$key] = $checksum
        }
    }
    if ($checksums.Count -eq 0) { throw 'No crates.io checksums found in archived Cargo.lock' }
    return $checksums
}

function Copy-LockedRustSources([string]$sourceRoot, [string]$cargoPath) {
    $buildPackages = @(Get-WindowsBuildPackages $sourceRoot $cargoPath)
    $packages = @(Get-AllLockedRustPackages $sourceRoot $cargoPath)
    $checksums = Get-LockChecksums (Join-Path $sourceRoot 'Cargo.lock')
    $buildKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($package in $buildPackages) {
        if (-not $buildKeys.Add("$($package.name) $($package.version)")) {
            throw "Duplicate Windows build package: $($package.name) $($package.version)"
        }
    }
    if ($packages.Count -ne $checksums.Count) {
        throw "Full Cargo metadata and Cargo.lock package counts differ: $($packages.Count) versus $($checksums.Count)"
    }
    $destinationRoot = Join-Path $sourceRoot 'third-party\Rust\crate-archives'
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    $buildManifest = [Collections.Generic.List[object]]::new()
    $resolverManifest = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($package in $packages) {
        $key = "$($package.name) $($package.version)"
        if ($package.source -ne 'registry+https://github.com/rust-lang/crates.io-index' -or
            -not $checksums.ContainsKey($key) -or -not $seen.Add($key)) {
            throw "Unverified Rust source registry or missing lock checksum: $key"
        }
        $crateRoot = Split-Path -Parent $package.manifest_path
        $srcRoot = Split-Path -Parent (Split-Path -Parent $crateRoot)
        if ((Split-Path -Leaf $srcRoot) -ne 'src') {
            throw "Unexpected Cargo registry source path for $key at $crateRoot"
        }
        $registryIndex = Split-Path -Leaf (Split-Path -Parent $crateRoot)
        $cacheRoot = Join-Path (Split-Path -Parent $srcRoot) "cache\$registryIndex"
        $archiveName = "$($package.name)-$($package.version).crate"
        $archive = Join-Path $cacheRoot $archiveName
        if (-not (Test-Path -LiteralPath $archive)) {
            throw "Missing cached source archive for $key at $archive"
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
        if ($actual -ne $checksums[$key]) {
            throw "Cargo.lock SHA-256 mismatch for $key; expected $($checksums[$key]); got $actual"
        }
        Copy-Item -LiteralPath $archive -Destination (Join-Path $destinationRoot $archiveName)
        $entry = [ordered]@{
            name = $package.name
            version = $package.version
            archive = $archiveName
            sha256 = $checksums[$key]
            source = "https://static.crates.io/crates/$($package.name)/$archiveName"
        }
        $resolverManifest.Add($entry)
        if ($buildKeys.Contains($key)) { $buildManifest.Add($entry) }
    }
    if ($buildManifest.Count -ne $buildKeys.Count) {
        throw "Windows build package count differs from archived source: $($buildManifest.Count) versus $($buildKeys.Count)"
    }
    $inventory = [ordered]@{
        scope = 'DanmakuVoice Windows x64 normal/build dependencies, excluding dev-only packages'
        source = 'Archived Cargo.lock, verified against local crates.io .crate bytes'
        archives = $buildManifest.ToArray()
    }
    $inventory | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $sourceRoot 'third-party\Rust\CRATE-ARCHIVES.json') -Encoding UTF8
    $resolverInventory = [ordered]@{
        schemaVersion = 1
        scope = 'All crates.io packages in the archived Cargo.lock, including resolver-only packages'
        source = 'Archived Cargo.lock, verified against local crates.io .crate bytes'
        archives = $resolverManifest.ToArray()
    }
    $resolverInventory | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $sourceRoot 'third-party\Rust\CRATE-RESOLVER-ARCHIVES.json') -Encoding UTF8
    Write-Host "Verified Rust source archives: $($buildManifest.Count) Windows build, $($resolverManifest.Count) total locked"
    return [PSCustomObject]@{ Build = $buildManifest.Count; Resolver = $resolverManifest.Count }
}

function Write-DeterministicSourceZip([string]$sourceRoot, [string]$outputZip) {
    Add-Type -AssemblyName System.IO.Compression
    $rootName = Split-Path -Leaf $sourceRoot
    $relativePaths = [string[]]@(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/') })
    [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
    $zipStream = [IO.File]::Open($outputZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
        $zip = [IO.Compression.ZipArchive]::new(
            $zipStream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8
        )
        try {
            $timestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            foreach ($relative in $relativePaths) {
                $entry = $zip.CreateEntry(
                    "$rootName/$relative", [IO.Compression.CompressionLevel]::NoCompression
                )
                $entry.LastWriteTime = $timestamp
                $input = [IO.File]::OpenRead((Join-Path $sourceRoot $relative.Replace('/', '\')))
                $output = $entry.Open()
                try { $input.CopyTo($output) }
                finally {
                    $output.Dispose()
                    $input.Dispose()
                }
            }
        } finally { $zip.Dispose() }
    } finally { $zipStream.Dispose() }
}

$scratch = Join-Path $distRoot ("source-stage-{0}" -f [guid]::NewGuid().ToString('N'))
$archive = Join-Path $scratch 'git-archive.zip'
$unpacked = Join-Path $scratch 'unpacked'
$shortCommit = $fullCommit.Substring(0, 12)
$sourceRoot = Join-Path $unpacked "DanmakuVoice-source-$shortCommit"
$verification = Join-Path $scratch 'verified'
$completed = $false
$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargoPath = if ($cargo) { $cargo.Source } else { Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe' }
if (-not (Test-Path -LiteralPath $cargoPath)) { throw 'cargo.exe was not found for Rust source verification' }
try {
    New-Item -ItemType Directory -Path $scratch -Force | Out-Null
    # Git for Windows may apply core.autocrlf to git archive output. Export
    # committed blob bytes unchanged so SHA-pinned license texts stay exact.
    $gitArgs = @('-c', 'core.autocrlf=false', '-C', $repoRoot, 'archive', '--format=zip', "--output=$archive",
        "--prefix=DanmakuVoice-source-$shortCommit/", $fullCommit) + $tracked
    & git @gitArgs
    if ($LASTEXITCODE -ne 0) { throw "Git archive failed: $LASTEXITCODE" }
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $embeddedFfmpeg = Join-Path $sourceRoot 'crates\desktop\embedded\ffmpeg.exe'
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $embeddedFfmpeg).Hash -ne
        '8FB7ECC11F4F7A441AE7075A81C984289250B166E78DEDF51900BBEB1A96EF4D') {
        throw 'Committed embedded FFmpeg differs from the reviewed Windows x64 build'
    }
    foreach ($entry in $manifest.entries) {
        foreach ($file in $entry.files) {
            if ($file.sha256 -notmatch '^[0-9A-Fa-f]{64}$') {
                throw "Invalid committed supplement SHA-256: $($file.path)"
            }
            $supplement = Join-Path $sourceRoot "third-party\license-supplements\$($file.path.Replace('/', '\'))"
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $supplement).Hash
            if ($actual -ne $file.sha256) {
                throw "Committed supplement SHA-256 mismatch: $($file.path)"
            }
        }
    }

    $provenance = @(
        "DanmakuVoice source commit: $fullCommit"
        'Files are an explicit allowlist from this Git commit, not the working tree.'
        'The FFmpeg source, when present below third-party/FFmpeg, is the verified official 9.0.2 archive.'
        'Rust dependencies are pinned by Cargo.lock; the embedded FFmpeg binary is hash-pinned and corresponds to the included official source.'
    ) -join "`n"
    Set-Content -LiteralPath (Join-Path $sourceRoot 'SOURCE-COMMIT.txt') -Value $provenance -Encoding UTF8
    if ($providedFfmpeg.Count -eq 3) {
        $ffmpegDir = Join-Path $sourceRoot 'third-party\FFmpeg'
        New-Item -ItemType Directory -Path $ffmpegDir -Force | Out-Null
        Copy-Item -LiteralPath $FfmpegSourceArchive -Destination (Join-Path $ffmpegDir 'ffmpeg-9.0.2.tar.xz')
        Copy-Item -LiteralPath $FfmpegCopying -Destination (Join-Path $ffmpegDir 'COPYING.LGPLv2.1')
        Copy-Item -LiteralPath $FfmpegLicenseDescription -Destination (Join-Path $ffmpegDir 'LICENSE.md')
    }
    $rustArchives = Copy-LockedRustSources $sourceRoot $cargoPath
    Write-DeterministicSourceZip $sourceRoot $OutputZip
    Expand-Archive -LiteralPath $OutputZip -DestinationPath $verification
    $sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File)
    $verifiedRoot = Join-Path $verification "DanmakuVoice-source-$shortCommit"
    $verifiedFiles = @(Get-ChildItem -LiteralPath $verifiedRoot -Recurse -File)
    if ($verifiedFiles.Count -ne $sourceFiles.Count) {
        throw "Source ZIP extraction count mismatch: stage=$($sourceFiles.Count) extract=$($verifiedFiles.Count)"
    }
    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($sourceRoot.Length + 1)
        $extracted = Join-Path $verifiedRoot $relative
        if (-not (Test-Path -LiteralPath $extracted) -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne
            (Get-FileHash -Algorithm SHA256 -LiteralPath $extracted).Hash) {
            throw "Source ZIP extracted file differs: $relative"
        }
    }
    [PSCustomObject]@{
        Zip = $OutputZip
        Commit = $fullCommit
        ZipBytes = (Get-Item -LiteralPath $OutputZip).Length
        ZipSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputZip).Hash
        SourceFiles = @($tracked).Count
        RustArchives = $rustArchives.Build
        ResolverArchives = $rustArchives.Resolver
        ExtractedFiles = $verifiedFiles.Count
    }
    $completed = $true
} finally {
    if ($completed) {
        $safePrefix = [IO.Path]::GetFullPath($distRoot).TrimEnd('\') + '\'
        $resolvedScratch = [IO.Path]::GetFullPath($scratch)
        if (-not $resolvedScratch.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove staging path outside dist: $resolvedScratch"
        }
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    } else {
        Write-Warning "Source packaging failed; staging preserved at $scratch"
    }
}
