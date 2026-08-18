$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $projectRoot

Write-Host '=== Universal HTTP Video Studio GitHub Backup ===' -ForegroundColor Cyan

# Confirm GitHub authentication.
gh auth status | Out-Host
$login = (gh api user --jq .login).Trim()
$userId = (gh api user --jq .id).Trim()
if (-not $login) { throw 'Unable to resolve GitHub login.' }

# Initialize repository only if needed.
if (-not (Test-Path (Join-Path $projectRoot '.git'))) {
  git init -b main | Out-Host
}

# Configure repository-local identity if missing.
if (-not (git config user.name)) {
  git config user.name $login
}
if (-not (git config user.email)) {
  git config user.email "$userId+$login@users.noreply.github.com"
}

# Stage source according to .gitignore.
git add --all

# Hard safety gate: never allow known runtime secrets / build outputs into the commit.
$staged = @(git diff --cached --name-only)
$blockedPatterns = @(
  '^日本cookie\.txt$',
  '(^|/)storage/data/',
  '(^|/)storage/secrets/',
  '(^|/)storage/cache/',
  '(^|/)storage/logs/',
  '(^|/)node_modules/',
  '(^|/)release/',
  '(^|/)release-[^/]+/',
  '(^|/)\.env($|\.)',
  '\.db($|-wal$|-shm$)',
  'master\.key$'
)
$blocked = foreach ($file in $staged) {
  foreach ($pattern in $blockedPatterns) {
    if ($file -match $pattern) { $file; break }
  }
}
if ($blocked) {
  git reset | Out-Null
  throw "Safety check failed. Blocked files were staged:`n$($blocked -join "`n")"
}

# Lightweight secret scan of staged text content.
$secretHits = @()
foreach ($file in $staged) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
  try {
    $text = Get-Content -LiteralPath $file -Raw -ErrorAction Stop
  } catch { continue }
  if ($text -match '(?i)(sessionid|csrftoken|authorization)\s*[:=]\s*["'']?(?!STAGE2_FAKE_)[A-Za-z0-9_%+\-\.]{16,}') {
    $secretHits += $file
  }
}
if ($secretHits) {
  git reset | Out-Null
  throw "Potential credential-like content detected in staged files:`n$($secretHits -join "`n")"
}

# Commit current source snapshot.
if ($staged.Count -gt 0) {
  git commit -m 'Backup V0.5.10 source' | Out-Host
} else {
  Write-Host 'No source changes to commit.' -ForegroundColor Yellow
}

# Create/refresh a source backup tag.
$tag = 'v0.5.10-source-backup'
if (git tag -l $tag) {
  git tag -d $tag | Out-Host
}
git tag -a $tag -m 'Universal HTTP Video Studio V0.5.10 source backup'

# Produce an additional local ZIP from the committed tree.
$backupDir = Join-Path (Split-Path $projectRoot -Parent) '源码备份'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$zipPath = Join-Path $backupDir 'universal_http_video_studio_V0.5.10_source.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
git archive --format=zip --output="$zipPath" HEAD

# Create or attach private GitHub repository.
$repoName = 'universal-http-video-studio'
$repoFull = "$login/$repoName"
gh repo view $repoFull --json nameWithOwner,visibility 2>$null | Out-Null
$repoExists = ($LASTEXITCODE -eq 0)
$remoteUrl = "https://github.com/$repoFull.git"

if (-not $repoExists) {
  gh repo create $repoFull --private --description 'Universal HTTP Video Studio source backup' | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub repository creation failed for $repoFull."
  }
}

$origin = git remote get-url origin 2>$null
if (-not $origin) {
  git remote add origin $remoteUrl
} elseif ($origin.TrimEnd('/') -ne $remoteUrl.TrimEnd('/')) {
  git remote set-url origin $remoteUrl
}

$origin = git remote get-url origin 2>$null
if (-not $origin) {
  throw 'Git remote origin was not created.'
}

# Push source and tag.
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'Failed to push main branch.' }
git push origin $tag
if ($LASTEXITCODE -ne 0) { throw "Failed to push tag $tag." }

Write-Host ''
Write-Host 'Backup completed.' -ForegroundColor Green
Write-Host "GitHub: https://github.com/$repoFull"
Write-Host "Local ZIP: $zipPath"
Write-Host ''
Write-Host 'Tracked files:'
git ls-files | Out-Host
