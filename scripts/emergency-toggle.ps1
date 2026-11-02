<#
.SYNOPSIS
  The dsh-autorestart emergency switch: take this plugin out (or put it back)
  when DSH does not come up.

.DESCRIPTION
  "I enabled the plugin and DSH does not start any more" is the hardest moment
  for a plugin: fixing it needs the plugin itself. This script touches ONE
  file - the package.json of the desktop profile - and ONE array in it:
  `dsh.profile.bundles`.

    - disable: take "dsh-autorestart" out of the bundles (it was not there
      anyway -> report "already disabled", that is not a failure);
    - enable : put "dsh-autorestart" back into the bundles (it was already
      there -> report "already enabled");
    - status : read only, prints whether it is in the bundles right now.

  Two hard rules:

    1. the file is backed up as `package.json.bak-emergency-<yyyyMMdd-HHmmss>`
       before anything is written;
    2. after writing, the JSON is parsed again and checked; if the check
       fails, the backup is put back and the failure is reported honestly.

  The indentation, the line endings and the trailing newline of the file are
  kept as they are (the text is edited, the JSON is not re-serialized).

  LANGUAGE: this file is pure ASCII on purpose. Windows PowerShell 5.1 reads a
  UTF-8 file without a byte order mark as ANSI, so one Chinese character
  inside the script turns into mojibake and the script dies with a ParserError
  before it does anything. The Chinese wording lives in
  scripts\rescue-strings.zh.json (UTF-8, no BOM) and is read at runtime; if
  that file is missing or broken, every message falls back to English and the
  script says so.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\emergency-toggle.ps1 -Action status

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\emergency-toggle.ps1 -Action disable

.NOTES
  Windows PowerShell 5.1 is enough (nothing from 6.0+ is used); the .cmd entry
  point double-clicked by the user is that one too.
#>
[CmdletBinding()]
param(
  # What to do.
  [ValidateSet('disable', 'enable', 'status')]
  [string] $Action = 'status',

  # Only print what would be written, change nothing.
  [switch] $DryRun,

  # The package.json to work on (for tests and for other profiles).
  [string] $PackageJson = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json')
)

$ErrorActionPreference = 'Stop'

# The name of this plugin inside the bundles.
$PackageName = 'dsh-autorestart'

# The anchor it is put back after (the position does not matter, but an anchor
# is steadier than the end of the array).
$AnchorName = 'dsh-github-guard'

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

