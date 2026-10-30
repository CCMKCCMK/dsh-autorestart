<#
.SYNOPSIS
  dsh-autorestart profile snapshot restorer (half of the rescue kit).

.DESCRIPTION
  When DSH does not come up (a plugin upgrade broke the profile, the
  configuration was damaged, node_modules is a mess), this script puts the
  profile back the way the last snapshot found it. It does not need DSH itself
  and it does not need node.

  It does four things, in this order:

    1. find the snapshot to restore (by default: the newest one under
       <stateDir>\backups\ that carries a manifest);
    2. MOVE the current profile to <profileDir>.broken-<yyyyMMdd-HHmmss> first
       - never overwritten, never deleted, so the evidence survives;
    3. copy the configuration files and the plugin tree back;
    4. read the result back: package.json parses, dsh.profile.bundles has
       content, the version of dsh-autorestart can be read. Anything that does
       not hold is reported honestly, together with the directory that still
       holds the old profile.

  Two hard rules:

    1. ONLY DSH PROFILE DIRECTORIES ARE TOUCHED: by default only
       <user home>\.dsh\profiles\*; even an explicitly named -ProfileDir is
       refused when it is a drive root, a system directory or somebody else's
       user directory. A target that does not look like a DSH profile (no
       package.json, or a package.json without a dsh.profile section) is
       REFUSED.
    2. DSH IS NEVER RESTARTED FOR YOU: the script only puts the files back.
       A script that "rescues" you and hangs the host again is useless.

  LANGUAGE: this file is pure ASCII on purpose. Windows PowerShell 5.1 reads a
  UTF-8 file without a byte order mark as ANSI, so a single Chinese character
  inside the script turns into mojibake and the script dies with a
  ParserError before it does anything. The Chinese wording therefore lives in
  scripts\rescue-strings.zh.json (UTF-8, no BOM) and is read at runtime; if
  that file is missing or broken, every message falls back to the English text
  below and the script says so.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-profile.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-profile.ps1 -DryRun

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-profile.ps1 -ProfileDir C:\temp\drill\profile -StateDir C:\temp\drill\state

.NOTES
  Windows PowerShell 5.1 is enough (nothing from 6.0+ is used); the .cmd entry
  point double-clicked by the user is that one too. The same rules exist in
  lib/rescue.js (node can import and test them directly), and
  scripts/drill-rescue.ps1 proves that both behave the same way.
#>
[CmdletBinding()]
param(
  # Only print what would happen, change nothing.
  [switch] $DryRun,

  # Use this snapshot (default: the newest one that carries a manifest).
  [string] $Snapshot = '',

  # The profile directory to restore into (default: the desktop one).
  [string] $ProfileDir = '',

  # The plugin state directory (default: <DSH_HOME>\storages\dsh-autorestart).
  [string] $StateDir = '',

  # Replace EVERY linked plugin with the copy from the snapshot, even when its
  # link target is still there. Without this switch a link whose target works is
  # KEPT, so a `link:` installation keeps pointing at its development directory.
  [switch] $ForceLinkPlugins
)

$ErrorActionPreference = 'Stop'

# The name of this plugin, in the profile and in the plugin tree.
$PackageName = 'dsh-autorestart'

# Where the old profile is kept after it is moved away (the user is told
# about it when something fails, so it lives in the script scope).
$script:BrokenDir = ''

# ---------------------------------------------------------------------------
# The Chinese strings: read from rescue-strings.zh.json, fall back to English.
# ---------------------------------------------------------------------------

$script:Strings = $null
$script:StringsError = ''

function Initialize-Strings {
  $path = Join-Path $PSScriptRoot 'rescue-strings.zh.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $script:StringsError = (T 'common.stringsMissingEn' 'the Chinese strings file is missing: {0} (falling back to English messages)') -f $path
    return
  }
  try {
    # Read as UTF-8 explicitly: Get-Content would use the console code page.
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $script:Strings = $text | ConvertFrom-Json
  } catch {
    $script:StringsError = (T 'common.stringsBrokenEn' 'the Chinese strings file could not be read: {0} (falling back to English messages)') -f $_.Exception.Message
    $script:Strings = $null
  }
}

# Look a string up. The English fallback is right here in the script, so a
# missing key (or a broken strings file) never stops the rescue.
function T {
  param([string] $Key, [string] $Fallback)
  if ($null -ne $script:Strings) {
    $node = $script:Strings
    foreach ($part in $Key.Split('.')) {
      if ($null -eq $node) { break }
      $property = $node.PSObject.Properties[$part]
      if ($null -eq $property) { $node = $null; break }
      $node = $property.Value
    }
    if ($null -ne $node) {
      $text = [string] $node
      if ($text -ne '') { return $text }
    }
  }
  return $Fallback
}

