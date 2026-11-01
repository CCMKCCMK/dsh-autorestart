/**
 * WHAT IS INSTALLED, AND HOW IT DIFFERS FROM THE LAST BACKUP.
 *
 * WHY THIS EXISTS (user decision, 2026-11-01): the in-process detection of "which
 * plugin did not activate" was tried twice and is closed — the live cordis
 * registry reports its own internals rather than activation state, and
 * `ctx.get('tools').execute(...)` is refused during boot because it wants a whole
 * execution context the plugin cannot obtain. So the user decides instead: the
 * settings page shows every installed plugin, marks how each one differs from the
 * newest backup, and lets the human pick one to put back.
 *
 * WHAT A DIFFERENCE DOES AND DOES NOT MEAN — the honest limit, and the reason the
 * wording here never says "broken":
 *
 *   IT FINDS: a file that was changed, deleted, or is absent from the backup.
 *   IT DOES NOT FIND: a plugin whose files are all correct but which fails while
 *   loading (a missing peer dependency, a throwing initialiser, a version the
 *   host refuses).
 *
 * A difference is therefore a FIRST-PASS SIGNAL, not a verdict. "different" must
 * never be rendered as "this plugin failed to load".
 *
 * PERFORMANCE IS A HARD REQUIREMENT: the real profile is ~150 MB and the backup
 * ~295 MB. Nothing here hashes a tree. A comparison is "the set of relative paths
 * plus each file's size", which is a stat per file and no reads at all. Every walk
 * is bounded, and a bounded walk says so (`truncated: true`) instead of quietly
 * reporting a short answer as a complete one.
 *
 * EVERYTHING IS INJECTABLE AND NOTHING THROWS: the filesystem is passed in so this
 * is testable without a profile, and a path that cannot be read becomes
 * `status: 'unknown'` with a `reason` — this feeds an HTTP route, where an
 * exception would be a broken page.
 */

import fsDefault from 'node:fs'
import path from 'node:path'

/** How one plugin stands relative to the backup. */
export const PLUGIN_STATUS = Object.freeze({
  /** Identical by path set and file sizes. */
  SAME: 'same',
  /** Some file was added, removed or changed size. */
  DIFFERENT: 'different',
  /** The plugin has a live directory but the backup has none. */
  MISSING: 'missing',
  /** The plugin has no live directory at all. */
  NOT_INSTALLED: 'not-installed',
  /** It could not be decided (unreadable, no backup, too large to walk). */
  UNKNOWN: 'unknown',
})

/** What kind of change one path is. */
export const CHANGE_KIND = Object.freeze({
  /** Present live, absent from the backup. */
  ADDED: 'added',
  /** Present in the backup, absent live. */
  REMOVED: 'removed',
  /** Present in both, different size. */
  MODIFIED: 'modified',
})

/** How many files one plugin may contain before the walk stops and says so. */
export const MAX_FILES_PER_PLUGIN = 20000

/** How deep the walk goes inside one plugin directory. */
export const MAX_DEPTH = 12

/** How many change rows a single answer carries (the count stays exact). */
export const MAX_CHANGES = 200

/** The directory a profile keeps its plugins in (same constant as the backup). */
const PLUGINS_DIR = 'node_modules'
/**
 * WHERE A HAND-WRITTEN PLUGIN LIVES.
 *
 * `dsh plugin add ./my-plugin` does not copy the tree into `node_modules` - it
 * writes a LINK into `node_modules-link`. Looking for such a plugin only under
 * `node_modules` therefore reported it as "missing", which downstream was read
 * as "this is not our own plugin", which removed the one button that could put
 * it back. The data was never cosmetic.
 */
const LINK_PLUGINS_DIR = 'node_modules-link'

