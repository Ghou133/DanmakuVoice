param(
    [Parameter(Mandatory = $true)][string]$PortableZip,
    [Parameter(Mandatory = $true)][string]$ApplicationExe,
    [Parameter(Mandatory = $true)][string]$SourceZip,
    [Parameter(Mandatory = $true)][string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') { throw 'ExpectedCommit must be a full Git SHA-1' }
Add-Type -AssemblyName System.IO.Compression

function Read-ZipBytes([IO.Compression.ZipArchive]$archive, [string]$path) {
    $entry = $archive.GetEntry($path)
    if (-not $entry) { throw "Missing ZIP entry: $path" }
    $stream = $entry.Open()
    $buffer = [IO.MemoryStream]::new()
    try {
        $stream.CopyTo($buffer)
        return ,$buffer.ToArray()
    } finally {
        $buffer.Dispose()
        $stream.Dispose()
    }
}

function Get-Sha256([byte[]]$bytes) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}

function Get-LockChecksums([byte[]]$bytes) {
    $checksums = @{}
    $lockText = [Text.Encoding]::UTF8.GetString($bytes)
    foreach ($block in [regex]::Matches($lockText, '(?ms)^\[\[package\]\]\r?\n(.*?)(?=^\[\[package\]\]|\z)')) {
        $body = $block.Groups[1].Value
        $name = [regex]::Match($body, '(?m)^name = "([^"]+)"\r?$').Groups[1].Value
        $version = [regex]::Match($body, '(?m)^version = "([^"]+)"\r?$').Groups[1].Value
        $source = [regex]::Match($body, '(?m)^source = "([^"]+)"\r?$').Groups[1].Value
        $checksum = [regex]::Match($body, '(?m)^checksum = "([0-9a-f]{64})"\r?$').Groups[1].Value
        if ($source -eq 'registry+https://github.com/rust-lang/crates.io-index') {
            $key = "$name $version"
            if (-not $name -or -not $version -or -not $checksum -or $checksums.ContainsKey($key)) {
                throw "Invalid crates.io entry in portable Cargo.lock: $key"
            }
            $checksums[$key] = $checksum
        }
    }
    return $checksums
}

$portable = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $PortableZip).Path)
$source = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $SourceZip).Path)
try {
    $sourcePrefix = "DanmakuVoice-source-$($ExpectedCommit.Substring(0, 12))/"
    $portablePrefix = 'DanmakuVoice/'
    $auditExe = Read-ZipBytes $portable "${portablePrefix}danmakuvoice.exe"
    $applicationPath = (Resolve-Path -LiteralPath $ApplicationExe).Path
    $applicationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $applicationPath).Hash
    if ($applicationHash -ne (Get-Sha256 $auditExe)) {
        throw 'Direct application EXE differs from the validated audit ZIP'
    }
    $provenance = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $portable "${portablePrefix}BUILD-SOURCE.txt")
    )
    $cleanClaims = [regex]::Matches(
        $provenance, '(?m)^Checkout clean before build: ([^\r\n]*)\r?$'
    )
    if ($cleanClaims.Count -ne 1 -or $cleanClaims[0].Groups[1].Value -cne 'True') {
        throw 'Audit ZIP must contain exactly one clean-checkout provenance claim set to True'
    }
    $sourceCommit = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $source "${sourcePrefix}SOURCE-COMMIT.txt")
    )
    $sourceNotice = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $portable "${portablePrefix}SOURCE-AVAILABILITY.txt")
    )
    if (-not $provenance.Contains("Source Git commit: $ExpectedCommit") -or
        -not $sourceCommit.Contains("DanmakuVoice source commit: $ExpectedCommit") -or
        -not $sourceNotice.Contains("Git commit: $ExpectedCommit")) {
        throw 'Portable and source ZIPs do not both identify the expected clean Git commit'
    }
    $portableLock = Read-ZipBytes $portable "${portablePrefix}third-party/Rust/Cargo.lock"
    $sourceLock = Read-ZipBytes $source "${sourcePrefix}Cargo.lock"
    $lockHash = Get-Sha256 $portableLock
    if ($lockHash -ne (Get-Sha256 $sourceLock) -or
        -not $provenance.Contains("Cargo.lock SHA-256: $lockHash")) {
        throw 'Cargo.lock differs between portable/source ZIPs or from build provenance'
    }
    $lockChecksums = Get-LockChecksums $portableLock
    $spdx = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $portable "${portablePrefix}third-party/Rust/DEPENDENCIES.spdx.json")
    ).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $inventory = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $source "${sourcePrefix}third-party/Rust/CRATE-ARCHIVES.json")
    ).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $resolverInventory = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $source "${sourcePrefix}third-party/Rust/CRATE-RESOLVER-ARCHIVES.json")
    ).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($resolverInventory.schemaVersion -ne 1) {
        throw 'Unsupported complete Cargo.lock source archive inventory'
    }
    $declared = [string[]]@($spdx.packages | ForEach-Object { "$($_.name) $($_.versionInfo)" })
    $archived = [string[]]@($inventory.archives | ForEach-Object { "$($_.name) $($_.version)" })
    [Array]::Sort($declared, [StringComparer]::Ordinal)
    [Array]::Sort($archived, [StringComparer]::Ordinal)
    if ($declared.Count -eq 0 -or $declared.Count -ne $archived.Count -or
        (Compare-Object -ReferenceObject $declared -DifferenceObject $archived)) {
        throw 'Rust packages in portable SPDX and source archives do not match'
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($package in $resolverInventory.archives) {
        $key = "$($package.name) $($package.version)"
        $archiveName = "$($package.name)-$($package.version).crate"
        if (-not $seen.Add($key) -or $package.archive -ne $archiveName -or
            $package.sha256 -notmatch '^[0-9a-f]{64}$' -or
            -not $lockChecksums.ContainsKey($key) -or
            $package.sha256 -ne $lockChecksums[$key]) {
            throw "Rust source inventory differs from Cargo.lock: $key"
        }
        $bytes = Read-ZipBytes $source "${sourcePrefix}third-party/Rust/crate-archives/$archiveName"
        if ((Get-Sha256 $bytes) -ne $package.sha256) {
            throw "Rust source archive SHA-256 differs from Cargo.lock: $archiveName"
        }
    }
    if ($seen.Count -ne $lockChecksums.Count) {
        throw "Complete Rust archive inventory differs from Cargo.lock: $($seen.Count) versus $($lockChecksums.Count)"
    }
    $includedCrates = @($source.Entries | Where-Object {
        $_.FullName.StartsWith("${sourcePrefix}third-party/Rust/crate-archives/", [StringComparison]::Ordinal) -and
        $_.FullName.EndsWith('.crate', [StringComparison]::Ordinal)
    })
    if ($includedCrates.Count -ne $seen.Count) {
        throw 'Unexpected .crate count in source ZIP'
    }
    $buildSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($package in $inventory.archives) {
        $key = "$($package.name) $($package.version)"
        if (-not $buildSeen.Add($key) -or -not $seen.Contains($key) -or
            $package.archive -ne "$($package.name)-$($package.version).crate" -or
            $package.sha256 -ne $lockChecksums[$key]) {
            throw "Windows build archive inventory differs from complete Cargo.lock sources: $key"
        }
    }
    $selectedSupplements = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $portable "${portablePrefix}third-party/Rust/LICENSE-SUPPLEMENTS.json")
    ).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $sourceSupplements = [Text.Encoding]::UTF8.GetString(
        (Read-ZipBytes $source "${sourcePrefix}third-party/license-supplements/manifest.json")
    ).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($selectedSupplements.schemaVersion -ne 1 -or $sourceSupplements.schemaVersion -ne 1) {
        throw 'Unsupported Rust license supplement manifest'
    }
    $sourceEntries = @{}
    foreach ($entry in $sourceSupplements.entries) {
        $key = "$($entry.package) $($entry.version)"
        if ($sourceEntries.ContainsKey($key)) { throw "Duplicate source license supplement: $key" }
        $sourceEntries[$key] = $entry
    }
    $selectedEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $selectedSupplements.entries) {
        $key = "$($entry.package) $($entry.version)"
        if (-not $selectedEntries.Add($key) -or -not $sourceEntries.ContainsKey($key) -or
            ($entry | ConvertTo-Json -Depth 10 -Compress) -ne
            ($sourceEntries[$key] | ConvertTo-Json -Depth 10 -Compress)) {
            throw "Rust license supplement metadata differs between ZIPs: $key"
        }
        foreach ($file in $entry.files) {
            if ($file.path -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
                $file.sha256 -notmatch '^[0-9a-f]{64}$') {
                throw "Invalid Rust license supplement record: $key"
            }
            $portableHash = Get-Sha256 (Read-ZipBytes $portable "${portablePrefix}third-party/license-supplements/$($file.path)")
            $sourceHash = Get-Sha256 (Read-ZipBytes $source "${sourcePrefix}third-party/license-supplements/$($file.path)")
            if ($portableHash -ne $file.sha256 -or $portableHash -ne $sourceHash) {
                throw "Rust license supplement differs between ZIPs: $($file.path)"
            }
        }
    }
    $ffmpegHashes = @{
        'ffmpeg-9.0.2.tar.xz' = '8C3850283EB25FA026482078A04051E0BE17347B09EF81A0849BEC15A96E002E'
        'COPYING.LGPLv2.1' = '246041B6ECF9BC32D718A62C57877C78B5EB397B6467E74ED7AE2626AB189C30'
        'LICENSE.md' = '2E1D16C72FD74E12063776371DA757322F8B77589386532F4FD8634BDE7DE1AF'
    }
    foreach ($file in $ffmpegHashes.Keys) {
        $portableHash = Get-Sha256 (Read-ZipBytes $portable "${portablePrefix}third-party/FFmpeg/$file")
        $sourceHash = Get-Sha256 (Read-ZipBytes $source "${sourcePrefix}third-party/FFmpeg/$file")
        if ($portableHash -ne $ffmpegHashes[$file] -or $portableHash -ne $sourceHash) {
            throw "FFmpeg source or license differs between ZIPs: $file"
        }
    }
    $ffmpegSource = $ffmpegHashes['ffmpeg-9.0.2.tar.xz']
    $ffmpegBinary = Get-Sha256 (Read-ZipBytes $source "${sourcePrefix}crates/desktop/embedded/ffmpeg.exe")
    if ($ffmpegBinary -ne '8FB7ECC11F4F7A441AE7075A81C984289250B166E78DEDF51900BBEB1A96EF4D' -or
        -not $provenance.Contains("FFmpeg binary SHA-256: $ffmpegBinary")) {
        throw 'Embedded FFmpeg differs from the pinned release build'
    }
    $portableBuildScript = Get-Sha256 (Read-ZipBytes $portable "${portablePrefix}scripts/build-minimal-ffmpeg-wsl.sh")
    $sourceBuildScript = Get-Sha256 (Read-ZipBytes $source "${sourcePrefix}scripts/build-minimal-ffmpeg-wsl.sh")
    if ($portableBuildScript -ne $sourceBuildScript) {
        throw 'FFmpeg build script differs between portable and source ZIPs'
    }
    [PSCustomObject]@{
        Commit = $ExpectedCommit
        ApplicationSHA256 = $applicationHash
        CargoLockSHA256 = $lockHash
        RustCrates = $declared.Count
        ResolverCrates = $seen.Count
        FfmpegSourceSHA256 = $ffmpegSource
        Matched = $true
    }
} finally {
    $source.Dispose()
    $portable.Dispose()
}
