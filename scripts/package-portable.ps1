param(
    [Parameter(Mandatory = $true)][string]$FfmpegBinary,
    [Parameter(Mandatory = $true)][string]$FfmpegSourceArchive,
    [Parameter(Mandatory = $true)][string]$FfmpegCopying,
    [Parameter(Mandatory = $true)][string]$FfmpegLicenseDescription,
    [string]$OutputZip = 'dist\DanmakuVoice-audit.zip',
    [string]$OutputExe = 'dist\DanmakuVoice.exe',
    [switch]$DevelopmentSnapshot,
    [switch]$RequireCleanCheckout
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = Join-Path $repoRoot 'dist'
$buildCommit = (& git -C $repoRoot rev-parse --verify HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $buildCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'A Git commit is required for portable build provenance'
}
$checkoutChanges = @(& git -C $repoRoot status --porcelain --untracked-files=normal)
$checkoutClean = $checkoutChanges.Count -eq 0
if ($DevelopmentSnapshot -and $RequireCleanCheckout) {
    throw 'DevelopmentSnapshot and RequireCleanCheckout are mutually exclusive'
}
if ($RequireCleanCheckout -and -not $checkoutClean) {
    throw 'The checkout must be clean before building a release-matched portable ZIP'
}
$snapshotJson = $null
$snapshotId = $null
if ($DevelopmentSnapshot) {
    $snapshotJson = (& python (Join-Path $PSScriptRoot 'source_inventory.py') inventory --root $repoRoot) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Could not identify development working-tree sources' }
    $snapshot = $snapshotJson | ConvertFrom-Json
    if ($snapshot.baseCommit -ne $buildCommit) { throw 'Working-tree base commit changed' }
    $snapshotId = $snapshot.snapshotSha256
}
$expectedHashes = @{
    Binary = '8FB7ECC11F4F7A441AE7075A81C984289250B166E78DEDF51900BBEB1A96EF4D'
    Source = '8C3850283EB25FA026482078A04051E0BE17347B09EF81A0849BEC15A96E002E'
    Copying = '246041B6ECF9BC32D718A62C57877C78B5EB397B6467E74ED7AE2626AB189C30'
    LicenseDescription = '2E1D16C72FD74E12063776371DA757322F8B77589386532F4FD8634BDE7DE1AF'
}

function Resolve-File([string]$path) {
    return (Resolve-Path -LiteralPath $path -ErrorAction Stop).Path
}

function Assert-Hash([string]$path, [string]$expected) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
    if ($actual -ne $expected) {
        throw "SHA-256 mismatch for $path`: expected $expected; got $actual"
    }
}

function Assert-FfmpegLicenseBuild([string]$exe) {
    $license = (& $exe -hide_banner -L 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0 -or
        $license -notmatch 'GNU Lesser General Public\s+License' -or
        $license -notmatch 'version 2\.1 of the License') {
        throw 'FFmpeg binary does not report LGPL 2.1 or later'
    }
    $build = (& $exe -hide_banner -buildconf 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0 -or
        $build -notmatch '(?m)^\s+--disable-everything\s*$' -or
        $build -notmatch '(?m)^\s+--disable-autodetect\s*$' -or
        $build -match '(?m)^\s+--enable-(?:gpl|nonfree)\s*$') {
        throw 'FFmpeg configure flags are outside the reviewed LGPL build profile'
    }
    Write-Host 'FFmpeg executable reports LGPL 2.1+; GPL/nonfree configure flags absent'
}

function Find-Dumpbin {
    $found = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw 'Visual Studio C++ dumpbin.exe is required to inspect PE dependencies'
    }
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $vsRoot) {
        throw 'Visual Studio C++ toolchain was not found'
    }
    $tool = Get-ChildItem -LiteralPath (Join-Path $vsRoot 'VC\Tools\MSVC') -Directory |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    $dumpbin = Join-Path $tool.FullName 'bin\Hostx64\x64\dumpbin.exe'
    if (-not (Test-Path -LiteralPath $dumpbin)) {
        throw "dumpbin.exe was not found at $dumpbin"
    }
    return $dumpbin
}

