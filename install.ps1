<#
  Install dsh-download into a DeepSeek Harness (dsh) profile.

  Offline, no pnpm, no network. `dsh plugin add` forwards to pnpm, and pnpm is not present on
  every Windows machine - and installing it needs the network. For a plugin with no dependencies,
  everything that command achieves is three edits, so this script makes them itself:

    1. declare the dependency in the profile manifest,
    2. add the bundle row that makes this folder a layer of the composed tree,
    3. link this folder into the profile's node_modules.

  It backs the manifest up first, verifies that the profile still composes afterwards, and restores
  the backup if it does not. It also smoke-tests the bundled engine with the machine's own Node, so
  a broken copy or a too-old Node is caught here rather than on the first download.

  The engine that needs no external program (built-in) is the default, so nothing else has to be
  installed: Neat Download Manager is optional and only used if the engine setting selects it.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileName tui
    powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome D:\dsh -NoVerify

  Messages are ASCII English on purpose: a copy of this file re-saved without its BOM would be read
  as ANSI by PowerShell 5.1 and mangle non-ASCII text in the console.
#>
# The parameter must not be called $Profile: that is a PowerShell automatic variable, and shadowing
# it once created a bogus profile literally named "," plus a stray profiles\ directory.
param(
  [string]$ProfileName = 'web',
  [string]$DshHome,
  [string]$DshPath,
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'

function Say([string]$message) { Write-Host $message }
function Step([string]$message) { Write-Host ''; Write-Host "== $message" }
function Fail([string]$message) { throw $message }

# ------------------------------------------------------------------ locate this plugin --------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Say "Plugin folder : $here"
Say "Profile       : $ProfileName"

$manifestPath = Join-Path $here 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Fail "package.json is not beside this script. Extract the ZIP to a folder and run install.cmd from inside it."
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.dsh.bundle.patch) {
  Fail "This folder is not a dsh bundle: package.json declares no dsh.bundle.patch."
}
$patchPath = Join-Path $here $manifest.dsh.bundle.patch
if (-not (Test-Path -LiteralPath $patchPath)) {
  Fail "The bundle patch $($manifest.dsh.bundle.patch) is missing, so the copy is incomplete."
}
$enginePath = Join-Path $here 'lib\engine-builtin.js'
if (-not (Test-Path -LiteralPath $enginePath)) {
  Fail "lib\engine-builtin.js is missing, so the copy is incomplete."
}
Say "Bundle        : $($manifest.name) $($manifest.version) (built-in engine included)"

# ------------------------------------------------------------------ prerequisite: Node -------
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) {
  Fail "Node.js is not on PATH. dsh needs it, so install Node 18 or newer first: https://nodejs.org"
}
$nodeVersion = (& $node.Source -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion -split '\.')[0]
Say "Node          : $nodeVersion ($($node.Source))"
if ($nodeMajor -lt 18) { Fail "Node $nodeVersion is too old; this plugin needs 18 or newer (it uses fetch and Readable.fromWeb)." }

# ------------------------------------------------------------------ prerequisite: dsh --------
# Every place this script looks, so that a failure can say where it looked rather than leaving the
# reader to guess whether dsh is missing or merely somewhere unexpected.
$script:dshSearch = New-Object System.Collections.Generic.List[string]

function Find-DshCandidate {
  param([string]$Path)
  if (-not $Path) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  # A .js path is dsh's own entry point, which has to be run with node; a .cmd is a shim Windows
  # runs directly. Accepting both is what makes -DshPath usable whatever the caller has to hand.
  if ($Path -like '*.js') { return @{ kind = 'bin'; path = $Path } }
  return @{ kind = 'exe'; path = $Path }
}

