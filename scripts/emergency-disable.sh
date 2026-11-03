#!/bin/sh
# dsh-autorestart - the emergency switch (POSIX: Linux, WSL, macOS).
#
# Three traps this file avoids (the whole story: scripts/README.md):
#   1. the wording lives in rescue-strings.zh.json and is NESTED - it is read
#      by path with node, never by a flat grep;
#   2. the English fallbacks below must NOT contain parentheses: dash counts
#      them even inside single quotes, and one stray ")" breaks the script;
#   3. the sed expressions stay single-quoted: the shell eats the backslashes
#      in a double-quoted sed program and truncates it.
#
# "I enabled the plugin and DSH does not start any more" is the hardest moment
# for a plugin: fixing it needs the plugin itself. This script touches ONE file
# - the package.json of the profile - and ONE array in it:
# `dsh.profile.bundles`.
#
#     - disable: take "dsh-autorestart" out of the bundles (it was not there
#       anyway -> report "already disabled", that is not a failure);
#     - enable : put "dsh-autorestart" back into the bundles;
#     - status : read only, says whether it is in the bundles right now.
#
# Two hard rules:
#
#   1. the file is backed up as `package.json.bak-emergency-<stamp>` before
#      anything is written;
#   2. after writing, the JSON is parsed again and checked; if the check
#      fails, the backup is put back and the failure is reported honestly.
#
# The indentation and the line endings of the file are kept as they are (the
# TEXT is edited, the JSON is not re-serialized).
#
# The file is pure ASCII on purpose: the Chinese wording lives in
# rescue-strings.zh.json (UTF-8 without a BOM).
set -eu

PACKAGE_NAME='dsh-autorestart'
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STRINGS_FILE="$SCRIPT_DIR/rescue-strings.zh.json"

ACTION='disable'
DRY_RUN=0
PACKAGE_JSON=''

usage() {
  printf 'Usage: %s [--action disable|enable|status] [--dry-run] [--package FILE]\n' "$0"
  printf '  --action ...   what to do (default: disable)\n'
  printf '  --dry-run      say what would be written, change nothing\n'
  printf '  --package FILE the package.json to work on (default: the profile of this machine)\n'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="${2:-}"; shift ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --package) PACKAGE_JSON="${2:-}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$ACTION" in
  disable|enable|status) ;;
  *) printf 'unknown action: %s\n' "$ACTION" >&2; usage >&2; exit 2 ;;
esac

NODE_BIN=''
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
fi