function Assert-SystemImports([string]$exe, [string]$dumpbin) {
    $headers = & $dumpbin /HEADERS $exe
    if ($LASTEXITCODE -ne 0 -or -not ($headers -match '^\s*8664 machine \(x64\)\s*$')) {
        throw "Portable executable is not Windows x64: $exe"
    }
    $output = & $dumpbin /DEPENDENTS $exe
    if ($LASTEXITCODE -ne 0 -or -not ($output -match 'Image has the following dependencies:')) {
        throw "Could not inspect PE dependencies of $exe"
    }
    $names = @($output | ForEach-Object {
        if ($_ -match '^\s+([A-Za-z0-9_.-]+\.dll)\s*$') { $Matches[1].ToLowerInvariant() }
    })
    if ($names.Count -eq 0) { throw "No PE imports were found for $exe" }
    $windowsDlls = @(
        'kernel32.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'shell32.dll',
        'advapi32.dll', 'ole32.dll', 'combase.dll', 'mmdevapi.dll',
        'oleaut32.dll', 'api-ms-win-core-winrt-error-l1-1-0.dll',
        'api-ms-win-core-winrt-l1-1-0.dll',
        'bcryptprimitives.dll', 'gdi32.dll', 'user32.dll', 'ws2_32.dll',
        'crypt32.dll', 'bcrypt.dll', 'ntdll.dll', 'imm32.dll',
        'dwmapi.dll', 'uxtheme.dll', 'comctl32.dll', 'shlwapi.dll',
        # WebView2's native loader uses these Windows 10/11 UCRT API sets,
        # even when the Rust binary is built with +crt-static. Keep exact
        # names: VCRUNTIME/MSVCP and arbitrary api-ms-* DLLs are not allowed.
        # https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment
        'api-ms-win-crt-math-l1-1-0.dll', 'api-ms-win-crt-string-l1-1-0.dll',
        'api-ms-win-crt-convert-l1-1-0.dll', 'api-ms-win-crt-heap-l1-1-0.dll',
        'api-ms-win-crt-utility-l1-1-0.dll', 'api-ms-win-crt-time-l1-1-0.dll',
        'api-ms-win-crt-runtime-l1-1-0.dll', 'api-ms-win-crt-stdio-l1-1-0.dll',
        'api-ms-win-crt-locale-l1-1-0.dll'
    )
    $unexpected = @($names | Where-Object { $_ -notin $windowsDlls })
    if ($unexpected.Count -gt 0) {
        throw "Non-system PE dependencies: $($unexpected -join ', ')"
    }
    Write-Host "Windows system DLL imports only: $($names -join ', ')"
}

