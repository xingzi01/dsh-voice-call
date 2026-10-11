# Install dsh-voice-call into the desktop profile (idempotent, backs up first).
# English-only to avoid the PowerShell 5.1 + no-BOM encoding trap.
# Portable: no absolute paths are baked in.
$ErrorActionPreference = 'Stop'

# --- locate everything without hardcoding this machine -----------------------
# plugin dir = parent of this script's own directory
$pluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $env:DSH_HOME) { throw 'DSH_HOME is not set; set it to your .dsh directory and retry' }
$profileDir = Join-Path $env:DSH_HOME 'profiles\desktop'

# node: prefer whatever is on PATH, else the runtime DSH ships inside its data dir
$nodeExe = $null
$cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if ($cmd) { $nodeExe = $cmd.Source }
if (-not $nodeExe) {
  $cand = Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $cand) { $nodeExe = $cand }
}
if (-not $nodeExe) { throw 'node not found: put node on PATH, or point DSH_HOME at your .dsh directory' }

$pkgName = 'dsh-voice-call'

if (-not (Test-Path $pluginDir)) { throw "plugin dir not found: $pluginDir" }
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) { throw "profile package.json not found: $profileDir" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $profileDir ("_backup_voice-call-" + $stamp)
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
foreach ($f in @('package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml')) {
  $src = Join-Path $profileDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $backupDir $f) }
}
Write-Output "backup   -> $backupDir"

# 1) link the plugin into the profile's node_modules
$linkPath = Join-Path $profileDir "node_modules\$pkgName"
if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    $item.Delete()
    Write-Output "removed  -> old link $linkPath"
  } else {
    throw "$linkPath exists and is NOT a link; refusing to delete a real directory"
  }
}
New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
Write-Output "junction -> $linkPath"

# 2) register the package + bundle in the profile manifest
$patchScript = Join-Path $env:TEMP 'voice-call-patch-profile.cjs'
$js = @'
const fs = require('fs')
const file = process.argv[2]
const linkTarget = process.argv[3]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-voice-call'] = 'link:' + String(linkTarget).replace(/\\/g, '/')
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!pkg.dsh.profile.bundles.includes('dsh-voice-call')) pkg.dsh.profile.bundles.push('dsh-voice-call')
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('bundles  -> ' + pkg.dsh.profile.bundles.join(', '))
'@
[System.IO.File]::WriteAllText($patchScript, $js, [System.Text.UTF8Encoding]::new($false))
& $nodeExe $patchScript (Join-Path $profileDir 'package.json') $pluginDir
if ($LASTEXITCODE -ne 0) { throw "failed to patch profile package.json" }

Write-Output ""
Write-Output "installed. restart DSH to load the plugin."