function Resolve-Dsh {
  param([string]$Explicit)

  if ($Explicit) {
    $script:dshSearch.Add("-DshPath: $Explicit")
    if (-not (Test-Path -LiteralPath $Explicit)) { Fail "-DshPath '$Explicit' does not exist." }
    return (Find-DshCandidate $Explicit)
  }

  # 1. Whatever the shell can find on PATH.
  foreach ($name in @('dsh.cmd', 'dsh.exe', 'dsh')) {
    $script:dshSearch.Add("PATH lookup: $name")
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found -and (Test-Path -LiteralPath $found.Source)) { return @{ kind = 'exe'; path = $found.Source } }
  }

  # 2. where.exe, which resolves a PATH entry even when PowerShell's command discovery does not.
  try {
    $script:dshSearch.Add('where.exe dsh')
    $located = & where.exe dsh 2>$null | Select-Object -First 1
    if ($located) {
      $hit = Find-DshCandidate $located.Trim()
      if ($hit) { return $hit }
    }
  } catch {
    # where.exe is not present everywhere
  }

  # 3. Ask npm where its global files are instead of assuming the default folder. This is the check
  #    that finds a normal installation made with a different prefix, or on another drive.
  foreach ($npmName in @('npm.cmd', 'npm')) {
    $npm = Get-Command $npmName -ErrorAction SilentlyContinue
    if (-not $npm) { continue }
    foreach ($arguments in @(@('prefix', '-g'), @('root', '-g'))) {
      $root = $null
      try {
        $root = (& $npm.Source @arguments 2>$null | Select-Object -First 1)
      } catch {
        continue
      }
      if (-not $root) { continue }
      $script:dshSearch.Add("$npmName $($arguments -join ' ') -> $root")
      # What to append depends on the question. `prefix -g` is the folder global shims live in, so
      # the package is under node_modules inside it; `root -g` already IS that node_modules folder.
      # Appending node_modules to a root produced a path that could never exist.
      $relative = if ($arguments -contains 'root') {
        @('@deepseek-ai\dsh\lib\bin.js')
      } else {
        @('dsh.cmd', 'node_modules\@deepseek-ai\dsh\lib\bin.js')
      }
      foreach ($suffix in $relative) {
        $hit = Find-DshCandidate (Join-Path $root $suffix)
        if ($hit) { return $hit }
      }
    }
  }

  # 3b. An installation that has only ever run through `npx` lives in npm's cache: not on PATH, not
  #     in any global prefix, invisible to every check above. That is exactly how dsh is run on some
  #     machines, so the cache is searched too — newest match first, since each npx invocation can
  #     leave its own hash folder behind.
  $npxRoots = New-Object System.Collections.Generic.List[string]
  foreach ($npmName in @('npm.cmd', 'npm')) {
    $npm = Get-Command $npmName -ErrorAction SilentlyContinue
    if (-not $npm) { continue }
    $cache = $null
    try {
      $cache = (& $npm.Source config get cache 2>$null | Select-Object -First 1)
    } catch {
      $cache = $null
    }
    if ($cache) { $npxRoots.Add((Join-Path $cache.Trim() '_npx')) }
    break
  }
  foreach ($fallback in @(
      (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'),
      (Join-Path $env:APPDATA 'npm-cache\_npx')
    )) {
    if ($fallback) { $npxRoots.Add($fallback) }
  }

  foreach ($npxRoot in $npxRoots) {
    $script:dshSearch.Add("npx cache: $npxRoot")
    if (-not (Test-Path -LiteralPath $npxRoot)) { continue }
    $best = $null
    $bestStamp = $null
    foreach ($hashDir in (Get-ChildItem -LiteralPath $npxRoot -Directory -ErrorAction SilentlyContinue)) {
      $candidate = Join-Path $hashDir.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
      if (-not (Test-Path -LiteralPath $candidate)) { continue }
      $stamp = (Get-Item -LiteralPath $candidate).LastWriteTimeUtc
      if ($null -eq $bestStamp -or $stamp -gt $bestStamp) {
        $bestStamp = $stamp
        $best = $candidate
      }
    }
    if ($best) { return @{ kind = 'bin'; path = $best; fromNpx = $true } }
  }

  # 4. pnpm, for an installation made with that instead.
  $pnpm = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
  if ($pnpm) {
    $root = $null
    try {
      $root = (& $pnpm.Source root -g 2>$null | Select-Object -First 1)
    } catch {
      $root = $null
    }
    if ($root) {
      $script:dshSearch.Add("pnpm root -g -> $root")
      $hit = Find-DshCandidate (Join-Path $root '@deepseek-ai\dsh\lib\bin.js')
      if ($hit) { return $hit }
    }
  }

  # 5. The conventional per-user and per-machine locations.
  foreach ($candidate in @(
      (Join-Path $env:APPDATA 'npm\dsh.cmd'),
      (Join-Path $env:LOCALAPPDATA 'npm\dsh.cmd'),
      (Join-Path $env:ProgramFiles 'nodejs\dsh.cmd'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\dsh.cmd'),
      (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'),
      (Join-Path $env:LOCALAPPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'),
      (Join-Path $env:ProgramFiles 'nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js')
    )) {
    $hit = Find-DshCandidate $candidate
    if ($hit) { return $hit }
  }

  return $null
}

$dsh = Resolve-Dsh -Explicit $DshPath
if (-not $dsh) {
  # Built as separate lines rather than a here-string: the message contains backslash paths and
  # quotes, and a here-string got the quoting wrong once already.
  $searched = ($script:dshSearch | ForEach-Object { '    ' + $_ }) -join "`n"
  $advice = @(
    'dsh (DeepSeek Harness) was not found, so there is no profile to install this plugin into.',
    'This plugin is an add-on: dsh must be installed and started at least once.',
    '',
    '  1. Install dsh, then run it once so it creates its profile:',
    '         npm i -g @deepseek-ai/dsh',
    '         dsh web',
    '  2. Run install.cmd again from this folder.',
    '',
    'If dsh IS already installed, it is somewhere this script did not look. Either:',
    '  - run this installer from the Windows account that runs dsh (dsh home is per-account), or',
    '  - point at it explicitly; both the shim and dsh''s own entry point are accepted:',
    '         install.cmd -DshPath "C:\path\to\dsh.cmd"',
    '         install.cmd -DshPath "C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js"',
    '',
    'If a security suite is running (360 Security Guard, Defender, ...), it can also block this',
    'script from starting the commands used above. Allow this script there, then try again.',
    '',
    'Checked for dsh in:',
    $searched,
    '',
    'To see whether npm has it at all:  npm ls -g --depth=0 @deepseek-ai/dsh'
  )
  Fail ($advice -join "`n")
}
Say "dsh           : $($dsh.path)"
if ($dsh.fromNpx) {
  # Worth saying out loud: this works, but the folder it resolved to belongs to npx's cache, not to
  # an installation the user chose, and clearing that cache removes it. The plugin's own folder is
  # linked into the profile, so the plugin survives; dsh itself would need running again.
  Say "WARNING       : dsh is only in npm's npx cache, so it is not installed globally."
  Say "                That is fine for installing the plugin, but the cache folder can be"
  Say "                replaced by a later 'npx' run or cleared by 'npm cache clean'."
  Say "                For a setup that does not depend on the cache:  npm i -g @deepseek-ai/dsh"
}

function Invoke-Dsh {
  param([string[]]$Arguments)
  if ($dsh.kind -eq 'bin') { & $node.Source $dsh.path @Arguments } else { & $dsh.path @Arguments }
  return $LASTEXITCODE
}

# ------------------------------------------------------------------ locate the dsh home ------
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
$dshHome = $DshHome
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
Say "dsh home      : $dshHome"
Say "Profile dir   : $profileDir"

if (-not (Test-Path -LiteralPath $profileDir)) {
  $siblings = @()
  $profilesRoot = Join-Path $dshHome 'profiles'
  if (Test-Path -LiteralPath $profilesRoot) { $siblings = @(Get-ChildItem -LiteralPath $profilesRoot -Directory | Select-Object -ExpandProperty Name) }
  Fail @"
Profile '$ProfileName' does not exist yet.
  Run dsh once so it creates the profile, then run this installer again:
      dsh web
  Existing profiles: $(if ($siblings.Count) { $siblings -join ', ' } else { 'none' })
  Use -ProfileName to target a different one.
"@
}

$profileManifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest)) {
  Fail "The profile has no package.json, so dsh never finished initialising it. Run 'dsh web' once, then run this installer again."
}

# ------------------------------------------------------------------ back up the manifest -----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $dshHome "_backup-ndm-install-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $profileManifest -Destination (Join-Path $backupDir 'package.json') -Force
Say "Backup        : $backupDir\package.json"

function Restore-Manifest {
  Copy-Item -LiteralPath (Join-Path $backupDir 'package.json') -Destination $profileManifest -Force
  Say "Rolled back   : the profile manifest was restored from the backup."
}

# ------------------------------------------------------------------ 1. declare the dependency -
$profile = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
if ($null -eq $profile.dependencies) {
  $profile | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
}
# Forward slashes: that is the form pnpm writes and the form the manifest already uses here.
$linkTarget = $here -replace '\\', '/'
$alreadyInstalled = $false
if ($profile.dependencies.PSObject.Properties.Name -contains $manifest.name) {
  $existing = $profile.dependencies.$($manifest.name)
  if ($existing -eq "link:$linkTarget") { $alreadyInstalled = $true }
  Say "Dependency    : already declared as $existing"
} else {
  $profile.dependencies | Add-Member -NotePropertyName $manifest.name -NotePropertyValue "link:$linkTarget" -Force
  Say "Dependency    : link:$linkTarget"
}

# ------------------------------------------------------------------ 2. add the bundle row ---
if ($null -eq $profile.dsh) { $profile | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{}) -Force }
if ($null -eq $profile.dsh.profile) { $profile.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{}) -Force }
$bundles = @()
if ($profile.dsh.profile.PSObject.Properties.Name -contains 'bundles') { $bundles = @($profile.dsh.profile.bundles) }
if ($bundles -contains $manifest.name) {
  Say "Bundle row    : already present"
} else {
  $bundles = @($bundles) + $manifest.name
  $profile.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $bundles -Force
  Say "Bundle row    : added '$($manifest.name)' (now: $($bundles -join ', '))"
}