function Write-RustSpdx([string]$destination, [string]$cargoPath) {
    Push-Location $repoRoot
    try {
        $json = & $cargoPath metadata --locked --format-version=1 --filter-platform x86_64-pc-windows-msvc
        if ($LASTEXITCODE -ne 0) { throw "Cargo metadata failed: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    $metadata = $json | ConvertFrom-Json
    $desktop = @($metadata.packages | Where-Object { $_.name -eq 'danmakuvoice' -and -not $_.source })
    if ($desktop.Count -ne 1) { throw 'Could not identify the desktop package in Cargo metadata' }

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
            $runtimeOrBuild = @($dependency.dep_kinds | Where-Object { $_.kind -ne 'dev' })
            if ($runtimeOrBuild.Count -gt 0) { $pending.Enqueue($dependency.pkg) }
        }
    }

    $thirdParty = @($seen | ForEach-Object { $packages[$_] } |
        Where-Object { $_.source } | Sort-Object name, version)
    if ($thirdParty.Count -eq 0) { throw 'No Rust dependencies were found for the desktop package' }
    $spdxPackages = @()
    $described = @()
    for ($index = 0; $index -lt $thirdParty.Count; $index++) {
        $package = $thirdParty[$index]
        if (-not $package.license) {
            throw "Missing declared license for $($package.name) $($package.version); review required"
        }
        # Cargo still accepts the deprecated A/B spelling as a choice of licenses.
        # SPDX JSON requires an OR expression; retain the author's raw spelling below.
        $declared = $package.license -replace '\s*/\s*', ' OR '
        $spdxId = "SPDXRef-Package-$($index + 1)"
        $described += $spdxId
        $spdxPackages += [ordered]@{
            SPDXID = $spdxId
            name = $package.name
            versionInfo = $package.version
            downloadLocation = 'NOASSERTION'
            filesAnalyzed = $false
            licenseDeclared = $declared
            licenseConcluded = 'NOASSERTION'
            copyrightText = 'NOASSERTION'
            licenseComments = "Cargo metadata raw license: $($package.license)"
            externalRefs = @([ordered]@{
                referenceCategory = 'PACKAGE-MANAGER'
                referenceType = 'purl'
                referenceLocator = "pkg:cargo/$($package.name)@$($package.version)"
            })
        }
    }
    $document = [ordered]@{
        spdxVersion = 'SPDX-2.3'
        dataLicense = 'CC0-1.0'
        SPDXID = 'SPDXRef-DOCUMENT'
        name = 'DanmakuVoice Windows x64 Rust dependency declarations'
        documentNamespace = "urn:uuid:$([guid]::NewGuid())"
        creationInfo = [ordered]@{
            creators = @('Tool: scripts/package-portable.ps1')
            created = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            comment = 'Cargo metadata declared licenses for Windows x64 normal/build dependencies; this is not a review of bundled source license texts.'
        }
        documentDescribes = $described
        packages = $spdxPackages
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    $document | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $destination -Encoding UTF8
    Write-Host "Rust SPDX declarations: $($thirdParty.Count) packages"
    return $thirdParty
}

function Read-LicenseSupplements {
    $path = Join-Path $repoRoot 'third-party\license-supplements\manifest.json'
    $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or @($manifest.entries).Count -eq 0) {
        throw 'Invalid Rust license supplement manifest'
    }
    $byPackage = @{}
    foreach ($entry in $manifest.entries) {
        if (-not $entry.package -or -not $entry.version -or
            $entry.crateVcsSha1 -notmatch '^[0-9a-f]{40}$' -or
            $entry.sourceRelation -notin @('exact-crate-vcs', 'canonical-license-text', 'later-upstream-license-crate-declares-MIT') -or
            @($entry.files).Count -eq 0) {
            throw "Invalid Rust license supplement entry: $($entry.package) $($entry.version)"
        }
        $key = "$($entry.package) $($entry.version)"
        if ($byPackage.ContainsKey($key)) { throw "Duplicate Rust license supplement: $key" }
        $byPackage[$key] = $entry
    }
    return $byPackage
}

