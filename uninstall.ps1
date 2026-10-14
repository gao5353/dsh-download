<#
  Remove dsh-download from a dsh profile, undoing exactly what install.ps1 did.

  Usage:
    powershell -ExecutionPolicy Bypass -File uninstall.ps1
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -ProfileName tui
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge    # also delete settings + history

  What it does NOT touch: the plugin folder itself, and anything a download left in a destination
  folder. An interrupted download can leave <dest>.part and <dest>.part.json next to where the file
  was going; those are named on the console rather than deleted, because only you know whether the
  partial transfer is still wanted.
#>
param(
  [string]$ProfileName = 'web',
  [string]$DshHome,
  [string]$DshPath,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'

function Say([string]$message) { Write-Host $message }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -LiteralPath (Join-Path $here 'package.json') -Raw | ConvertFrom-Json
$name = $manifest.name

if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$profileManifest = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $profileDir "node_modules\$name"

Say "Plugin        : $name"
Say "Profile dir   : $profileDir"

if (-not (Test-Path -LiteralPath $profileManifest)) {
  Say "The profile has no package.json; there is nothing registered to remove."
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $DshHome "_backup-ndm-uninstall-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $profileManifest -Destination (Join-Path $backupDir 'package.json') -Force
Say "Backup        : $backupDir\package.json"

$profile = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
$changed = $false

if ($profile.dependencies -and ($profile.dependencies.PSObject.Properties.Name -contains $name)) {
  $profile.dependencies.PSObject.Properties.Remove($name)
  $changed = $true
  Say "Dependency    : removed"
}
$bundles = @()
if ($profile.dsh.profile.PSObject.Properties.Name -contains 'bundles') { $bundles = @($profile.dsh.profile.bundles) }
if ($bundles -contains $name) {
  $bundles = @($bundles | Where-Object { $_ -ne $name })
  $profile.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $bundles -Force
  $changed = $true
  Say "Bundle row    : removed (now: $($bundles -join ', '))"
}
if ($changed) {
  [System.IO.File]::WriteAllText($profileManifest, ($profile | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
} else {
  Say "Nothing was registered in this profile; the manifest was left untouched."
  Remove-Item -LiteralPath $backupDir -Recurse -Force
}

if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType) {
    [System.IO.Directory]::Delete($linkPath, $false)
    Say "Link          : removed ($($item.LinkType))"
  } else {
    Say "Link          : $linkPath is not a link; leaving it alone."
  }
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
$dsh = $null
if ($DshPath) { $dsh = @{ kind = 'exe'; path = $DshPath } }
else {
  foreach ($candidate in @((Join-Path $env:APPDATA 'npm\dsh.cmd'), (Join-Path $env:LOCALAPPDATA 'npm\dsh.cmd'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $dsh = @{ kind = 'exe'; path = $candidate }; break }
  }
  if (-not $dsh) {
    $found = Get-Command dsh.cmd -ErrorAction SilentlyContinue
    if ($found) { $dsh = @{ kind = 'exe'; path = $found.Source } }
  }
}
if ($dsh -and $node) {
  Say ''
  Say "Verifying the profile still composes without it..."
  $dump = & $dsh.path --profile $ProfileName --dump-config 2>&1
  if ($LASTEXITCODE -eq 0 -and -not ($dump -match 'tool-dsh-download')) {
    Say "OK            : the plugin's row is gone and the profile still composes."
  } elseif ($LASTEXITCODE -ne 0) {
    Say "dump-config failed (exit $LASTEXITCODE); restore the backup above if the profile is broken."
  }
}

if ($Purge) {
  foreach ($leftover in @('dsh-download.settings.json', 'dsh-download.status.json')) {
    $path = Join-Path $DshHome $leftover
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
      Say "Purged        : $path"
    }
  }
} else {
  Say ''
  Say "Kept (use -Purge to delete them):"
  foreach ($leftover in @('dsh-download.settings.json', 'dsh-download.status.json')) {
    $path = Join-Path $DshHome $leftover
    if (Test-Path -LiteralPath $path) { Say "  $path" }
  }
}

Say ''
Say "Restart dsh for the removal to take effect. The plugin folder was left in place:"
Say "  $here"