# Written without a BOM: the profile manifest is parsed as JSON by dsh, and a leading U+FEFF makes
# JSON.parse reject the whole file.
$json = $profile | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($profileManifest, $json, (New-Object System.Text.UTF8Encoding($false)))

# ------------------------------------------------------------------ 3. link the folder -------
$nodeModules = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null }
$linkPath = Join-Path $nodeModules $manifest.name

# What the existing link points at, so it can be put back if this goes wrong.
$previousTarget = $null
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType) {
    $previousTarget = @($item.Target)[0]
  } elseif ($item.PSIsContainer) {
    $contents = @(Get-ChildItem -LiteralPath $linkPath -Force)
    if ($contents.Count -gt 0) {
      Fail "$linkPath already exists as a real folder with $($contents.Count) entries. Refusing to delete it; move it away and re-run."
    }
    Remove-Item -LiteralPath $linkPath -Force
    Say "Empty folder  : removed $linkPath"
  } else {
    Fail "$linkPath exists as a file. Move it away and re-run."
  }
}

function Remove-Link {
  param([string]$Path)
  # Directory.Delete throws on a missing path; a link that is already gone is not a problem to
  # report, and an exception inside a rollback handler would abort the rollback itself.
  try { if (Test-Path -LiteralPath $Path) { [System.IO.Directory]::Delete($Path, $false) } } catch { }
}

