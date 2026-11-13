#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Guard the LIVE dsh profile config against the upstream test suite.

.DESCRIPTION
    INCIDENT 2026-11-13 03:02:12. Running the upstream test suite in
    `autorestart-upstream` overwrote the REAL profile config:

        C:\Users\i\.dsh-workbuddy\profiles\web\cordis.patch.yml
        72814 bytes  ->  27 bytes  ("rows:\n  - id: two-days-ago\n")

    `test/restart-safety.test.mjs` contains a rollback case whose FIXTURE content
    is exactly `rows:\n  - id: two-days-ago\n` (line 981, asserted at line 1001).
    The fixture points `DSH_PROFILE_DIR` at a temp directory, but:

      - `fixture()` writes the temp path into `process.env.DSH_PROFILE_DIR` and
        restores the PREVIOUS value afterwards, and
      - `resolveProfileDirDetailed()` (index.js:2001) resolves the profile from
        `DSH_PROFILE_DIR` -> `DSH_HOME`+`DSH_PROFILE` -> `--profile` -> a scan,
        and it also reads a memo file `<state>/profile-dir.json`.

    So when the harness or an inherited environment already carries one of those
    variables — or the memo still names the real profile — a rollback test
    restores its synthetic fixture straight into the live profile. The config is
    silently replaced by three lines, and every plugin entry (model pools,
    team-pools, autorestart itself) disappears.

    This script makes that failure LOUD and REVERSIBLE:

      -Save      snapshot the live config (call before running the suite)
      -Verify    compare against the snapshot and restore it if it changed
                 (call after running the suite)
      -Check     compare only, change nothing (safe any time)

    Every action is idempotent. Restoring writes the snapshot back byte for byte
    and keeps the damaged copy next to it for inspection.

.EXAMPLE
    # the safe way to run the upstream suite
    pwsh -NoProfile -File guard-live-config.ps1 -Save
    try { node --test test/ } finally { pwsh -NoProfile -File guard-live-config.ps1 -Verify }

.EXAMPLE
    # just find out whether the live config is currently sane
    pwsh -NoProfile -File guard-live-config.ps1 -Check
#>
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [Parameter(ParameterSetName = 'Save')][switch]$Save,
    [Parameter(ParameterSetName = 'Verify')][switch]$Verify,
    [Parameter(ParameterSetName = 'Check')][switch]$Check,

    # The live profile config to guard.
    [string]$ConfigPath = 'C:\Users\i\.dsh-workbuddy\profiles\web\cordis.patch.yml',

    # Where the snapshot lives. Deliberately OUTSIDE the profile: a rollback that
    # rewrites the profile directory must not be able to touch the guard.
    [string]$SnapshotPath = 'C:\Users\i\Documents\DSH\TASKS\Test1\autorestart-fix\live-config-snapshot.yml'
)

$ErrorActionPreference = 'Stop'

# The minimum a healthy config has to contain. The real file is ~72 KB with a
# dozen top-level entries; the damaged one was 27 bytes. A size floor plus the
# plugin ids is enough to tell them apart without pinning the exact content.
$MinimumBytes = 1000
$RequiredIds = @('dsh-autorestart', 'team-pools', 'model-pools', 'agent-default-model')

function Get-ConfigFacts {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Exists = $false; Bytes = 0; Sha = $null; Missing = @($RequiredIds) }
    }
    $item = Get-Item -LiteralPath $Path
    $text = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    $missing = @()
    foreach ($id in $RequiredIds) {
        if ($text -notmatch [regex]::Escape("id: $id")) { $missing += $id }
    }
    return [pscustomobject]@{
        Exists  = $true
        Bytes   = $item.Length
        Sha     = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
        Missing = $missing
    }
}

function Test-ConfigHealthy {
    param($Facts)
    $problems = @()
    if (-not $Facts.Exists) { $problems += 'the file does not exist' }
    if ($Facts.Bytes -lt $MinimumBytes) { $problems += "it is only $($Facts.Bytes) bytes (a healthy one is over $MinimumBytes)" }
    if ($Facts.Missing.Count -gt 0) { $problems += "these plugin entries are gone: $($Facts.Missing -join ', ')" }
    return $problems
}

$facts = Get-ConfigFacts -Path $ConfigPath
$problems = Test-ConfigHealthy -Facts $facts

switch ($PSCmdlet.ParameterSetName) {
    'Save' {
        # A damaged config must never be captured as the good snapshot, or the
        # guard would faithfully preserve the damage.
        if ($problems.Count -gt 0) {
            Write-Host 'REFUSING to snapshot a config that is already damaged:' -ForegroundColor Red
            foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
            exit 2
        }
        $dir = Split-Path -Parent $SnapshotPath
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item -LiteralPath $ConfigPath -Destination $SnapshotPath -Force
        $snapSha = (Get-FileHash -LiteralPath $SnapshotPath -Algorithm SHA256).Hash.ToLower()
        Write-Host "saved   $ConfigPath" -ForegroundColor Green
        Write-Host "     -> $SnapshotPath  ($($facts.Bytes) bytes, sha $($snapSha.Substring(0,16)))"
        exit 0
    }

    'Verify' {
        if (-not (Test-Path -LiteralPath $SnapshotPath)) {
            Write-Host "no snapshot at $SnapshotPath — run -Save before the suite" -ForegroundColor Yellow
            if ($problems.Count -gt 0) {
                Write-Host 'and the live config is damaged right now:' -ForegroundColor Red
                foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
                exit 2
            }
            exit 1
        }
        $snapSha = (Get-FileHash -LiteralPath $SnapshotPath -Algorithm SHA256).Hash.ToLower()
        if ($facts.Exists -and $facts.Sha -eq $snapSha) {
            Write-Host "intact  $ConfigPath  ($($facts.Bytes) bytes, sha $($facts.Sha.Substring(0,16)))" -ForegroundColor Green
            exit 0
        }
        # Changed. Restore, and keep the damaged copy so the cause can be read.
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        if ($facts.Exists) {
            $broken = "$ConfigPath.damaged-$stamp"
            Copy-Item -LiteralPath $ConfigPath -Destination $broken -Force
            Write-Host "CHANGED while the suite ran: $($facts.Bytes) bytes, sha $($facts.Sha.Substring(0,16))" -ForegroundColor Red
            Write-Host "the damaged copy is kept at $broken" -ForegroundColor Yellow
        } else {
            Write-Host 'CHANGED while the suite ran: the file was DELETED' -ForegroundColor Red
        }
        Copy-Item -LiteralPath $SnapshotPath -Destination $ConfigPath -Force
        $after = Get-ConfigFacts -Path $ConfigPath
        Write-Host "restored $ConfigPath  ($($after.Bytes) bytes, sha $($after.Sha.Substring(0,16)))" -ForegroundColor Green
        exit 3
    }

    default {
        if ($problems.Count -eq 0) {
            Write-Host "ok      $ConfigPath  ($($facts.Bytes) bytes, sha $($facts.Sha.Substring(0,16)))" -ForegroundColor Green
            exit 0
        }
        Write-Host 'DAMAGED' -ForegroundColor Red
        foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
        exit 2
    }
}