function Copy-RustNotices([object[]]$thirdParty, [string]$stage) {
    $lines = [Collections.Generic.List[string]]::new()
    $missing = [Collections.Generic.List[string]]::new()
    $supplements = Read-LicenseSupplements
    $usedSupplements = [Collections.Generic.HashSet[string]]::new()
    $currentPackages = [Collections.Generic.HashSet[string]]::new()
    $lines.Add('# Rust third-party license and notice inventory')
    $lines.Add('')
    $lines.Add('Generated from locked Windows x64 normal/build Cargo dependencies. Original crate license, notice, author, patent and copyright files are copied under each package directory. Missing root license texts use hash-checked, per-version supplements recorded in LICENSE-SUPPLEMENTS.json. The Cargo SPDX summary records declared licenses only; this inventory does not prove that every upstream obligation has been reviewed.')
    $lines.Add('')
    $lines.Add('| Package | Cargo license | Authors | Repository | Included files | Review |')
    $lines.Add('| --- | --- | --- | --- | --- | --- |')
    foreach ($package in $thirdParty) {
        [void]$currentPackages.Add("$($package.name) $($package.version)")
        $crateRoot = Split-Path -Parent $package.manifest_path
        $crateStage = Join-Path $stage "third-party\Rust\licenses\$($package.name)-$($package.version)"
        $files = @(Get-ChildItem -LiteralPath $crateRoot -Recurse -File | Where-Object {
            $_.Name -match '(?i)^(license|licence|copying|notices?|attributions?|authors|patents|copyright|credits)(?:[._-].*)?$' -or
            $_.Name -eq 'UNLICENSE' -or
            $_.Name -eq 'DRUID_LICENSE'
        })
        $included = [Collections.Generic.List[string]]::new()
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($crateRoot.Length + 1)
            $destination = Join-Path $crateStage $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination
            $included.Add(($relative -replace '\\', '/'))
        }
        $rootLicense = @($files | Where-Object {
            (Split-Path -Parent $_.FullName) -eq $crateRoot -and
            $_.Name -match '(?i)^(license|licence|copying)(?:[._-].*)?$'
        })
        $review = 'File(s) copied; manual obligation review pending'
        if ($rootLicense.Count -eq 0) {
            $key = "$($package.name) $($package.version)"
            if ($supplements.ContainsKey($key)) {
                $entry = $supplements[$key]
                $vcsPath = Join-Path $crateRoot '.cargo_vcs_info.json'
                if (-not (Test-Path -LiteralPath $vcsPath)) {
                    throw "Missing crate VCS provenance for $key"
                }
                $vcs = Get-Content -LiteralPath $vcsPath -Raw | ConvertFrom-Json
                if ($vcs.git.sha1 -ne $entry.crateVcsSha1) {
                    throw "Crate VCS revision mismatch for $key"
                }
                $licenseChoices = @($package.license -split '\s+OR\s+|\s*/\s*')
                if ($entry.selectedLicense -notin $licenseChoices) {
                    throw "Selected license is absent from Cargo metadata for $key"
                }
                foreach ($supplement in $entry.files) {
                    $relative = [string]$supplement.path
                    if ($relative -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
                        $supplement.sha256 -notmatch '^[0-9A-Fa-f]{64}$' -or
                        ($supplement.sourceUrl -notmatch '^https://(raw\.githubusercontent\.com|creativecommons\.org)/' -and
                         $supplement.sourceUrl -ne 'https://www.mozilla.org/media/MPL/2.0/index.txt')) {
                        throw "Invalid supplement file record for $key"
                    }
                    if ($entry.sourceRelation -eq 'exact-crate-vcs' -and
                        -not $supplement.sourceUrl.Contains($entry.crateVcsSha1)) {
                        throw "Supplement source URL is not from the exact crate revision for $key"
                    }
                    $source = Join-Path $repoRoot "third-party\license-supplements\$($relative.Replace('/', '\'))"
                    Assert-Hash $source $supplement.sha256
                    $destination = Join-Path $stage "third-party\license-supplements\$($relative.Replace('/', '\'))"
                    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
                    if (-not (Test-Path -LiteralPath $destination)) {
                        Copy-Item -LiteralPath $source -Destination $destination
                    }
                    $included.Add("third-party/license-supplements/$relative")
                }
                [void]$usedSupplements.Add($key)
                $review = "Supplement: $($entry.selectedLicense), $($entry.sourceRelation); manual obligation review pending"
            } else {
                $missing.Add($key)
                $review = 'BLOCKER: no root license text or verified supplement'
            }
            $readmes = @(Get-ChildItem -LiteralPath $crateRoot -File | Where-Object {
                $_.Name -match '(?i)^readme(?:[._-].*)?$'
            })
            foreach ($readme in $readmes) {
                New-Item -ItemType Directory -Path $crateStage -Force | Out-Null
                Copy-Item -LiteralPath $readme.FullName -Destination (Join-Path $crateStage $readme.Name)
                $included.Add($readme.Name)
            }
        }
        $authors = @($package.authors) -join ', '
        if (-not $authors) { $authors = 'NOASSERTION' }
        $repository = if ($package.repository) { $package.repository } else { 'NOASSERTION' }
        $columns = @(
            "$($package.name) $($package.version)", $package.license, $authors,
            $repository, ($included -join ', '), $review
        ) | ForEach-Object { [string]$_ -replace '\|', '\|' -replace '[\r\n]+', ' ' }
        $lines.Add('| ' + ($columns -join ' | ') + ' |')
    }
    $stale = @($supplements.Keys | Where-Object {
        $currentPackages.Contains($_) -and -not $usedSupplements.Contains($_)
    })
    if ($stale.Count -gt 0) {
        throw "Unused Rust license supplement entries need review: $($stale -join ', ')"
    }
    # Retain historical supplements in source control, but ship only entries
    # and files used by this locked build's Windows dependency graph.
    $selectedManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'third-party\license-supplements\manifest.json') -Raw | ConvertFrom-Json
    $selectedManifest.entries = @($selectedManifest.entries | Where-Object {
        $usedSupplements.Contains("$($_.package) $($_.version)")
    })
    $selectedManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage 'third-party\Rust\LICENSE-SUPPLEMENTS.json') -Encoding UTF8
    $lines.Add('')
    $lines.Add("Packages without a root license text or verified supplement: $($missing.Count). Public release is blocked while this count is nonzero. Supplemental texts and source revisions are recorded in LICENSE-SUPPLEMENTS.json.")
    $lines.Add('')
    $lines.Add('This automated inventory cannot inspect every source header, selected license option, transitive notice obligation, or shipped asset. Review those against the final binary before publishing.')
    $report = Join-Path $stage 'third-party\Rust\NOTICE-REVIEW.md'
    New-Item -ItemType Directory -Path (Split-Path -Parent $report) -Force | Out-Null
    $lines | Set-Content -LiteralPath $report -Encoding UTF8
    Write-Host "Rust notice files copied; $($missing.Count) packages need license review"
    return $missing.ToArray()
}