function New-Junction {
  param([string]$Path, [string]$Target)
  # Retried, because creating a link beside a running dsh can fail transiently — an antivirus filter
  # or a handle on the directory returns an access error that succeeds a moment later. The retry is
  # what turns that from a broken install into a slightly slower one.
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      New-Item -ItemType Junction -Path $Path -Target $Target -ErrorAction Stop | Out-Null
      return $null
    } catch {
      $reason = $_.Exception.Message
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
  return $reason
}

function Restore-PreviousLink {
  if (-not $previousTarget) { return }
  try {
    Remove-Link $linkPath
    New-Item -ItemType Junction -Path $linkPath -Target $previousTarget -ErrorAction Stop | Out-Null
    Say "Rolled back   : the previous link was put back ($previousTarget)"
  } catch {
    Say "WARNING: the previous link could not be restored; re-run this installer."
  }
}

# The new link is built under a temporary name and only takes the real name once it is known to
# work. Deleting the working link first and then failing to create its replacement — which is what
# this used to do — leaves a profile that names a plugin it cannot resolve, and that is a worse
# state than not having run the installer at all.
$staging = Join-Path $nodeModules ".$($manifest.name).link-incoming"
if (Test-Path -LiteralPath $staging) { Remove-Link $staging }

$failed = New-Junction -Path $staging -Target $here
if ($failed) {
  Restore-Manifest
  Restore-PreviousLink
  Fail "Could not create the folder link: $failed`n  from: $staging`n  to:   $here`nNothing was changed in the profile."
}

