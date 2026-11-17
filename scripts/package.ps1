$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
$outputDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$releaseFiles = @('manifest.json', 'core.js', 'bridge.js', 'scanner.js', 'background.js', 'offscreen.html', 'offscreen.js', 'popup.html', 'popup.css', 'popup.js', 'README.md', 'PRIVACY.md', 'LICENSE')
$releasePaths = foreach ($entry in $releaseFiles) {
    $fullPath = Join-Path $projectRoot $entry
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Missing release file: $entry" }
    $fullPath
}
$archive = Join-Path $outputDir "x-art-collector-v$($manifest.version).zip"
Compress-Archive -LiteralPath $releasePaths -DestinationPath $archive -Force
$digest = Get-FileHash -LiteralPath $archive -Algorithm SHA256
Set-Content -LiteralPath "$archive.sha256" -Value "$($digest.Hash.ToLower())  $([IO.Path]::GetFileName($archive))" -Encoding utf8
Write-Output $archive
Write-Output "$archive.sha256"