function Say {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Fail {
  param([string] $Text)
  Write-Host ((T 'emergency.failed' 'the emergency switch failed: {0}') -f $Text) -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# Text helpers: only the bundles array is touched, every other byte stays.
# ---------------------------------------------------------------------------

# The square brackets of the bundles array.
function Get-ArrayRange {
  param([string] $Text)
  $marker = '"bundles"'
  $markerIndex = $Text.IndexOf($marker)
  if ($markerIndex -lt 0) { throw 'package.json has no bundles entry' }
  $open = $Text.IndexOf('[', $markerIndex)
  if ($open -lt 0) { throw 'bundles is not an array' }
  $depth = 0
  $inString = $false
  $escaped = $false
  for ($i = $open; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    if ($inString) {
      if ($escaped) { $escaped = $false; continue }
      if ($c -eq '\') { $escaped = $true; continue }
      if ($c -eq '"') { $inString = $false }
      continue
    }
    if ($c -eq '"') { $inString = $true; continue }
    if ($c -eq '[') { $depth++; continue }
    if ($c -eq ']') {
      $depth--
      if ($depth -eq 0) { return @($open, $i) }
    }
  }
  throw 'the bundles array is not closed'
}

# The names of the bundles array, IN ORDER, whatever the layout is.
#
# Only the body of the array is scanned: Get-ArrayRange has already located it,
# so a name can never be picked up from another part of the file. A
# pretty-printed file (one item per line) and a MINIFIED one (["a","b"]) are
# read the same way: the old line-based reader returned ZERO items for a
# minified array, so "disable" answered "not in the bundles" and changed
# nothing.
function Get-BundleNames {
  param([string] $Text, [int] $Open, [int] $Close)
  $body = $Text.Substring($Open + 1, $Close - $Open - 1)
  $names = @()
  foreach ($match in [regex]::Matches($body, '"(?<name>(?:[^"\\]|\\.)*)"')) {
    $names += $match.Groups['name'].Value
  }
  return $names
}

# How the array is laid out today, so the rewritten array looks like the old one.
function Get-BundlesLayout {
  param([string] $Text, [int] $Open, [int] $Close)
  $body = $Text.Substring($Open + 1, $Close - $Open - 1)
  $multiLine = $body.Contains("`n")
  $indent = ''
  $closeIndent = ''
  if ($multiLine) {
    $firstItem = [regex]::Match($body, '(?m)^(?<indent>[ \t]*)"')
    if ($firstItem.Success) { $indent = $firstItem.Groups['indent'].Value }
    else { $indent = (Get-LineIndent $Text $Close) + '  ' }
    $closeIndent = Get-LineIndent $Text $Close
  }
  return [pscustomobject]@{
    MultiLine   = $multiLine
    Indent      = $indent
    CloseIndent = $closeIndent
    Eol         = (Get-LineEnding $Text)
  }
}

# The body of a bundles array for these names (the brackets stay where they are).
#
# THIS is what makes the comma impossible to get wrong: it is written BETWEEN
# two items by the serializer, never by hand at a guessed offset. A one-item
# array gets no comma at all, and no comma can land inside a name.
#
# A compact array stays compact (["a","b"]); a pretty-printed one stays one item
# per line with the indentation the file already used.
function Format-BundlesBody {
  param([string[]] $Names, [object] $Layout)
  $quoted = @()
  foreach ($name in $Names) {
    $escaped = $name -replace '\\', '\\'
    $escaped = $escaped -replace '"', '\"'
    $quoted += '"' + $escaped + '"'
  }
  if (-not $Layout.MultiLine) { return ($quoted -join ',') }
  if ($quoted.Count -eq 0) { return ($Layout.Eol + $Layout.CloseIndent) }
  $body = $Layout.Eol + $Layout.Indent + ($quoted -join (',' + $Layout.Eol + $Layout.Indent))
  return ($body + $Layout.Eol + $Layout.CloseIndent)
}

# The indentation of a line (so a new line can look the same).
function Get-LineIndent {
  param([string] $Text, [int] $Index)
  $start = $Text.LastIndexOf("`n", [Math]::Max(0, $Index - 1))
  if ($start -lt 0) { $start = 0 } else { $start++ }
  $indent = ''
  for ($i = $start; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    if ($c -eq ' ' -or $c -eq "`t") { $indent += $c; continue }
    break
  }
  return $indent
}

# The line ending the file uses.
function Get-LineEnding {
  param([string] $Text)
  if ($Text.Contains("`r`n")) { return "`r`n" }
  return "`n"
}

# ---------------------------------------------------------------------------
# Start.
# ---------------------------------------------------------------------------

if ($script:StringsError -ne '') {
  Write-Host ('WARNING: ' + $script:StringsError) -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) {
  Fail ((T 'emergency.notFound' 'the package.json of the profile cannot be found: {0}') -f $PackageJson)
}

$path = (Resolve-Path -LiteralPath $PackageJson).Path
$bytes = [System.IO.File]::ReadAllBytes($path)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$raw = [System.IO.File]::ReadAllText($path)

try {
  $document = $raw | ConvertFrom-Json
} catch {
  Fail ((T 'emergency.badJson' 'this package.json is not valid JSON: {0}') -f $_.Exception.Message)
}

$bundles = @()
$hasBundles = $false
if ($null -ne $document -and $null -ne $document.dsh -and $null -ne $document.dsh.profile -and $null -ne $document.dsh.profile.bundles) {
  $bundles = @($document.dsh.profile.bundles)
  $hasBundles = $true
}

$present = ($bundles -contains $PackageName)

Say ((T 'emergency.file' 'file: {0}') -f $path)

if ($Action -eq 'status') {
  if ($present) { Say ((T 'emergency.enabled' 'enabled: {0} is in the bundles.') -f $PackageName) 'Green' }
  else { Say ((T 'emergency.disabled' 'disabled: {0} is not in the bundles.') -f $PackageName) 'Yellow' }
  exit 0
}

if ($Action -eq 'enable' -and -not $hasBundles) {
  Fail (T 'emergency.noBundles' 'this profile has no dsh.profile.bundles list, so the plugin cannot be put back (please add a line "dsh-autorestart" by hand).')
}

# ---------------------------------------------------------------------------
# Work out the new text.
# ---------------------------------------------------------------------------

$new = $raw
$range = Get-ArrayRange $raw
$names = @(Get-BundleNames $raw $range[0] $range[1])
$layout = Get-BundlesLayout $raw $range[0] $range[1]

if ($Action -eq 'disable') {
  if (-not $present) {
    Say ((T 'emergency.alreadyDisabled' 'already disabled: {0} was not in the bundles anyway (no file was changed).') -f $PackageName) 'Yellow'
    exit 0
  }
  $kept = @()
  foreach ($name in $names) { if ($name -ne $PackageName) { $kept += $name } }
  $body = Format-BundlesBody $kept $layout
  $new = $raw.Substring(0, $range[0] + 1) + $body + $raw.Substring($range[1])
  $summary = (T 'emergency.summaryRemove' 'take {0} out of the bundles') -f $PackageName
} else {
  # enable
  if ($present) {
    Say ((T 'emergency.alreadyEnabled' 'already enabled: {0} was in the bundles anyway (no file was changed).') -f $PackageName) 'Yellow'
    exit 0
  }
  # Put it back right after the anchor when the anchor is there, otherwise at
  # the end: the position does not matter, the JSON does.
  $kept = @()
  $inserted = $false
  foreach ($name in $names) {
    $kept += $name
    if (-not $inserted -and $name -eq $AnchorName) {
      $kept += $PackageName
      $inserted = $true
    }
  }
  if (-not $inserted) { $kept += $PackageName }
  $body = Format-BundlesBody $kept $layout
  $new = $raw.Substring(0, $range[0] + 1) + $body + $raw.Substring($range[1])
  $summary = (T 'emergency.summaryAdd' 'put {0} back into the bundles') -f $PackageName
}

if ($DryRun) {
  Say ((T 'emergency.dryRunWill' '[dry run] would {0}.') -f $summary) 'Cyan'
  Say ((T 'emergency.dryRunWrite' '[dry run] would write: {0}') -f $path) 'Cyan'
  Say ((T 'emergency.dryRunBackup' '[dry run] would back it up as: {0}.bak-emergency-<timestamp>') -f $path) 'Cyan'
  Say (T 'emergency.dryRunNoChange' '[dry run] no file was changed.') 'Cyan'
  exit 0
}

# ---------------------------------------------------------------------------
# Write: back up first, write, then parse and check again; on a failure, roll
# back.
# ---------------------------------------------------------------------------

$backup = $path + '.bak-emergency-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
try {
  Copy-Item -LiteralPath $path -Destination $backup -Force
} catch {
  Fail ((T 'emergency.backupFailed' 'the backup failed (the original file was not touched): {0}') -f $_.Exception.Message)
}

try {
  $encoding = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($path, $new, $encoding)
} catch {
  Fail ((T 'emergency.writeFailed' 'the write failed (the backup is at {0}): {1}') -f $backup, $_.Exception.Message)
}

try {
  $written = [System.IO.File]::ReadAllText($path)
  $parsed = $written | ConvertFrom-Json
  $names = @()
  if ($null -ne $parsed -and $null -ne $parsed.dsh -and $null -ne $parsed.dsh.profile -and $null -ne $parsed.dsh.profile.bundles) {
    $names = @($parsed.dsh.profile.bundles)
  }
  if ($Action -eq 'enable' -and -not ($names -contains $PackageName)) {
    throw ('after writing, the bundles still do not hold ' + $PackageName)
  }
  if ($Action -eq 'disable' -and ($names -contains $PackageName)) {
    throw ('after writing, the bundles still hold ' + $PackageName)
  }
} catch {
  # The check failed: put the original file back, then report honestly.
  try {
    Copy-Item -LiteralPath $backup -Destination $path -Force
    Say ((T 'emergency.rolledBack' 'the backup was put back: {0}') -f $backup) 'Yellow'
  } catch {
    Fail ((T 'emergency.verifyFailedNoRollback' 'the check failed and the rollback failed too (the backup is at {0}): {1}') -f $backup, $_.Exception.Message)
  }
  Fail ((T 'emergency.verifyFailedRolledBack' 'the check failed (it was rolled back): {0}') -f $_.Exception.Message)
}

Say ((T 'emergency.done' 'done: {0}.') -f $summary) 'Green'
Say ((T 'emergency.backup' 'backup: {0}') -f $backup) 'Gray'
Say (T 'emergency.restartHint' 'restart DSH for it to take effect.') 'Gray'
exit 0