/** A path we are willing to walk: a non-empty string. */
function dirOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/** Read one JSON file, or null (never throws). */
function readJson(fs, file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Does this path exist as a directory? */
function isDirectory(fs, target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Is this path ITSELF a symbolic link (without following it)?
 *
 * `node_modules/<name>` is a real directory for an npm install and a SYMLINK for
 * a hand-written plugin added with `dsh plugin add ./my-plugin`. That difference
 * is the only reliable way to tell "our own plugin" from "somebody else's":
 * a broken link still has to be recognised as ours, because that is exactly the
 * case where the user needs the restore button.
 *
 * lstat, not stat: stat follows the link and reports the target, so it can never
 * answer this question.
 */
function isSymbolicLink(fs, target) {
  try {
    const lstat = typeof fs.lstatSync === 'function' ? fs.lstatSync : fs.statSync
    return lstat(target).isSymbolicLink() === true
  } catch {
    return false
  }
}

/**
 * Walk `root` and return `Map<relativePath, size>`.
 *
 * BOUNDED ON PURPOSE: it stops at `maxFiles` entries and `maxDepth` levels and
 * reports `truncated: true`, because a truncated answer that claims to be
 * complete is worse than no answer at all.
 *
 * Only files are recorded; empty directories carry no meaning for a comparison.
 *
 * @returns {{ files: Map<string, number>, truncated: boolean, reason: string }}
 */
export function walkFiles(root, { fs = fsDefault, maxFiles = MAX_FILES_PER_PLUGIN, maxDepth = MAX_DEPTH } = {}) {
  const files = new Map()
  const out = { files, truncated: false, reason: '' }
  const start = dirOf(root)
  if (start === '') {
    out.reason = 'no directory'
    return out
  }
  if (isDirectory(fs, start) !== true) {
    out.reason = 'not a directory'
    return out
  }
  // An explicit stack instead of recursion: a deep tree cannot blow the call stack.
  const stack = [{ dir: start, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // A directory we cannot read is skipped, not fatal.
      continue
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name)
      let stat = null
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory() === true) {
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 })
        else out.truncated = true
        continue
      }
      if (stat.isFile() !== true) continue
      if (files.size >= maxFiles) {
        out.truncated = true
        return out
      }
      files.set(path.relative(start, full).split(path.sep).join('/'), Number(stat.size) || 0)
    }
  }
  return out
}

/**
 * The plugins a profile enables.
 *
 * Two sources, both real: `dependencies` (what npm put there) and
 * `dsh.profile.bundles` (what the host was told to load). A bundle can be enabled
 * without being a dependency of the profile package, so the union is the honest
 * answer.
 *
 * NEVER THROWS: an unreadable profile is an empty list plus a `reason`.
 *
 * @param {string} profileDir
 * @param {{ fs?: object }} [options]
 * @returns {{ plugins: Array<{ name: string, version: string|null, installed: boolean, enabled: boolean, dir: string }>, reason: string }}
 */
export function listInstalledPlugins(profileDir, { fs = fsDefault } = {}) {
  const dir = dirOf(profileDir)
  const out = { plugins: [], reason: '' }
  if (dir === '') {
    out.reason = 'no profile directory'
    return out
  }
  const pkg = readJson(fs, path.join(dir, 'package.json'))
  if (pkg === null) {
    out.reason = 'the profile package.json could not be read'
    return out
  }
  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  const profile = dsh.profile && typeof dsh.profile === 'object' ? dsh.profile : {}
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : []
  const enabled = new Set()
  for (const entry of bundles) {
    // A bundle is either a bare name or `{ name }` — both spellings exist.
    const name = typeof entry === 'string' ? entry : (entry && typeof entry.name === 'string' ? entry.name : '')
    if (name !== '') enabled.add(name)
  }
  const names = new Set()
  for (const name of Object.keys(dependencies)) if (typeof name === 'string' && name !== '') names.add(name)
  for (const name of enabled) names.add(name)

  for (const name of [...names].sort()) {
    // ONE directory. In a profile a hand-written plugin is a SYMLINK inside
    // node_modules - there is no node_modules-link there at all.
    const pluginDir = path.join(dir, PLUGINS_DIR, name)
    const linked = isSymbolicLink(fs, pluginDir)
    const installed = isDirectory(fs, pluginDir)
    const manifest = installed ? readJson(fs, path.join(pluginDir, 'package.json')) : null
    out.plugins.push({
      name,
      version: manifest !== null && typeof manifest.version === 'string' ? manifest.version : null,
      installed,
      enabled: enabled.has(name),
      linked,
      dir: pluginDir,
    })
  }
  return out
}

/**
 * HOW ONE PLUGIN DIFFERS FROM ITS COPY IN THE BACKUP.
 *
 * The comparison is "path set + size" and nothing else: no hashing, no file
 * contents, one `stat` per file. That is what keeps a 120-plugin, 295 MB backup
 * inside a page load.
 *
 * @param {{ liveDir?: string, backupDir?: string }} input
 * @param {{ fs?: object, maxFiles?: number, maxDepth?: number, maxChanges?: number }} [options]
 * @returns {{ status: string, changes: Array<{ path: string, kind: string }>,
 *   changeCount: number, liveCount: number, backupCount: number,
 *   truncated: boolean, reason: string }}
 */