try {
  Remove-Link $linkPath
  [System.IO.Directory]::Move($staging, $linkPath)
  Say "Linked        : $linkPath -> $here"
} catch {
  $reason = $_.Exception.Message
  $failed = New-Junction -Path $linkPath -Target $here
  if ($failed) {
    Remove-Link $staging
    Restore-Manifest
    Restore-PreviousLink
    Fail "Could not put the folder link in place: $failed`n  (first failure: $reason)`nNothing was changed in the profile."
  }
  Remove-Link $staging
  Say "Linked        : $linkPath -> $here (after a retry)"
}

# ------------------------------------------------------------------ smoke-test the engine ----
$engineUrl = 'file:///' + ($enginePath -replace '\\', '/')
$probe = "import('$engineUrl').then(m => process.exit(typeof m.downloadSegmented === 'function' ? 0 : 3)).catch(e => { console.error(e.message); process.exit(4) })"
& $node.Source -e $probe
if ($LASTEXITCODE -ne 0) {
  Restore-Manifest
  Remove-Link $linkPath
  Restore-PreviousLink
  Fail "The bundled engine failed to load (node exit $LASTEXITCODE). Nothing was installed. Is the copy complete?"
}
Say "Engine        : loads, and its downloader entry point is present"

# ------------------------------------------------------------------ verify it composes -------
if ($NoVerify) {
  Say "Verification  : skipped (-NoVerify)"
} else {
  Step "Verifying that profile '$ProfileName' still composes"
  $dump = Invoke-Dsh -Arguments @('--profile', $ProfileName, '--dump-config') 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $dump | Select-Object -First 20 | ForEach-Object { Say "  $_" }
    Restore-Manifest
    Fail "dsh could not compose the profile with this plugin (exit $code). Nothing was installed."
  }
  if (-not ($dump -match 'tool-dsh-download')) {
    $dump | Select-Object -First 20 | ForEach-Object { Say "  $_" }
    Restore-Manifest
    Fail "The plugin's row did not appear in the composed config. Nothing was installed."
  }
  Say "OK            : row 'tool-dsh-download' is composed into profile '$ProfileName'"
}

if (-not (Resolve-Path -LiteralPath $linkPath).Path) { Fail "The link disappeared during installation." }

Step "Installed"
Say "The built-in engine is the default, so nothing else needs installing."
Say "Neat Download Manager is optional: only the 'ndm' engine uses it."
Say ""
Say "Next:"
Say "  1. stop the running dsh"
Say "  2. start it again            (a bundle layer is read at boot)"
Say "  3. open a new conversation   (download_file appears in the tool list)"
Say "  4. Settings -> Plugins -> the download tab now shows progress and history"
Say ""
Say "Files this plugin will use:"
Say "  settings : $dshHome\dsh-download.settings.json   (created on first load)"
Say "  history  : $dshHome\dsh-download.status.json"
Say ""
Say "Do NOT move or delete this folder: the profile links to it."
Say "To remove it later: run uninstall.cmd from this folder."