Initialize-Strings

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

function Say {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Fail {
  param([string] $Text)
  Write-Host ((T 'restore.failPrefix' 'restore failed: ') + $Text) -ForegroundColor Red
  if ($script:BrokenDir -ne '') {
    Write-Host ((T 'restore.brokenKept' 'your old profile is still here: {0}') -f $script:BrokenDir) -ForegroundColor Yellow
    Write-Host (T 'restore.brokenUntouched' '(that directory was not touched, it still looks like it did before the failure.)') -ForegroundColor Yellow
  }
  exit 1
}

# ---------------------------------------------------------------------------
# THE LINKED PLUGINS (user decision, 2026-10-30)
#
# A `link:` installation puts a REPARSE POINT in node_modules\<name> instead of
# a plugin: the directory is somewhere else (a development checkout). The old
# version of this script copied node_modules as a tree, so it put the LINK back
# and none of its contents - and dsh-autorestart itself is installed that way,
# so the plugin that does the rescuing could not be restored at all.
#
# The backup now records every linked plugin and keeps its CONTENTS in
# node_modules-link\<name>. This part decides, per plugin, whether the link may
# stay or the contents must take its place. The same four answers are used by
# the watchdog (lib/backup.js, decideLinkRestore), so a manual restore and an
# automatic one cannot disagree:
#
#   kept           - the target is there and readable: the link stays (the
#                    development directory keeps working);
#   replaced       - the contents from the backup take the link's place;
#   target-missing - the target is gone AND there is no copy to put back;
#   no-backup      - this backup holds no contents for it, so it is left alone.
#
# NOTHING IS EVER SKIPPED SILENTLY: every linked plugin prints one line.
# ---------------------------------------------------------------------------

# The pure decision (mirrors decideLinkRestore in lib/backup.js).
function Get-LinkDecision {
  param(
    [bool] $TargetExists,
    [bool] $TargetReadable,
    [bool] $HasBackup,
    [bool] $Forced,
    [int] $Attempts = 1
  )
  if ((-not $TargetExists) -and (-not $HasBackup)) { return 'target-missing' }
  if (-not $HasBackup) { return 'no-backup' }
  if ($Forced) { return 'replaced' }
  if (-not $TargetExists) { return 'replaced' }
  if (-not $TargetReadable) { return 'replaced' }
  if ($Attempts -ge 2) { return 'replaced' }
  return 'kept'
}

# Can this directory be read at all?
function Test-DirectoryReadable {
  param([string] $Path)
  if ($Path -eq '') { return $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  try {
    Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Remove the LINK itself, never the directory it points at.
function Remove-LinkEntry {
  param([string] $Path)
  try {
    # Delete(path, recursive=$false) removes a junction / symlink itself.
    [System.IO.Directory]::Delete($Path, $false)
    return $true
  } catch {
    try {
      Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
      return $true
    } catch {
      return $false
    }
  }
}

# Decide about every linked plugin of this snapshot and say so, one line each.
function Invoke-LinkPlugins {
  param(
    [string] $SnapshotDir,
    [string] $ProfileDir,
    [string] $BrokenDir,
    [bool] $Forced,
    [bool] $DryRun,
    [int] $Attempts = 1
  )
  $manifestPath = Join-Path $SnapshotDir 'manifest.json'
  $links = @()
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
      $manifestText = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
      if ($manifestText.Length -gt 0 -and [int][char]$manifestText[0] -eq 0xFEFF) {
        $manifestText = $manifestText.Substring(1)
      }
      $manifest = $manifestText | ConvertFrom-Json
      if ($null -ne $manifest.links) { $links = @($manifest.links) }
    } catch {
      Say (T 'restore.linkManifestUnreadable' '  [warn] the backup manifest cannot be read; linked plugins cannot be inspected.') 'Yellow'
    }
  }
  if ($links.Count -eq 0) {
    Say (T 'restore.linkNone' 'linked plugins in this snapshot: none') 'Gray'
    return
  }

  Say ((T 'restore.linkHeader' 'linked plugins in this snapshot: {0}') -f $links.Count) 'Gray'
  $evidence = New-Object System.Collections.Generic.List[string]
  foreach ($link in $links) {
    $name = [string] $link.name
    if ($name -eq '') { continue }
    $target = [string] $link.target
    $backupDir = Join-Path (Join-Path $SnapshotDir 'node_modules-link') $name
    $livePath = Join-Path (Join-Path $ProfileDir 'node_modules') $name
    $hasBackup = Test-Path -LiteralPath $backupDir -PathType Container
    $targetExists = $target -ne '' -and (Test-Path -LiteralPath $target -PathType Container)
    $targetReadable = Test-DirectoryReadable $target
    $decision = Get-LinkDecision -TargetExists $targetExists -TargetReadable $targetReadable -HasBackup $hasBackup -Forced $Forced -Attempts $Attempts

    if ($decision -eq 'replaced') {
      if ($DryRun) {
        Say ((T 'restore.linkDryRunReplaced' '  [dry run] {0}: would be REPLACED by the copy in the snapshot') -f $name) 'Cyan'
      } else {
        $removed = $true
        if (Test-Path -LiteralPath $livePath) { $removed = Remove-LinkEntry $livePath }
        if (-not $removed) {
          Say ((T 'restore.linkRemoveFailed' '  [bad] {0}: the link could not be removed, the copy was NOT put in place') -f $name) 'Red'
          $evidence.Add($name + ': replaced requested but the link could not be removed')
          continue
        }
        try {
          Copy-Item -LiteralPath $backupDir -Destination $livePath -Recurse -Force -ErrorAction Stop
          $why = 'forced'
          if (-not $Forced) {
            if (-not $targetExists) { $why = 'target-missing' }
            elseif (-not $targetReadable) { $why = 'target-unreadable' }
            else { $why = 'attempt ' + $Attempts }
          }
          Say ((T 'restore.linkReplaced' '  [ok] {0}: REPLACED by the copy from the snapshot ({1})') -f $name, $why) 'Green'
          $evidence.Add($name + ': replaced (' + $why + '); old target was ' + $target)
        } catch {
          Say ((T 'restore.linkCopyFailed' '  [bad] {0}: the copy could not be put in place: {1}') -f $name, $_.Exception.Message) 'Red'
          $evidence.Add($name + ': replaced requested but the copy failed: ' + $_.Exception.Message)
        }
      }
      continue
    }
    if ($decision -eq 'kept') {
      Say ((T 'restore.linkKept' '  [ok] {0}: kept the link (its target is there)') -f $name) 'Green'
      continue
    }
    if ($decision -eq 'target-missing') {
      Say ((T 'restore.linkTargetMissing' '  [bad] {0}: the link target is gone and the snapshot holds no copy of it') -f $name) 'Red'
      $evidence.Add($name + ': target missing and no copy in the snapshot (' + $target + ')')
      continue
    }
    Say ((T 'restore.linkNoBackup' '  [warn] {0}: the snapshot holds no copy of this plugin; the link is left as it is') -f $name) 'Yellow'
  }

  if ((-not $DryRun) -and ($evidence.Count -gt 0)) {
    $evidenceDir = $ProfileDir
    if ($BrokenDir -ne '' -and (Test-Path -LiteralPath $BrokenDir -PathType Container)) { $evidenceDir = $BrokenDir }
    try {
      $evidenceFile = Join-Path $evidenceDir 'links-restore.txt'
      [System.IO.File]::WriteAllText($evidenceFile, (($evidence -join [Environment]::NewLine) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
      Say ((T 'restore.linkEvidence' '  (the link decisions are written down in {0})') -f $evidenceFile) 'Gray'
    } catch {
      Say (T 'restore.linkEvidenceFailed' '  [warn] the link decisions could not be written down.') 'Yellow'
    }
  }
}

# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

# An absolute path without the trailing separator ("C:\" keeps it).
function Resolve-FullPath {
  param([string] $Path)
  if ($null -eq $Path) { return '' }
  $trimmed = ([string]$Path).Trim()
  if ($trimmed -eq '') { return '' }
  try {
    $full = [System.IO.Path]::GetFullPath($trimmed)
  } catch {
    return ''
  }
  if ($full.Length -gt 3) { $full = $full.TrimEnd([char[]] @('\', '/')) }
  return $full
}

# Are two paths the same one? Windows does not care about the case.
function Test-SamePath {
  param([string] $A, [string] $B)
  return (Resolve-FullPath $A).ToLowerInvariant() -eq (Resolve-FullPath $B).ToLowerInvariant()
}

# Is $Child inside $Parent (not counting $Parent itself)?
function Test-IsInside {
  param([string] $Child, [string] $Parent)
  $child = (Resolve-FullPath $Child).ToLowerInvariant()
  $parent = (Resolve-FullPath $Parent).ToLowerInvariant()
  if ($child -eq '' -or $parent -eq '') { return $false }
  if ($child -eq $parent) { return $false }
  if (-not $parent.EndsWith('\')) { $parent = $parent + '\' }
  return $child.StartsWith($parent)
}

# The system directories: the environment first, the system drive as fallback.
function Get-SystemDirectories {
  $list = New-Object System.Collections.Generic.List[string]
  $add = {
    param([string] $Value)
    if ($null -eq $Value) { return }
    $trimmed = ([string]$Value).Trim().TrimEnd([char[]] @('\', '/'))
    if ($trimmed -eq '') { return }
    if (-not $list.Contains($trimmed)) { $list.Add($trimmed) }
  }
  & $add $env:SystemRoot
  & $add $env:windir
  & $add $env:ProgramFiles
  & $add ${env:ProgramFiles(x86)}
  & $add $env:ProgramData
  $drive = 'C:'
  if (-not [string]::IsNullOrWhiteSpace($env:SystemDrive)) { $drive = $env:SystemDrive.Trim() }
  & $add ($drive + '\Windows')
  & $add ($drive + '\Program Files')
  & $add ($drive + '\Program Files (x86)')
  & $add ($drive + '\ProgramData')
  & $add ($drive + '\$Recycle.Bin')
  & $add ($drive + '\System Volume Information')
  return $list
}

# Why may this path not be touched? An empty string means: it may.
function Get-ForbiddenReason {
  param([string] $Target, [string] $HomeDir)
  $dir = Resolve-FullPath $Target
  if ($dir -eq '') { return (T 'restore.gateEmptyPath' 'the target path is empty') }
  if ($dir -match '^[A-Za-z]:[\\/]?$') { return (T 'restore.gateDriveRoot' 'refusing to touch a drive root') }
  $fsRoot = [System.IO.Path]::GetPathRoot($dir)
  if ($fsRoot -ne '' -and $dir.ToLowerInvariant() -eq $fsRoot.ToLowerInvariant()) { return (T 'restore.gateFsRoot' 'refusing to touch a filesystem root') }
  # Not $home: that one is a read-only automatic variable in PowerShell.
  $homePath = Resolve-FullPath $HomeDir
  if ($homePath -ne '' -and (Test-SamePath $dir $homePath)) { return (T 'restore.gateHome' 'refusing to touch the home directory itself') }
  foreach ($system in Get-SystemDirectories) {
    if ((Test-SamePath $dir $system) -or (Test-IsInside $dir $system)) {
      return ((T 'restore.gateSystemDir' 'refusing to touch the system directory: {0}') -f $system)
    }
  }
  # Somebody else's user directory: <Users>\<somebody else>.
  if ($homePath -ne '') {
    $usersRoot = Resolve-FullPath (Join-Path ([System.IO.Path]::GetPathRoot($homePath)) 'Users')
    if ($usersRoot -ne '' -and (Test-IsInside $dir $usersRoot)) {
      if ((Resolve-FullPath (Split-Path -Parent $dir)).ToLowerInvariant() -eq $usersRoot.ToLowerInvariant()) {
        return (T 'restore.gateOtherUser' "refusing to touch another user's profile")
      }
    }
  }
  return ''
}

# ---------------------------------------------------------------------------
# Directories: DSH home / profiles / state / backups
# ---------------------------------------------------------------------------

function Get-DshHome {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    return (Resolve-FullPath $env:DSH_HOME)
  }
  return (Resolve-FullPath (Join-Path $env:USERPROFILE '.dsh'))
}

function Get-ProfilesRoot {
  return (Resolve-FullPath (Join-Path (Get-DshHome) 'profiles'))
}

# The snapshot directory.
function Get-BackupsRoot {
  param([string] $State)
  if ($State -ne '') {
    return (Resolve-FullPath (Join-Path (Resolve-FullPath $State) 'backups'))
  }
  return (Resolve-FullPath (Join-Path (Join-Path (Get-DshHome) 'storages\dsh-autorestart') 'backups'))
}

# Without -ProfileDir: where is the desktop profile?
function Get-DefaultProfileDir {
  # 1) The environment variable the host exports.
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_PROFILE_DIR)) {
    $explicit = Resolve-FullPath $env:DSH_PROFILE_DIR
    if ($explicit -ne '' -and (Test-Path -LiteralPath $explicit -PathType Container)) { return $explicit }
  }
  # 2) The only profile that has this plugin in it - that is the one.
  $root = Get-ProfilesRoot
  if (Test-Path -LiteralPath $root -PathType Container) {
    $matches = New-Object System.Collections.Generic.List[string]
    foreach ($entry in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $pkg = Join-Path $entry.FullName 'package.json'
      if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { continue }
      try {
        $document = ([System.IO.File]::ReadAllText($pkg)) | ConvertFrom-Json
      } catch {
        continue
      }
      if ($null -eq $document -or $null -eq $document.dsh -or $null -eq $document.dsh.profile) { continue }
      $bundles = @()
      if ($null -ne $document.dsh.profile.bundles) { $bundles = @($document.dsh.profile.bundles) }
      if ($bundles -contains $PackageName) { $matches.Add($entry.FullName) }
    }
    if ($matches.Count -eq 1) { return $matches[0] }
  }
  # 3) The profile name the host asked for.
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_PROFILE)) {
    return (Resolve-FullPath (Join-Path $root $env:DSH_PROFILE.Trim()))
  }
  # 4) The default name on the desktop.
  return (Resolve-FullPath (Join-Path $root 'desktop'))
}

# ---------------------------------------------------------------------------
# The profile fingerprint: does this directory still look like a DSH profile?
# ---------------------------------------------------------------------------

function Get-ProfileFingerprint {
  param([string] $Dir)
  $base = Resolve-FullPath $Dir
  $markers = New-Object System.Collections.Generic.List[string]
  $pkgPath = Join-Path $base 'package.json'
  $hasPackageJson = Test-Path -LiteralPath $pkgPath -PathType Leaf
  if ($hasPackageJson) { $markers.Add('package.json') }
  if (Test-Path -LiteralPath (Join-Path $base 'cordis.patch.yml') -PathType Leaf) { $markers.Add('cordis.patch.yml') }
  if (Test-Path -LiteralPath (Join-Path $base 'node_modules') -PathType Container) { $markers.Add('node_modules') }

  $kind = 'not-a-profile'
  $reason = (T 'restore.fingerprintNotProfile' 'there is no package.json here - this does not look like a DSH profile')
  if ($hasPackageJson) {
    $parsed = $null
    try {
      $parsed = ([System.IO.File]::ReadAllText($pkgPath)) | ConvertFrom-Json
    } catch {
      $parsed = $null
    }
    if ($null -ne $parsed -and $null -ne $parsed.dsh -and $null -ne $parsed.dsh.profile) {
      $kind = 'profile'
      $reason = (T 'restore.fingerprintProfile' 'the profile package.json carries a dsh.profile section')
    } elseif ($markers.Count -ge 2) {
      $kind = 'broken-profile'
      $reason = (T 'restore.fingerprintBrokenNoDsh' 'the profile is broken (its package.json does not identify a profile), but the profile files are still there')
    } else {
      $reason = (T 'restore.fingerprintNotDshProfile' 'the package.json does not carry a dsh.profile section, and nothing else marks this as a profile')
    }
  } elseif ($markers.Count -gt 0) {
    $kind = 'broken-profile'
    $reason = (T 'restore.fingerprintBrokenNoPkg' 'the profile is broken (its package.json is missing), but the profile files are still there')
  }
  return [pscustomobject]@{ Dir = $base; Kind = $kind; Reason = $reason; Markers = @($markers) }
}

# ---------------------------------------------------------------------------
# The snapshot: the newest one that carries a manifest
# ---------------------------------------------------------------------------

function Read-SnapshotManifest {
  param([string] $Dir)
  $manifestPath = Join-Path (Resolve-FullPath $Dir) 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  try {
    $text = [System.IO.File]::ReadAllText($manifestPath)
    if ($text.Length -gt 0 -and [int] $text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
    $parsed = $text | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($null -eq $parsed) { return $null }
  return $parsed
}

function Select-Snapshot {
  param([string] $BackupsDir)
  $root = Resolve-FullPath $BackupsDir
  $result = [pscustomobject]@{ Ok = $false; Dir = ''; Name = ''; Manifest = $null; Candidates = @(); Error = '' }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    $result.Error = ((T 'restore.snapshotDirMissing' 'the snapshot directory cannot be found: {0}') -f $root)
    return $result
  }
  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($entry in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
    $manifest = Read-SnapshotManifest $entry.FullName
    if ($null -eq $manifest) { continue }
    $at = $null
    if ($null -ne $manifest.at) {
      try { $at = [int64] $manifest.at } catch { $at = $null }
    }
    $candidates.Add([pscustomobject]@{ Name = $entry.Name; Dir = $entry.FullName; Manifest = $manifest; At = $at })
  }
  $result.Candidates = @($candidates | ForEach-Object { $_.Name })
  if ($candidates.Count -eq 0) {
    $result.Error = ((T 'restore.snapshotNone' 'there is no snapshot with a manifest under {0}') -f $root)
    return $result
  }
  $sorted = @($candidates | Sort-Object -Property `
    @{ Expression = { if ($null -eq $_.At) { [int64] 0 } else { $_.At } }; Descending = $true }, `
    @{ Expression = { $_.Name }; Descending = $true })
  $best = $sorted[0]
  $result.Ok = $true
  $result.Dir = $best.Dir
  $result.Name = $best.Name
  $result.Manifest = $best.Manifest
  return $result
}

# Does this snapshot hold a real DSH profile? (It has to: we write it into a
# profile directory.)
function Test-SnapshotProfile {
  param([string] $SnapshotDir)
  $pkgPath = Join-Path (Join-Path (Resolve-FullPath $SnapshotDir) 'config') 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) {
    return [pscustomobject]@{ Ok = $false; Reason = (T 'restore.snapshotNoConfigPkg' 'this snapshot has no config\package.json') }
  }
  $parsed = $null
  try {
    $parsed = ([System.IO.File]::ReadAllText($pkgPath)) | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{ Ok = $false; Reason = (T 'restore.snapshotBadConfigPkg' 'the package.json of this snapshot is not valid JSON') }
  }
  if ($null -eq $parsed -or $null -eq $parsed.dsh -or $null -eq $parsed.dsh.profile) {
    return [pscustomobject]@{ Ok = $false; Reason = (T 'restore.snapshotNoDshProfile' 'the package.json of this snapshot has no dsh.profile section') }
  }
  return [pscustomobject]@{ Ok = $true; Reason = (T 'restore.snapshotIsProfile' 'this snapshot holds a DSH profile') }
}

# The time the snapshot says it was taken (in words).
function Get-SnapshotDisplay {
  param($Manifest)
  $display = (T 'restore.snapshotUnknownTime' 'an unknown time')
  $includePlugins = $false
  if ($null -ne $Manifest) {
    if ($null -ne $Manifest.atLocal -and ([string] $Manifest.atLocal).Trim() -ne '') {
      $display = (([string] $Manifest.atLocal).Trim() -replace 'T', ' ').Substring(0, 16)
    } elseif ($null -ne $Manifest.at) {
      try { $display = (Get-Date -Date ([DateTimeOffset]::FromUnixTimeMilliseconds([int64] $Manifest.at).LocalDateTime) -Format 'yyyy-MM-dd HH:mm') } catch { $display = (T 'restore.snapshotUnknownTime' 'an unknown time') }
    }
    $includePlugins = ($Manifest.includePlugins -eq $true)
  }
  return [pscustomobject]@{ Display = $display; IncludePlugins = $includePlugins }
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

if ($script:StringsError -ne '') {
  Write-Host ('WARNING: ' + $script:StringsError) -ForegroundColor Yellow
}

Say (T 'restore.title' 'dsh-autorestart - profile snapshot restorer') 'Cyan'

$explicitProfile = ($ProfileDir -as [string]) -ne ''
if ($explicitProfile) {
  $targetProfile = Resolve-FullPath $ProfileDir
} else {
  $targetProfile = Get-DefaultProfileDir
}
if ($targetProfile -eq '') { Fail (T 'restore.noProfileDir' 'the profile directory to restore into cannot be found (use -ProfileDir to say which one).') }

# --- Gate 1: is the path itself safe? ---
$forbidden = Get-ForbiddenReason $targetProfile $env:USERPROFILE
if ($forbidden -ne '') { Fail ($forbidden + ((T 'restore.targetSuffix' '(target: {0})') -f $targetProfile)) }

if (-not $explicitProfile) {
  $profilesRoot = Get-ProfilesRoot
  if (-not (Test-IsInside $targetProfile $profilesRoot)) {
    Fail ((T 'restore.onlyProfiles' 'only a profile under {0} may be restored (target: {1})') -f $profilesRoot, $targetProfile)
  }
}
Say ((T 'restore.target' 'target profile: {0}') -f $targetProfile)

# --- Gate 2: the target profile directory has to exist ---
# Restoring means putting a snapshot back into a profile that is ALREADY there,
# not inventing one. The script never creates a profiles directory: that would
# only turn a mistyped target into an empty shell profile.
if (-not (Test-Path -LiteralPath $targetProfile -PathType Container)) {
  Fail ((T 'restore.missingDir' 'the target profile directory does not exist: {0} (the restore needs that directory to be there; the script does not create a profile directory for it)') -f $targetProfile)
}

# --- Gate 3: does this directory still look like a DSH profile? ---
$fingerprint = Get-ProfileFingerprint $targetProfile
if ($fingerprint.Kind -eq 'not-a-profile') {
  Fail ($fingerprint.Reason + ((T 'restore.targetSuffix' '(target: {0})') -f $targetProfile) + (T 'restore.notProfileSuffix' '. Refusing to act - a directory that is not a profile must not be damaged.'))
}
if ($fingerprint.Kind -eq 'broken-profile') {
  Say ((T 'restore.brokenNotice' 'this profile is already broken: {0}') -f $fingerprint.Reason) 'Yellow'
}

# --- Find the snapshot ---
if (($Snapshot -as [string]) -ne '') {
  $snapshotDir = Resolve-FullPath $Snapshot
  if (-not (Test-Path -LiteralPath $snapshotDir -PathType Container)) {
    Fail ((T 'restore.snapshotMissing' 'this snapshot cannot be found: {0}') -f $snapshotDir)
  }
  $manifest = Read-SnapshotManifest $snapshotDir
  if ($null -eq $manifest) { Fail ((T 'restore.snapshotNoManifest' 'this snapshot has no manifest.json, so it is not a snapshot: {0}') -f $snapshotDir) }
  $selected = [pscustomobject]@{ Ok = $true; Dir = $snapshotDir; Name = (Split-Path -Leaf $snapshotDir); Manifest = $manifest }
} else {
  $backupsRoot = Get-BackupsRoot $StateDir
  Say ((T 'restore.backupsDir' 'snapshot directory: {0}') -f $backupsRoot)
  $selected = Select-Snapshot $backupsRoot
  if (-not $selected.Ok) { Fail $selected.Error }
  $snapshotDir = $selected.Dir
}
$manifest = $selected.Manifest

# --- Gate 4: does the snapshot hold a real profile? ---
$snapshotProfile = Test-SnapshotProfile $snapshotDir
if (-not $snapshotProfile.Ok) { Fail ($snapshotProfile.Reason + ((T 'restore.snapshotSuffix' '(snapshot: {0})') -f $snapshotDir)) }

$described = Get-SnapshotDisplay $manifest
Say ((T 'restore.usingSnapshot' 'snapshot to use: {0} ({1})') -f $selected.Name, $described.Display)

# --- Work out the name of the evidence directory for the old profile ---
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:BrokenDir = $targetProfile + '.broken-' + $stamp
$counter = 2
while (Test-Path -LiteralPath $script:BrokenDir) {
  $script:BrokenDir = $targetProfile + '.broken-' + $stamp + '-' + $counter
  $counter += 1
}

# --- Dry run ---
if ($DryRun) {
  Say ((T 'restore.dryRunMove' '[dry run] the current profile would be moved to: {0}') -f $script:BrokenDir) 'Cyan'
  Say ((T 'restore.dryRunCopy' '[dry run] the configuration and the plugins of {0} would be copied back to: {1}') -f $selected.Name, $targetProfile) 'Cyan'
  # The link decisions are part of "what would happen": a rehearsal that says
  # nothing about them would hide the one thing this version added.
  Invoke-LinkPlugins -SnapshotDir $snapshotDir -ProfileDir $targetProfile -BrokenDir '' -Forced:$ForceLinkPlugins.IsPresent -DryRun:$true
  Say ((T 'restore.dryRunVerify' '[dry run] package.json / dsh.profile.bundles / the version of {0} would be read back.') -f $PackageName) 'Cyan'
  Say (T 'restore.dryRunNoChange' '[dry run] no file was changed.') 'Cyan'
  exit 0
}

# --- Move the current profile away (never overwrites, never deletes) ---
if (Test-Path -LiteralPath $targetProfile) {
  try {
    Move-Item -LiteralPath $targetProfile -Destination $script:BrokenDir -ErrorAction Stop
  } catch {
    Fail ((T 'restore.moveFailed' 'moving the current profile away failed (nothing was changed): {0}') -f $_.Exception.Message)
  }
  Say ((T 'restore.moved' 'the old one has been moved to: {0}') -f $script:BrokenDir) 'Gray'
} else {
  Say (T 'restore.noProfileBefore' 'the profile directory was not there, it is created.') 'Gray'
}

# --- Copy it back ---
try {
  New-Item -ItemType Directory -Path $targetProfile -Force | Out-Null
  $configDir = Join-Path $snapshotDir 'config'
  if (Test-Path -LiteralPath $configDir -PathType Container) {
    foreach ($item in (Get-ChildItem -LiteralPath $configDir -Force)) {
      Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $targetProfile $item.Name) -Recurse -Force -ErrorAction Stop
    }
  }
  $pluginsDir = Join-Path $snapshotDir 'node_modules'
  if (Test-Path -LiteralPath $pluginsDir -PathType Container) {
    Copy-Item -LiteralPath $pluginsDir -Destination (Join-Path $targetProfile 'node_modules') -Recurse -Force -ErrorAction Stop
  }
} catch {
  Fail ((T 'restore.copyFailed' 'copying the snapshot back failed (the old one is still at {0}): {1}') -f $script:BrokenDir, $_.Exception.Message)
}

# --- THE LINKED PLUGINS: keep a working link, replace a broken one ----------
# This runs AFTER the tree copy (which put the links back) and BEFORE the check:
# a linked plugin whose target is gone has to be replaced, or the host cannot
# start - and dsh-autorestart itself is installed that way.
Invoke-LinkPlugins -SnapshotDir $snapshotDir -ProfileDir $targetProfile -BrokenDir $script:BrokenDir -Forced:$ForceLinkPlugins.IsPresent -DryRun:$false

# --- Read the result back ---
$checks = New-Object System.Collections.Generic.List[object]

$pkgPath = Join-Path $targetProfile 'package.json'
$parsed = $null
if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) {
  $checks.Add([pscustomobject]@{ Label = (T 'restore.verifyPkgLabel' 'package.json can be parsed'); Status = 'failed'; Detail = (T 'restore.verifyPkgMissing' 'package.json is missing') })
} else {
  try {
    $parsed = ([System.IO.File]::ReadAllText($pkgPath)) | ConvertFrom-Json
    $checks.Add([pscustomobject]@{ Label = (T 'restore.verifyPkgLabel' 'package.json can be parsed'); Status = 'passed'; Detail = '' })
  } catch {
    $checks.Add([pscustomobject]@{ Label = (T 'restore.verifyPkgLabel' 'package.json can be parsed'); Status = 'failed'; Detail = (T 'restore.verifyPkgBad' 'not valid JSON') })
  }
}

$bundles = $null
if ($null -ne $parsed -and $null -ne $parsed.dsh -and $null -ne $parsed.dsh.profile -and $null -ne $parsed.dsh.profile.bundles) {
  $bundles = @($parsed.dsh.profile.bundles)
}
if ($null -ne $bundles -and $bundles.Count -gt 0) {
  $checks.Add([pscustomobject]@{ Label = (T 'restore.verifyBundlesLabel' 'dsh.profile.bundles has content'); Status = 'passed'; Detail = ((T 'restore.verifyBundlesCount' '{0} in total') -f $bundles.Count) })
} else {
  $checks.Add([pscustomobject]@{ Label = (T 'restore.verifyBundlesLabel' 'dsh.profile.bundles has content'); Status = 'failed'; Detail = (T 'restore.verifyBundlesEmpty' 'there is no dsh.profile.bundles, or it is empty') })
}

# The plugin version: only when the profile says it wants the plugin.
# It says it, but node_modules does not have it - that is a really broken
# profile ("the configuration says one thing, the disk another") and it has to
# fail.
$declaresPlugin = ($null -ne $bundles -and ($bundles -contains $PackageName))
$pluginPkgPath = Join-Path $targetProfile ('node_modules\' + $PackageName + '\package.json')
$pluginLabel = ((T 'restore.verifyPluginLabel' 'the version of {0} can be read') -f $PackageName)
if (-not $declaresPlugin) {
  $checks.Add([pscustomobject]@{ Label = $pluginLabel; Status = 'skipped'; Detail = ((T 'restore.verifyPluginNotDeclared' 'this profile does not list {0} (there is nothing to read)') -f $PackageName) })
} elseif (-not (Test-Path -LiteralPath $pluginPkgPath -PathType Leaf)) {
  $checks.Add([pscustomobject]@{ Label = $pluginLabel; Status = 'failed'; Detail = ((T 'restore.verifyPluginMissing' 'the profile lists {0}, but node_modules\{0} is not there - the configuration says one thing and the disk another') -f $PackageName, $PackageName) })
} else {
  $version = ''
  try {
    $pluginPkg = ([System.IO.File]::ReadAllText($pluginPkgPath)) | ConvertFrom-Json
    if ($null -ne $pluginPkg -and $null -ne $pluginPkg.version) { $version = ([string] $pluginPkg.version).Trim() }
  } catch {
    $version = ''
  }
  if ($version -ne '') {
    $checks.Add([pscustomobject]@{ Label = $pluginLabel; Status = 'passed'; Detail = $version })
  } else {
    $checks.Add([pscustomobject]@{ Label = $pluginLabel; Status = 'failed'; Detail = (T 'restore.verifyPluginNoVersion' 'the version number cannot be read') })
  }
}

foreach ($check in $checks) {
  if ($check.Status -eq 'passed') { Say ((T 'restore.checkOk' '  [ok] {0} - {1}') -f $check.Label, $check.Detail) 'Green' }
  elseif ($check.Status -eq 'skipped') { Say ((T 'restore.checkSkipped' '  [skipped] {0} - {1}') -f $check.Label, $check.Detail) 'Yellow' }
  else { Say ((T 'restore.checkBad' '  [bad] {0} - {1}') -f $check.Label, $check.Detail) 'Red' }
}

$failed = @($checks | Where-Object { $_.Status -eq 'failed' })
if ($failed.Count -gt 0) {
  Fail ((T 'restore.verifyFailed' 'the restored profile did not pass the check ({0}).') -f (($failed | ForEach-Object { $_.Label }) -join ', '))
}

# --- One sentence a human can act on ---
$pluginNote = (T 'restore.noteWithPlugins' '(with the plugins)')
if (-not $described.IncludePlugins) { $pluginNote = (T 'restore.noteNoPlugins' '(configuration files only, no plugins)') }
Say ((T 'restore.done' 'restored to the snapshot of {0}{1}; you can open DSH again now.') -f $described.Display, $pluginNote) 'Green'
Say ((T 'restore.brokenLeft' 'the old one was left at: {0} (delete it yourself once you are sure)') -f $script:BrokenDir) 'Gray'
exit 0