export function comparePlugin(input, { fs = fsDefault, maxFiles = MAX_FILES_PER_PLUGIN, maxDepth = MAX_DEPTH, maxChanges = MAX_CHANGES } = {}) {
  // Destructuring `null` throws, and this function promises it never does — so the
  // input is normalised before anything is read from it.
  const { liveDir, backupDir } = input !== null && typeof input === 'object' ? input : {}
  const out = {
    status: PLUGIN_STATUS.UNKNOWN,
    changes: [],
    changeCount: 0,
    liveCount: 0,
    backupCount: 0,
    truncated: false,
    reason: '',
  }
  try {
    const live = dirOf(liveDir)
    const backup = dirOf(backupDir)
    if (live !== '' && isDirectory(fs, live) !== true) {
      // The profile has no directory for it at all: nothing to compare.
      out.status = PLUGIN_STATUS.NOT_INSTALLED
      out.reason = 'the plugin has no directory in the profile'
      return out
    }
    if (live === '') {
      out.reason = 'no live directory was given'
      return out
    }
    if (backup === '' || isDirectory(fs, backup) !== true) {
      // It is here now but the backup never had it.
      out.status = PLUGIN_STATUS.MISSING
      out.reason = 'the backup has no copy of this plugin'
      return out
    }
    const liveWalk = walkFiles(live, { fs, maxFiles, maxDepth })
    const backupWalk = walkFiles(backup, { fs, maxFiles, maxDepth })
    out.liveCount = liveWalk.files.size
    out.backupCount = backupWalk.files.size
    if (liveWalk.truncated === true || backupWalk.truncated === true) out.truncated = true

    const all = new Set([...liveWalk.files.keys(), ...backupWalk.files.keys()])
    const changes = []
    for (const relPath of all) {
      const liveSize = liveWalk.files.get(relPath)
      const backupSize = backupWalk.files.get(relPath)
      if (liveSize === undefined) {
        changes.push({ path: relPath, kind: CHANGE_KIND.REMOVED })
      } else if (backupSize === undefined) {
        changes.push({ path: relPath, kind: CHANGE_KIND.ADDED })
      } else if (liveSize !== backupSize) {
        changes.push({ path: relPath, kind: CHANGE_KIND.MODIFIED })
      }
    }
    changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    out.changeCount = changes.length
    // The count is exact even when the rows are cut — the interface can say
    // "+37 more" without lying about how many there are.
    out.changes = changes.slice(0, maxChanges)
    out.status = changes.length === 0 ? PLUGIN_STATUS.SAME : PLUGIN_STATUS.DIFFERENT
    return out
  } catch (error) {
    out.status = PLUGIN_STATUS.UNKNOWN
    out.reason = String(error && error.message ? error.message : error)
    return out
  }
}

/**
 * The newest backup directory under `backupsDir`, or null.
 *
 * Names are timestamps (`20261101T024043Z`), so the lexical maximum is the newest;
 * a directory that does not parse still competes by modification time, because a
 * backup this code cannot name is still a backup.
 */
function newestBackupDir(backupsDir, fs) {
  const root = dirOf(backupsDir)
  if (root === '' || isDirectory(fs, root) !== true) return null
  let names
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  let best = null
  let bestKey = ''
  let bestTime = -1
  for (const entry of names) {
    if (entry.isDirectory() !== true) continue
    const full = path.join(root, entry.name)
    // A DIRECTORY WITHOUT A TIMESTAMP IS NOT A BACKUP (2026-11-01).
    //
    // The name and the mtime alone are not enough: a half-written snapshot has a
    // perfectly good-looking name and a very recent mtime, which is exactly how
    // the broken 06-06-50 directory was picked as "the newest backup" and used as
    // the baseline for the comparison. The rule is the same one listBackups uses:
    // a manifest or a meta.json with a finite `at`, or it does not compete.
    //
    // It is not removed or moved here — only excluded from the competition.
    const meta = readJson(fs, path.join(full, 'manifest.json'))
      ?? readJson(fs, path.join(full, 'meta.json'))
    if (meta === null || !Number.isFinite(Number(meta.at))) continue
    let time = -1
    try {
      time = Number(fs.statSync(full).mtimeMs) || 0
    } catch {
      time = 0
    }
    // A timestamp-shaped name wins outright; otherwise the newest mtime does.
    const looksStamped = /^\d{8}T\d{6}Z?$/.test(entry.name) || /^\d{8}-\d{6}/.test(entry.name)
    const key = (looksStamped ? '1' : '0') + entry.name
    if (best === null || key > bestKey || (key === bestKey && time > bestTime)) {
      best = { dir: full, name: entry.name, at: time }
      bestKey = key
      bestTime = time
    }
  }
  return best
}

/**
 * THE WHOLE LIST, MEASURED AGAINST THE NEWEST BACKUP.
 *
 * With no backup at all this does NOT fail: it returns the installed plugins with
 * `status: 'unknown'` and `reason: 'no backup'`, because "there is nothing to
 * compare against yet" is a normal state on a fresh machine, not an error.
 *
 * @param {{ profileDir?: string, backupsDir?: string, now?: number }} input
 * @param {{ fs?: object, maxFiles?: number, maxDepth?: number, maxChanges?: number }} [options]
 * @returns {{ backupAt: number|null, backupDir: string|null, backupName: string|null,
 *   plugins: Array<object>, reason: string }}
 */