# t <key> <english fallback>
#
# The key is a PATH into the strings file ("emergency.done"), because that file
# is nested. Node reads it (it is on every machine that runs DSH); without
# node every message falls back to English.
t() {
  key="$1"
  fallback="$2"
  if [ -n "$NODE_BIN" ] && [ -f "$STRINGS_FILE" ]; then
    value=$("$NODE_BIN" -e '
      const fs = require("fs");
      try {
        const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
        let value = doc;
        for (const part of process.argv[2].split(".")) value = value == null ? undefined : value[part];
        if (typeof value !== "string" || value === "") process.exit(1);
        process.stdout.write(value);
      } catch (error) { process.exit(1); }
    ' "$STRINGS_FILE" "$key" 2>/dev/null) || value=''
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  printf '%s' "$fallback"
}

# fmt <text> <value> ...
#
# Node does the replacement when it is there: the Chinese wording is UTF-8 and
# a byte-wise sed would mangle it. Without node only the English fallbacks are
# used, and those are plain ASCII.
fmt() {
  text="$1"
  shift
  if [ -n "$NODE_BIN" ]; then
    if "$NODE_BIN" -e '
      let text = process.argv[1];
      process.argv.slice(2).forEach((value, index) => { text = text.split("{" + index + "}").join(value); });
      process.stdout.write(text);
    ' "$text" "$@" 2>/dev/null; then
      return 0
    fi
  fi
  index=0
  for value in "$@"; do
    safe=$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')
    text=$(printf '%s' "$text" | sed "s|{$index}|$safe|g")
    index=$((index + 1))
  done
  printf '%s' "$text"
}

say() {
  printf '%s\n' "$1"
}

fail() {
  printf '%s%s\n' "$(t 'emergency.failed' 'the emergency switch failed: {0}')" "$1" >&2
  exit 1
}

full_path() {
  target="${1:-}"
  [ -n "$target" ] || return 0
  case "$target" in
    /*) resolved="$target" ;;
    *) resolved="$PWD/$target" ;;
  esac
  while [ "${resolved%/}" != "$resolved" ] && [ "${resolved%/}" != '' ]; do
    resolved="${resolved%/}"
  done
  printf '%s' "$resolved"
}

dsh_home() {
  if [ -n "${DSH_HOME:-}" ]; then
    full_path "$DSH_HOME"
    return 0
  fi
  if [ -n "${HOME:-}" ]; then
    full_path "$HOME/.dsh"
    return 0
  fi
  printf ''
}

# The package.json of the profile of this machine.
default_package_json() {
  if [ -n "${DSH_PROFILE_DIR:-}" ]; then
    explicit=$(full_path "$DSH_PROFILE_DIR")
    if [ -n "$explicit" ] && [ -f "$explicit/package.json" ]; then
      printf '%s' "$explicit/package.json"
      return 0
    fi
  fi
  root=$(dsh_home)
  if [ -n "$root" ]; then
    profiles="$root/profiles"
    if [ -d "$profiles" ]; then
      match=''
      count=0
      for entry in "$profiles"/*; do
        [ -f "$entry/package.json" ] || continue
        if grep -q "\"$PACKAGE_NAME\"" "$entry/package.json" 2>/dev/null; then
          match="$entry/package.json"
          count=$((count + 1))
        fi
      done
      if [ "$count" -eq 1 ]; then
        printf '%s' "$match"
        return 0
      fi
    fi
    if [ -n "${DSH_PROFILE:-}" ]; then
      printf '%s' "$profiles/$DSH_PROFILE/package.json"
      return 0
    fi
    printf '%s' "$profiles/desktop/package.json"
    return 0
  fi
  printf ''
}

# The bundles of a package.json, one per line.
bundles_list() {
  file="$1"
  [ -f "$file" ] || return 1
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e 'try { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); const b = d && d.dsh && d.dsh.profile && d.dsh.profile.bundles; if (!Array.isArray(b)) process.exit(1); process.stdout.write(b.join("\n")) } catch (error) { process.exit(1) }' "$file" 2>/dev/null
    return $?
  fi
  sed -n 's/.*"bundles"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' "$file" | tr ',' '\n' | sed 's/["[:space:]]//g'
}

json_parses() {
  file="$1"
  [ -f "$file" ] || return 1
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); process.exit(0) } catch (error) { process.exit(1) }' "$file" >/dev/null 2>&1
    return $?
  fi
  head -c 1 "$file" | grep -q '{' || return 1
  return 0
}

# Is every field of this package.json on ONE line?
#
# A compact profile (a generator, a bundler, a human with `jq -c`) puts the whole
# document on a single line. The line-oriented sed below cannot work on that: it
# deletes a WHOLE line (which would delete the entire file) and it appends after
# a line that ENDS with `[` (which never happens when the array has members on
# the same line). So a compact file takes the node path instead.
compact_file() {
  file="$1"
  [ -n "$NODE_BIN" ] || return 1
  [ -f "$file" ] || return 1
  "$NODE_BIN" -e '
    const fs = require("fs");
    try {
      const text = fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "");
      process.exit(text.replace(/\r?\n$/, "").includes("\n") ? 1 : 0);
    } catch (error) { process.exit(1); }
  ' "$file" >/dev/null 2>&1
}

# Rewrite a COMPACT package.json on still ONE line, without touching anything but
# the bundles array: the document is parsed, the name is removed from (or pushed
# into) `dsh.profile.bundles`, and the result is serialized back to a single line
# with the keys in their original order. Every other field, the name of the
# profile included, keeps its value.
#
# Prints the new document on stdout; nothing is written here (the caller writes
# it into the temp file it already knows how to swap in).
compact_edit() {
  file="$1"
  action="$2"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, action, name] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    let doc;
    try { doc = JSON.parse(text); } catch (error) { process.exit(3); }
    const profile = doc && doc.dsh && doc.dsh.profile;
    const bundles = profile && Array.isArray(profile.bundles) ? profile.bundles : null;
    if (bundles === null) process.exit(4);
    const next = bundles.filter((entry) => entry !== name);
    // FIRST in the list, like the multi-line sed path does (it inserts right
    // after the opening bracket). The two paths agree on order.
    if (action === "enable") next.unshift(name);
    profile.bundles = next;
    const single = JSON.stringify(doc);
    process.stdout.write(single + (text.endsWith("\n") ? "\n" : ""));
  ' "$file" "$action" "$PACKAGE_NAME"
}

# --- Start ---

if [ -n "$PACKAGE_JSON" ]; then
  pkg=$(full_path "$PACKAGE_JSON")
else
  pkg=$(default_package_json)
fi
if [ -z "$pkg" ]; then
  fail "$(t 'emergency.notFound' 'the package.json of the profile cannot be found: {0}')" ''
fi
if [ ! -f "$pkg" ]; then
  fail "$(fmt "$(t 'emergency.notFound' 'the package.json of the profile cannot be found: {0}')" "$pkg")"
fi
if ! json_parses "$pkg"; then
  fail "$(fmt "$(t 'emergency.badJson' 'this package.json is not valid JSON: {0}')" "$pkg")"
fi
say "$(fmt "$(t 'emergency.file' 'file: {0}')" "$pkg")"

list=$(bundles_list "$pkg" || printf '')
if [ -z "$list" ]; then
  fail "$(fmt "$(t 'emergency.noBundles' 'this profile has no dsh.profile.bundles list')" '')"
fi

in_bundles=0
if printf '%s\n' "$list" | grep -qx "$PACKAGE_NAME"; then
  in_bundles=1
fi

if [ "$ACTION" = 'status' ]; then
  if [ "$in_bundles" -eq 1 ]; then
    say "$(fmt "$(t 'emergency.enabled' 'enabled: {0} is in the bundles.')" "$PACKAGE_NAME")"
  else
    say "$(fmt "$(t 'emergency.disabled' 'disabled: {0} is not in the bundles.')" "$PACKAGE_NAME")"
  fi
  exit 0
fi

if [ "$ACTION" = 'disable' ] && [ "$in_bundles" -eq 0 ]; then
  say "$(fmt "$(t 'emergency.alreadyDisabled' 'already disabled: {0} was not in the bundles (no file was changed).')" "$PACKAGE_NAME")"
  exit 0
fi
if [ "$ACTION" = 'enable' ] && [ "$in_bundles" -eq 1 ]; then
  say "$(fmt "$(t 'emergency.alreadyEnabled' 'already enabled: {0} was in the bundles (no file was changed).')" "$PACKAGE_NAME")"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$ACTION" = 'disable' ]; then
    say "$(fmt "$(t 'emergency.dryRunWill' '[dry run] {0} would be taken out of the bundles.')" "$PACKAGE_NAME")"
  else
    say "$(fmt "$(t 'emergency.dryRunWill' '[dry run] {0} would be taken out of the bundles.')" "$PACKAGE_NAME")"
  fi
  say "$(fmt "$(t 'emergency.dryRunBackup' '[dry run] it would be backed up as: {0}.bak-emergency-<stamp>')" "$pkg")"
  say "$(t 'emergency.dryRunNoChange' '[dry run] no file was changed.')"
  exit 0
fi

# --- Back up, then write ---
# NEVER OVERWRITE AN EARLIER BACKUP (2026-11-03): the stamp carries milliseconds, and
# when that name is still taken a serial number is appended. Before this the stamp
# stopped at the second, so two writes inside one second left ONE backup.
stamp=$(date -u +%Y%m%d-%H%M%S-%3N)
backup="$pkg.bak-emergency-$stamp"
serial=1
while [ -e "$backup" ]; do
  serial=$((serial + 1))
  backup="$pkg.bak-emergency-$stamp-$serial"
done
if ! cp -- "$pkg" "$backup"; then
  fail "$(fmt "$(t 'emergency.backupFailed' 'the backup failed - the original file was not touched: {0}')" "$backup")"
fi

tmp="$pkg.tmp-emergency-$$"
if compact_file "$pkg"; then
  # ONE LINE IN, ONE LINE OUT: the document is edited as JSON and written back
  # in the same style, because the line-oriented sed below has no line to work
  # on (it would delete the whole file, or append after a line that never ends
  # with the opening bracket).
  if ! compact_edit "$pkg" "$ACTION" > "$tmp"; then
    rm -f -- "$tmp" 2>/dev/null || true
    fail "$(fmt "$(t 'emergency.writeFailed' 'the write failed - the backup is at {0}: {1}')" "$backup" "$pkg")"
  fi
elif [ "$ACTION" = 'disable' ]; then
  sed "/^[[:space:]]*\"$PACKAGE_NAME\"[[:space:]]*,\{0,1\}[[:space:]]*$/d" "$pkg" > "$tmp"
else
  sed "s/^\\([[:space:]]*\"bundles\"[[:space:]]*:[[:space:]]*\\[\\)$/\\1\\n    \"$PACKAGE_NAME\",/" "$pkg" > "$tmp"
fi
if ! mv -- "$tmp" "$pkg"; then
  rm -f -- "$tmp" 2>/dev/null || true
  fail "$(fmt "$(t 'emergency.writeFailed' 'the write failed - the backup is at {0}: {1}')" "$backup" "$pkg")"
fi

# --- Read it back ---
if ! json_parses "$pkg"; then
  cp -- "$backup" "$pkg" || true
  fail "$(fmt "$(t 'emergency.verifyFailedRolledBack' 'the check failed - it was rolled back: {0}')" "$backup")"
fi
after=$(bundles_list "$pkg" || printf '')
if [ "$ACTION" = 'disable' ]; then
  if printf '%s\n' "$after" | grep -qx "$PACKAGE_NAME"; then
    cp -- "$backup" "$pkg" || true
    fail "$(fmt "$(t 'emergency.verifyFailedRolledBack' 'the check failed - it was rolled back: {0}')" "$backup")"
  fi
  say "$(fmt "$(t 'emergency.done' 'done: {0}.')" "$(fmt "$(t 'emergency.summaryRemove' 'dsh-autorestart was taken out of the bundles')" '')")"
else
  if ! printf '%s\n' "$after" | grep -qx "$PACKAGE_NAME"; then
    cp -- "$backup" "$pkg" || true
    fail "$(fmt "$(t 'emergency.verifyFailedRolledBack' 'the check failed - it was rolled back: {0}')" "$backup")"
  fi
  say "$(fmt "$(t 'emergency.done' 'done: {0}.')" "$(fmt "$(t 'emergency.summaryAdd' 'dsh-autorestart was put back into the bundles')" '')")"
fi
say "$(fmt "$(t 'emergency.backup' 'backup: {0}')" "$backup")"
say "$(t 'emergency.restartHint' 'Restart DSH for it to take effect.')"
exit 0
