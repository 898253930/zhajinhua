[CmdletBinding()]
param(
    [ValidateSet('amd', 'amd64', 'arm', 'arm64')][string]$Arch,
    [string]$Image,
    [string]$Tag,
    [string]$OutputDir,
    [string]$BaseImage,
    [switch]$NoExport,
    [switch]$NonInteractive,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
function Read-Default([string]$Prompt, [string]$Default) {
    if ($NonInteractive) { return $Default }
    $answer = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}
Write-Host '=== Jinhua Docker packaging wizard ===' -ForegroundColor Cyan
if (-not $Arch) {
    do {
        $choice = Read-Default 'Architecture: 1 = AMD64 (Intel/AMD), 2 = ARM64' '1'
        $Arch = switch ($choice.ToLowerInvariant()) {
            '1' { 'amd64' } 'amd' { 'amd64' } 'amd64' { 'amd64' }
            '2' { 'arm64' } 'arm' { 'arm64' } 'arm64' { 'arm64' }
            default { Write-Host 'Please choose 1/amd64 or 2/arm64.' }
        }
    } while (-not $Arch)
}
$targetArch = if ($Arch -in @('amd', 'amd64')) { 'amd64' } else { 'arm64' }
if (-not $Image) { $Image = Read-Default 'Image repository (e.g. zhajinhua or registry.example.com/team/game)' 'zhajinhua' }
if (-not $Tag) { $Tag = Read-Default 'Image tag (used exactly as entered)' "latest-$targetArch" }
if (-not $BaseImage) { $BaseImage = Read-Default 'Node 24 base image (Docker official image via AWS ECR; editable)' 'public.ecr.aws/docker/library/node:24-bookworm-slim' }
if ($Image -cnotmatch '^(?:[a-z0-9.-]+(?::[0-9]+)?/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$') { throw 'Invalid image repository. Use lowercase and put the tag in the Tag field.' }
if ($Tag -cnotmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') { throw 'Invalid tag: use 1-128 letters/digits/underscore/dot/hyphen; do not start with dot or hyphen.' }
if (-not $NoExport -and -not $OutputDir) { $OutputDir = Read-Default 'Archive directory (.tar.gz; time is local time)' (Join-Path $projectRoot 'dist') }
$imageRef = "${Image}:${Tag}"
$buildArgs = @('buildx', 'build', '--platform', "linux/$targetArch", '--build-arg', "NODE_IMAGE=$BaseImage", '--tag', $imageRef, '--load', '--file', (Join-Path $projectRoot 'Dockerfile'), $projectRoot)
$archivePath = $null
if (-not $NoExport) {
    $OutputDir = [IO.Path]::GetFullPath($OutputDir)
    $safeImage = $Image -replace '[^A-Za-z0-9_.-]', '_'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $archivePath = Join-Path $OutputDir "${safeImage}_${Tag}_${targetArch}_${stamp}.tar.gz"
}
Write-Host "Platform: linux/$targetArch"
Write-Host "Image:    $imageRef"
Write-Host "Base:     $BaseImage"
if ($archivePath) { Write-Host "Archive:  $archivePath" }
if ($DryRun) { Write-Host ('Build: docker ' + ($buildArgs -join ' ')); return }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop (Windows/macOS) or Docker Engine + Buildx (Linux): https://docs.docker.com/get-started/get-docker/' }
$osType = & docker info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0 -or -not $osType) { throw 'Start Docker Desktop / Docker Engine, then run this script again.' }
if ($osType -ne 'linux') { throw 'Switch Docker Desktop to Linux containers first.' }
& docker buildx version
if ($LASTEXITCODE -ne 0) { throw 'Docker Buildx is required: https://docs.docker.com/build/buildx/' }
if (-not $NonInteractive) {
    $confirm = Read-Default 'Build and package now? Y/n' 'Y'
    if ($confirm -notin @('Y', 'y', 'yes', 'YES')) { Write-Host 'Cancelled.'; return }
}
& docker @buildArgs
if ($LASTEXITCODE -ne 0) { throw 'Docker build failed. If pulling the base image timed out, check Docker Desktop proxy/DNS or rerun with -BaseImage YOUR_TRUSTED_MIRROR/node:24-bookworm-slim. No archive was exported.' }
if ($archivePath) {
    [IO.Directory]::CreateDirectory($OutputDir) | Out-Null
    if (Test-Path -LiteralPath $archivePath) { throw "Archive already exists: $archivePath" }
    $tempId = [guid]::NewGuid().ToString('N')
    $tarPath = Join-Path $OutputDir ".jinhua-$tempId.tar"
    $gzipPath = Join-Path $OutputDir ".jinhua-$tempId.tar.gz.partial"
    try {
        & docker image save --output $tarPath $imageRef
        if ($LASTEXITCODE -ne 0) { throw 'Image export failed.' }
        Write-Host 'Compressing image (gzip)...'
        $inputStream = $null; $outputStream = $null; $gzipStream = $null
        try {
            $inputStream = [IO.File]::OpenRead($tarPath)
            $outputStream = [IO.File]::Open($gzipPath, [IO.FileMode]::CreateNew)
            $gzipStream = [IO.Compression.GZipStream]::new($outputStream, [IO.Compression.CompressionLevel]::Optimal, $true)
            $inputStream.CopyTo($gzipStream)
        } finally {
            if ($gzipStream) { $gzipStream.Dispose() }
            if ($outputStream) { $outputStream.Dispose() }
            if ($inputStream) { $inputStream.Dispose() }
        }
        [IO.File]::Move($gzipPath, $archivePath)
    } finally {
        foreach ($tempPath in @($tarPath, $gzipPath)) {
            if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
        }
    }
    $checksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$checksum  $([IO.Path]::GetFileName($archivePath))" | Set-Content -LiteralPath "$archivePath.sha256" -Encoding ascii
    $size = [Math]::Round((Get-Item -LiteralPath $archivePath).Length / 1MB, 2)
    Write-Host "Archive: $archivePath ($size MiB)" -ForegroundColor Green
    Write-Host "Import: docker load --input `"$archivePath`""
}
Write-Host "Built: $imageRef (linux/$targetArch)" -ForegroundColor Green
Write-Host "Run: docker run -d --init --name jinhua -p 3001:3000 --env-file .env -v jinhua-data:/app/data $imageRef"
Write-Host 'Initialize admin (if needed): docker exec -it jinhua node docker/setup-admin.mjs'