export function inventory(input, { fs = fsDefault, maxFiles = MAX_FILES_PER_PLUGIN, maxDepth = MAX_DEPTH, maxChanges = MAX_CHANGES } = {}) {
  const { profileDir, backupsDir, now } = input !== null && typeof input === 'object' ? input : {}
  const out = { backupAt: null, backupDir: null, backupName: null, plugins: [], reason: '' }
  try {
    const listed = listInstalledPlugins(profileDir, { fs })
    if (listed.reason !== '') out.reason = listed.reason
    const backup = newestBackupDir(backupsDir, fs)
    if (backup === null) {
      // Nothing to compare against: list what is installed and say why there is
      // no verdict. This is the fresh-machine case, not a failure.
      out.plugins = listed.plugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        installed: plugin.installed,
        enabled: plugin.enabled,
        status: PLUGIN_STATUS.UNKNOWN,
        backupVersion: null,
        changeCount: 0,
        linked: plugin.linked === true,
      }))
      out.reason = out.reason === '' ? 'no backup' : out.reason + '; no backup'
      return out
    }
    out.backupDir = backup.dir
    out.backupName = backup.name
    const meta = readJson(fs, path.join(backup.dir, 'meta.json'))
    const at = meta !== null && Number.isFinite(Number(meta.at)) ? Math.trunc(Number(meta.at)) : null
    out.backupAt = at !== null ? at : (Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : null)

    for (const plugin of listed.plugins) {
      // The copy of a LINKED plugin is under node_modules-link in the backup too;
      // looking in node_modules made a perfectly good backup look absent.
      const backupPluginDir = path.join(
        backup.dir,
        plugin.linked === true ? LINK_PLUGINS_DIR : PLUGINS_DIR,
        plugin.name,
      )
      const compared = comparePlugin(
        { liveDir: plugin.dir, backupDir: backupPluginDir },
        { fs, maxFiles, maxDepth, maxChanges: 0 },
      )
      const backupManifest = isDirectory(fs, backupPluginDir)
        ? readJson(fs, path.join(backupPluginDir, 'package.json'))
        : null
      out.plugins.push({
        name: plugin.name,
        version: plugin.version,
        installed: plugin.installed,
        enabled: plugin.enabled,
        status: compared.status,
        backupVersion: backupManifest !== null && typeof backupManifest.version === 'string' ? backupManifest.version : null,
        changeCount: compared.changeCount,
        truncated: compared.truncated === true,
        linked: plugin.linked === true,
      })
    }
    return out
  } catch (error) {
    out.reason = String(error && error.message ? error.message : error)
    return out
  }
}

/**
 * The change rows of ONE plugin, for the detail view.
 *
 * Same comparison, but with the rows kept (still capped) — the list view only needs
 * counts, the detail view needs the paths.
 *
 * @returns {{ plugin: string, status: string, changes: Array<{ path: string, kind: string }>,
 *   changeCount: number, truncated: boolean, reason: string }}
 */
export function pluginDetail(input, { fs = fsDefault, maxFiles = MAX_FILES_PER_PLUGIN, maxDepth = MAX_DEPTH, maxChanges = MAX_CHANGES } = {}) {
  const { profileDir, backupsDir, plugin } = input !== null && typeof input === 'object' ? input : {}
  const name = typeof plugin === 'string' ? plugin.trim() : ''
  const out = {
    plugin: name,
    status: PLUGIN_STATUS.UNKNOWN,
    changes: [],
    changeCount: 0,
    truncated: false,
    reason: '',
  }
  if (name === '') {
    out.reason = 'no plugin name was given'
    return out
  }
  try {
    const profile = dirOf(profileDir)
    const liveDir = profile === '' ? '' : path.join(profile, PLUGINS_DIR, name)
    const isLinked = liveDir !== '' && isSymbolicLink(fs, liveDir)
    const backup = newestBackupDir(backupsDir, fs)
    if (backup === null) {
      out.status = PLUGIN_STATUS.UNKNOWN
      out.reason = 'no backup'
      return out
    }
    const backupDir = path.join(backup.dir, isLinked === true ? LINK_PLUGINS_DIR : PLUGINS_DIR, name)
    const compared = comparePlugin({ liveDir, backupDir }, { fs, maxFiles, maxDepth, maxChanges })
    out.status = compared.status
    out.changes = compared.changes
    out.changeCount = compared.changeCount
    out.truncated = compared.truncated
    out.reason = compared.reason
    return out
  } catch (error) {
    out.status = PLUGIN_STATUS.UNKNOWN
    out.reason = String(error && error.message ? error.message : error)
    return out
  }
}