$inputs = @{
    Binary = Resolve-File $FfmpegBinary
    Source = Resolve-File $FfmpegSourceArchive
    Copying = Resolve-File $FfmpegCopying
    LicenseDescription = Resolve-File $FfmpegLicenseDescription
}
foreach ($name in $inputs.Keys) { Assert-Hash $inputs[$name] $expectedHashes[$name] }
Assert-FfmpegLicenseBuild $inputs.Binary
$embeddedFfmpeg = Join-Path $repoRoot 'crates\desktop\embedded\ffmpeg.exe'
Assert-Hash $embeddedFfmpeg $expectedHashes.Binary

if (-not [IO.Path]::IsPathRooted($OutputZip)) {
    $OutputZip = Join-Path $repoRoot $OutputZip
}
$OutputZip = [IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $OutputZip) {
    throw "Output already exists; refusing to overwrite: $OutputZip"
}
if (-not [IO.Path]::IsPathRooted($OutputExe)) {
    $OutputExe = Join-Path $repoRoot $OutputExe
}
$OutputExe = [IO.Path]::GetFullPath($OutputExe)
if ($OutputExe -eq $OutputZip -or (Test-Path -LiteralPath $OutputExe)) {
    throw "Application output already exists or conflicts with audit ZIP: $OutputExe"
}
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputZip) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputExe) -Force | Out-Null

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if ($cargo) {
    $cargoPath = $cargo.Source
} else {
    $cargoPath = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (-not (Test-Path -LiteralPath $cargoPath)) { throw 'cargo.exe was not found' }
}

$previousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = '-C target-feature=+crt-static'
    Push-Location $repoRoot
    try {
        & $cargoPath build --locked --release -p danmakuvoice
        if ($LASTEXITCODE -ne 0) { throw "Cargo release build failed: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} finally {
    $env:RUSTFLAGS = $previousRustFlags
}

$buildMetadata = & $cargoPath metadata --locked --no-deps --format-version=1 --manifest-path (Join-Path $repoRoot 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve Cargo target directory' }
$targetDirectory = ($buildMetadata | ConvertFrom-Json).target_directory
$exe = Join-Path $targetDirectory 'release\danmakuvoice.exe'
Assert-SystemImports $exe (Find-Dumpbin)
if ($RequireCleanCheckout) {
    $finishedCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
    $finishedChanges = @(& git -C $repoRoot status --porcelain --untracked-files=normal)
    if ($finishedCommit -ne $buildCommit -or $finishedChanges.Count -gt 0) {
        throw 'The checkout changed during portable build; source correspondence is not proven'
    }
}
if ($DevelopmentSnapshot) {
    $finishedJson = (& python (Join-Path $PSScriptRoot 'source_inventory.py') inventory --root $repoRoot) -join "`n"
    if ($LASTEXITCODE -ne 0 -or ($finishedJson | ConvertFrom-Json).snapshotSha256 -ne $snapshotId) {
        throw 'Working-tree sources changed during development build; source correspondence is not proven'
    }
}

$scratch = Join-Path $distRoot ("portable-stage-{0}" -f [guid]::NewGuid().ToString('N'))
$stage = Join-Path $scratch 'DanmakuVoice'
$extract = Join-Path $scratch 'extracted'
$completed = $false

function Copy-IntoStage([string]$source, [string]$relative) {
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}

function Assert-LocalMarkdownLinks([string]$relative) {
    $document = Join-Path $stage $relative
    $directory = Split-Path -Parent $document
    $markdown = Get-Content -LiteralPath $document -Raw
    foreach ($match in [regex]::Matches($markdown, '\]\(([^)]+)\)')) {
        $target = $match.Groups[1].Value.Split('#')[0]
        if (-not $target -or $target -match '^[a-z][a-z0-9+.-]*:' -or $target.StartsWith('//')) { continue }
        $linked = [IO.Path]::GetFullPath((Join-Path $directory $target))
        $stagePrefix = [IO.Path]::GetFullPath($stage).TrimEnd('\') + '\'
        if (-not $linked.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $linked)) {
            throw "Broken local link in ${relative}: $target"
        }
    }
}

try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-IntoStage $exe 'danmakuvoice.exe'
    Copy-IntoStage (Join-Path $repoRoot 'LICENSE') 'LICENSE'
    Copy-IntoStage (Join-Path $repoRoot 'NOTICE.md') 'NOTICE.md'
    Copy-IntoStage (Join-Path $repoRoot 'README.md') 'README.md'
    foreach ($image in @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs/images') -File -Filter '*.png')) {
        Copy-IntoStage $image.FullName ("docs/images/" + $image.Name)
    }
    Copy-IntoStage (Join-Path $repoRoot 'crates\desktop\ui\logo.png') 'crates\desktop\ui\logo.png'
    Copy-IntoStage (Join-Path $repoRoot 'PROGRESS.md') 'PROGRESS.md'
    Copy-IntoStage (Join-Path $repoRoot 'MIGRATION.md') 'MIGRATION.md'
    Copy-IntoStage (Join-Path $repoRoot 'ARCHITECTURE.md') 'ARCHITECTURE.md'
    Copy-IntoStage (Join-Path $repoRoot 'rust-toolchain.toml') 'rust-toolchain.toml'
    Copy-IntoStage (Join-Path $repoRoot 'docs\FFMPEG.md') 'docs\FFMPEG.md'
    Copy-IntoStage (Join-Path $repoRoot 'docs\STORE-PUBLISHING.md') 'docs\STORE-PUBLISHING.md'
    Copy-IntoStage (Join-Path $repoRoot 'docs\PRIVACY.md') 'docs\PRIVACY.md'
    Copy-IntoStage (Join-Path $repoRoot 'docs\ERROR-CODES.md') 'docs\ERROR-CODES.md'
    Copy-IntoStage (Join-Path $repoRoot 'docs\RELEASE-LICENSE-AUDIT.md') 'docs\RELEASE-LICENSE-AUDIT.md'
    Copy-IntoStage (Join-Path $repoRoot 'docs\UI-IPC.md') 'docs\UI-IPC.md'
    Copy-IntoStage (Join-Path $repoRoot 'docs\UI-DESIGN.md') 'docs\UI-DESIGN.md'
    Copy-IntoStage (Join-Path $repoRoot 'crates\desktop\icons\ARTWORK.md') 'crates\desktop\icons\ARTWORK.md'
    Copy-IntoStage (Join-Path $repoRoot 'crates\desktop\icons\README.md') 'crates\desktop\icons\README.md'
    Copy-IntoStage (Join-Path $repoRoot 'scripts\build-minimal-ffmpeg-wsl.sh') 'scripts\build-minimal-ffmpeg-wsl.sh'
    Copy-IntoStage (Join-Path $repoRoot 'scripts\verify-minimal-ffmpeg.py') 'scripts\verify-minimal-ffmpeg.py'
    Copy-IntoStage (Join-Path $repoRoot 'scripts\package-portable.ps1') 'scripts\package-portable.ps1'
    Copy-IntoStage (Join-Path $repoRoot 'scripts\package-source.ps1') 'scripts\package-source.ps1'
    Copy-IntoStage (Join-Path $repoRoot 'scripts\build-from-source.ps1') 'scripts\build-from-source.ps1'
    Copy-IntoStage (Join-Path $repoRoot 'scripts\verify-bundle-pair.ps1') 'scripts\verify-bundle-pair.ps1'
    Copy-IntoStage (Join-Path $repoRoot 'scripts\verify-rust-license-copies.py') 'scripts\verify-rust-license-copies.py'
    Copy-IntoStage (Join-Path $repoRoot 'Cargo.lock') 'third-party\Rust\Cargo.lock'
    @(
        "Source Git commit: $buildCommit"
        "Checkout clean before build: $checkoutClean"
        "Development snapshot: $DevelopmentSnapshot"
        "Working-tree snapshot SHA-256: $snapshotId"
        "Cargo.lock SHA-256: $((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repoRoot 'Cargo.lock')).Hash)"
        "FFmpeg binary SHA-256: $($expectedHashes.Binary)"
        "FFmpeg source SHA-256: $($expectedHashes.Source)"
    ) | Set-Content -LiteralPath (Join-Path $stage 'BUILD-SOURCE.txt') -Encoding UTF8
    if ($DevelopmentSnapshot) {
        Set-Content -LiteralPath (Join-Path $stage 'WORKTREE-SOURCE.json') -Value $snapshotJson -Encoding utf8NoBOM
    }
    @(
        $(if ($DevelopmentSnapshot) { 'Matching source for this Windows x64 working-tree development snapshot' } else { 'Matching source for this Windows x64 single-file application' })
        "Git commit: $buildCommit"
        $(if ($DevelopmentSnapshot) { "The commit is only the base. Matching working-tree SHA-256: $snapshotId" } else { 'A separate DanmakuVoice source ZIP for this exact commit must be offered alongside the direct EXE.' })
        'It contains application source, build scripts, Cargo.lock, and all verified locked Rust .crate archives.'
        'The direct EXE, audit ZIP and matching source ZIP must pass scripts/verify-bundle-pair.ps1 before distribution.'
        'The FFmpeg 9.0.2 source archive and LGPL materials are included under third-party/FFmpeg/ in this audit ZIP.'
        'If the matching source ZIP is unavailable at the distribution location, request it from the distributor.'
        $(if ($DevelopmentSnapshot) { 'DEVELOPMENT SNAPSHOT: the commit above is only the base; WORKTREE-SOURCE.json identifies uncommitted sources. Not a formal release.' })
    ) | Set-Content -LiteralPath (Join-Path $stage 'SOURCE-AVAILABILITY.txt') -Encoding UTF8
    $rustPackages = @(Write-RustSpdx (Join-Path $stage 'third-party\Rust\DEPENDENCIES.spdx.json') $cargoPath)
    $licenseBlockers = @(Copy-RustNotices $rustPackages $stage)
    if ($licenseBlockers.Count -gt 0 -and -not $DevelopmentSnapshot) {
        throw "Rust license review is incomplete for $($licenseBlockers.Count) packages. Use -DevelopmentSnapshot only for a non-release audit ZIP."
    }
    Copy-IntoStage $inputs.Copying 'third-party\FFmpeg\COPYING.LGPLv2.1'
    Copy-IntoStage $inputs.LicenseDescription 'third-party\FFmpeg\LICENSE.md'
    Copy-IntoStage $inputs.Source 'third-party\FFmpeg\ffmpeg-9.0.2.tar.xz'
    Assert-LocalMarkdownLinks 'README.md'
    Assert-LocalMarkdownLinks 'NOTICE.md'
    Assert-LocalMarkdownLinks 'docs\RELEASE-LICENSE-AUDIT.md'

    Compress-Archive -LiteralPath $stage -DestinationPath $OutputZip -CompressionLevel Optimal
    Expand-Archive -LiteralPath $OutputZip -DestinationPath $extract

    $files = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
    $unpackedFiles = @(Get-ChildItem -LiteralPath $extract -Recurse -File)
    if ($files.Count -lt 20 -or $unpackedFiles.Count -ne $files.Count) {
        throw "Unexpected portable file count: stage=$($files.Count), extract=$($unpackedFiles.Count)"
    }
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($stage.Length + 1)
        $unpacked = Join-Path (Join-Path $extract 'DanmakuVoice') $relative
        if (-not (Test-Path -LiteralPath $unpacked)) { throw "Missing extracted file: $relative" }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne
            (Get-FileHash -Algorithm SHA256 -LiteralPath $unpacked).Hash) {
            throw "Extracted file differs: $relative"
        }
    }
    $zipBytes = (Get-Item -LiteralPath $OutputZip).Length
    $extractedBytes = ($unpackedFiles | Measure-Object Length -Sum).Sum
    if ($zipBytes -ge 50000000 -or $extractedBytes -ge 50000000) {
        throw "Audit package reached the 50 MB cap: zip=$zipBytes extracted=$extractedBytes"
    }
    if ($DevelopmentSnapshot) {
        & python (Join-Path $PSScriptRoot 'source_inventory.py') verify --root $repoRoot --manifest (Join-Path $stage 'WORKTREE-SOURCE.json')
        if ($LASTEXITCODE -ne 0) { throw 'Working-tree source changed during audit packaging' }
    }
    [IO.File]::Copy($exe, $OutputExe, $false)
    $exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $OutputExe).Hash -ne $exeHash) {
        throw 'Direct application EXE differs from the verified audit build'
    }
    [PSCustomObject]@{
        ApplicationExe = $OutputExe
        ApplicationSHA256 = $exeHash
        AuditZip = $OutputZip
        ZipBytes = $zipBytes
        ExtractedBytes = $extractedBytes
        Files = $unpackedFiles.Count
        ZipSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputZip).Hash
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
        Write-Warning "Package verification failed; staging preserved at $scratch"
    }
}
