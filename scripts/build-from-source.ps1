param(
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$inventoryPath = Join-Path $sourceRoot 'third-party\Rust\CRATE-ARCHIVES.json'
$resolverInventoryPath = Join-Path $sourceRoot 'third-party\Rust\CRATE-RESOLVER-ARCHIVES.json'
$archiveRoot = Join-Path $sourceRoot 'third-party\Rust\crate-archives'
$lockPath = Join-Path $sourceRoot 'Cargo.lock'
$embeddedFfmpeg = Join-Path $sourceRoot 'crates\desktop\embedded\ffmpeg.exe'
foreach ($required in @($inventoryPath, $resolverInventoryPath, $archiveRoot, $lockPath,
        $embeddedFfmpeg, (Join-Path $sourceRoot 'SOURCE-COMMIT.txt'))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Extract the matching DanmakuVoice source ZIP first; missing $required"
    }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $embeddedFfmpeg).Hash -ne
    '8FB7ECC11F4F7A441AE7075A81C984289250B166E78DEDF51900BBEB1A96EF4D') {
    throw 'Embedded FFmpeg SHA-256 mismatch in the matching source ZIP'
}
$inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
$resolverInventory = Get-Content -LiteralPath $resolverInventoryPath -Raw | ConvertFrom-Json
$buildPackages = @($inventory.archives)
$packages = @($resolverInventory.archives)
if ($buildPackages.Count -eq 0 -or $packages.Count -eq 0 -or
    $resolverInventory.schemaVersion -ne 1) {
    throw 'Empty or unsupported Rust source archive inventory'
}

$lockChecksums = @{}
$lockText = Get-Content -LiteralPath $lockPath -Raw
foreach ($block in [regex]::Matches($lockText, '(?ms)^\[\[package\]\]\r?\n(.*?)(?=^\[\[package\]\]|\z)')) {
    $body = $block.Groups[1].Value
    $name = [regex]::Match($body, '(?m)^name = "([^"]+)"\r?$').Groups[1].Value
    $version = [regex]::Match($body, '(?m)^version = "([^"]+)"\r?$').Groups[1].Value
    $source = [regex]::Match($body, '(?m)^source = "([^"]+)"\r?$').Groups[1].Value
    $checksum = [regex]::Match($body, '(?m)^checksum = "([0-9a-f]{64})"\r?$').Groups[1].Value
    if ($source -eq 'registry+https://github.com/rust-lang/crates.io-index') {
        if (-not $name -or -not $version -or -not $checksum) {
            throw "Incomplete crates.io lock entry: $name $version"
        }
        $key = "$name $version"
        if ($lockChecksums.ContainsKey($key)) { throw "Duplicate Cargo.lock entry: $key" }
        $lockChecksums[$key] = $checksum
    }
}

$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($package in $packages) {
    $name = [string]$package.name
    $version = [string]$package.version
    $key = "$name $version"
    $archiveName = "$name-$version.crate"
    if ($name -notmatch '^[A-Za-z0-9_-]+$' -or
        $version -notmatch '^[0-9A-Za-z.+-]+$' -or
        -not $seen.Add($key) -or
        $package.archive -ne $archiveName -or
        $package.sha256 -notmatch '^[0-9a-f]{64}$' -or
        -not $lockChecksums.ContainsKey($key) -or
        $package.sha256 -ne $lockChecksums[$key]) {
        throw "Invalid or mismatched Rust source inventory entry: $key"
    }
    $archivePath = Join-Path $archiveRoot $archiveName
    if (-not (Test-Path -LiteralPath $archivePath)) { throw "Missing Rust source archive: $archiveName" }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
    if ($actualHash -ne $package.sha256) {
        throw "Cargo.lock SHA-256 mismatch for $archiveName"
    }
}
if ($seen.Count -ne $lockChecksums.Count) {
    throw "Resolver archive count differs from Cargo.lock: $($seen.Count) versus $($lockChecksums.Count)"
}
$buildSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($package in $buildPackages) {
    $key = "$($package.name) $($package.version)"
    if (-not $buildSeen.Add($key) -or -not $seen.Contains($key) -or
        $package.archive -ne "$($package.name)-$($package.version).crate" -or
        $package.sha256 -ne $lockChecksums[$key]) {
        throw "Windows build archive inventory differs from complete resolver set: $key"
    }
}
$includedFiles = @(Get-ChildItem -LiteralPath $archiveRoot -Filter '*.crate' -File)
if ($includedFiles.Count -ne $seen.Count) {
    throw "Unexpected .crate archive count: $($includedFiles.Count) versus $($seen.Count)"
}
Write-Host "Verified $($buildPackages.Count) Windows build and $($packages.Count) complete locked .crate archives"
if ($VerifyOnly) { return }

function Expand-VerifiedCrate([object]$package, [string]$vendorRoot) {
    $crateName = "$($package.name)-$($package.version)"
    $archivePath = Join-Path $archiveRoot "$crateName.crate"
    $crateRoot = Join-Path $vendorRoot $crateName
    New-Item -ItemType Directory -Path $crateRoot | Out-Null
    $safePrefix = [IO.Path]::GetFullPath($crateRoot).TrimEnd('\') + '\'
    $hashes = [ordered]@{}
    $entryNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $archiveStream = [IO.File]::OpenRead($archivePath)
    $gzipStream = [IO.Compression.GZipStream]::new(
        $archiveStream, [IO.Compression.CompressionMode]::Decompress, $false
    )
    $reader = [System.Formats.Tar.TarReader]::new($gzipStream, $false)
    try {
        while ($entry = $reader.GetNextEntry()) {
            $prefix = "$crateName/"
            if (-not $entry.Name.StartsWith($prefix, [StringComparison]::Ordinal)) {
                throw "Unexpected root in $crateName crate: $($entry.Name)"
            }
            $relative = $entry.Name.Substring($prefix.Length)
            $segments = @($relative.Split('/'))
            if (-not $relative -or $relative.Contains('\') -or
                @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0 -or
                $relative -eq '.cargo-checksum.json' -or
                -not $entryNames.Add($relative)) {
                throw "Unsafe or duplicate path in $crateName crate: $relative"
            }
            $target = [IO.Path]::GetFullPath((Join-Path $crateRoot ($relative.Replace('/', '\'))))
            if (-not $target.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Path escapes $crateName vendor directory: $relative"
            }
            if ($entry.EntryType -ne [System.Formats.Tar.TarEntryType]::RegularFile) {
                throw "Unsupported non-file entry in $crateName crate: $relative"
            }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            $hasher = [Security.Cryptography.IncrementalHash]::CreateHash(
                [Security.Cryptography.HashAlgorithmName]::SHA256
            )
            try {
                $buffer = [byte[]]::new(131072)
                if ($null -eq $entry.DataStream -and $entry.Length -ne 0) {
                    throw "Missing data stream for nonempty $crateName file: $relative"
                }
                if ($null -ne $entry.DataStream) {
                    while (($read = $entry.DataStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $output.Write($buffer, 0, $read)
                        $hasher.AppendData($buffer, 0, $read)
                    }
                }
                $hashes[$relative] = [Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant()
            } finally {
                $hasher.Dispose()
                $output.Dispose()
            }
        }
    } finally {
        $reader.Dispose()
        $gzipStream.Dispose()
        $archiveStream.Dispose()
    }
    if ($hashes.Count -eq 0 -or -not $hashes.Contains('Cargo.toml')) {
        throw "Crate has no Cargo.toml: $crateName"
    }
    $checksum = [ordered]@{ files = $hashes; package = $package.sha256 }
    $checksum | ConvertTo-Json -Depth 5 -Compress |
        Set-Content -LiteralPath (Join-Path $crateRoot '.cargo-checksum.json') -Encoding utf8NoBOM
}

$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargoPath = if ($cargoCommand) { $cargoCommand.Source } else {
    Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
if (-not (Test-Path -LiteralPath $cargoPath)) { throw 'cargo.exe was not found' }
$previousRustFlags = $env:RUSTFLAGS
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("DanmakuVoice-vendor-{0}" -f [guid]::NewGuid().ToString('N'))
$vendorRoot = Join-Path $scratch 'vendor'
try {
    New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null
    foreach ($package in $packages) { Expand-VerifiedCrate $package $vendorRoot }
    $vendorLocation = [IO.Path]::GetFullPath($vendorRoot).Replace('\', '/') | ConvertTo-Json -Compress
    @(
        '[source.crates-io]'
        'replace-with = "bundled-crates"'
        '[source.bundled-crates]'
        "directory = $vendorLocation"
    ) | Set-Content -LiteralPath (Join-Path $scratch 'config.toml') -Encoding utf8NoBOM
    $env:RUSTFLAGS = '-C target-feature=+crt-static'
    Push-Location $sourceRoot
    try {
        & $cargoPath --config (Join-Path $scratch 'config.toml') build --offline --locked --release `
            --target x86_64-pc-windows-msvc -p danmakuvoice
        if ($LASTEXITCODE -ne 0) { throw "Locked Cargo build failed: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} finally {
    $env:RUSTFLAGS = $previousRustFlags
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    if (-not $resolvedScratch.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove vendor staging outside the temporary directory: $resolvedScratch"
    }
    if (Test-Path -LiteralPath $resolvedScratch) {
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
}
Write-Host 'Built source ZIP project offline with Cargo.lock; binary is under target/x86_64-pc-windows-msvc/release/'
