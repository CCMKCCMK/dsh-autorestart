/**
 * "SOMEBODY IS TOUCHING THE PLUGIN FILES" — the second, market-independent signal.
 *
 * WHY THIS EXISTS (user question, 2026-11-10): the market probe only knows what
 * the market plugin reports. A plugin installed by hand (`pnpm add` in a
 * terminal, or DSH's own plugin manager) never sets the market's busy flag, so
 * the gate used to see "not installing" and let a restart cut that install in
 * half — which is exactly how dsh-mnemon was lost on 2026-11-10.
 *
 * WHAT IT WATCHES: three things a package installation always touches, and that
 * ordinary use of the harness does not:
 *   - package.json      (add/remove a dependency)
 *   - pnpm-lock.yaml    (almost every install rewrites it)
 *   - node_modules/     (its own mtime plus the number of entries)
 *
 * WHY MEMORY ONLY: the state is two numbers and one string. Sampling once after
 * a restart produces a fresh baseline, while a persisted one would compare the
 * new process against a pre-restart fingerprint and report a phantom change -
 * the host itself touches node_modules while it boots (local plugins are
 * hot-mounted), so a restart would block itself for the stable window.
 *
 * THE RULE: "changing" means the fingerprint moved less than `stableMs` ago. It
 * is not a sliding "someFileChangedRecently" window, so a false positive clears
 * itself `stableMs` after the last real change instead of dragging on. A single
 * episode is also capped by `maxBlockMs` so a stuck installation cannot hold the
 * host forever.
 */

import { statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** How long the files must stay quiet before the episode is considered over. */
export const PLUGIN_FILES_STABLE_MS = 15000

/** The longest a single episode may hold a restart. */
export const PLUGIN_FILES_MAX_BLOCK_MS = 300000

/** The three paths, relative to the profile directory. */
export const PLUGIN_FILE_NAMES = Object.freeze(['package.json', 'pnpm-lock.yaml', 'node_modules'])

/**
 * A fresh state. `firstChangeAt === 0` means "no episode has started".
 *
 * @returns {{ fingerprint: string|null, lastChangeAt: number, firstChangeAt: number }}
 */
export function emptyFilesState() {
  return { fingerprint: null, lastChangeAt: 0, firstChangeAt: 0 }
}

function stamp(path, fsLike) {
  try {
    const st = fsLike.statSync(path)
    return `${Math.round(st.mtimeMs)}:${st.size ?? 0}`
  } catch {
    // A missing file is a fact too: the difference between absent and present
    // is itself a change (installing a plugin creates node_modules entries).
    return 'absent'
  }
}

function entryCount(path, fsLike) {
  try {
    return fsLike.readdirSync(path).length
  } catch {
    return -1
  }
}

/**
 * The fingerprint of one profile directory, as a single comparable string.
 *
 * Never throws: a directory that cannot be read yields 'absent' parts, which is
 * still a stable answer (and a change the moment it becomes readable).
 *
 * @param {string} profileDir
 * @param {{ statSync?: Function, readdirSync?: Function }} [fsLike]
 * @returns {string|null} null when there is no profile directory to watch
 */
export function readFingerprint(profileDir, fsLike = { statSync, readdirSync }) {
  if (typeof profileDir !== 'string' || profileDir === '') return null
  const pkg = stamp(join(profileDir, 'package.json'), fsLike)
  const lock = stamp(join(profileDir, 'pnpm-lock.yaml'), fsLike)
  const modules = join(profileDir, 'node_modules')
  const modulesStamp = stamp(modules, fsLike)
  const modulesCount = modulesStamp === 'absent' ? -1 : entryCount(modules, fsLike)
  return `pkg=${pkg}|lock=${lock}|mods=${modulesStamp}#${modulesCount}`
}

/**
 * Fold one sample into the state.
 *
 * The FIRST sample after a process start is adopted silently: it is a baseline,
 * not a change. Every later sample that differs opens (or extends) an episode.
 *
 * @param {{ fingerprint: string|null, lastChangeAt: number, firstChangeAt: number }} state
 * @param {string|null} fingerprint
 * @param {{ now?: number }} [options]
 * @returns {{ fingerprint: string|null, lastChangeAt: number, firstChangeAt: number, changed: boolean }}
 */
export function sampleFingerprint(state, fingerprint, { now = Date.now() } = {}) {
  const previous = state && typeof state === 'object' ? state : emptyFilesState()
  if (fingerprint === null) {
    // Nothing to watch (no profile directory): forget any episode, so a path
    // that disappears can never pin the gate shut.
    return { ...emptyFilesState(), changed: false }
  }
  if (previous.fingerprint === null || previous.fingerprint === undefined) {
    return { fingerprint, lastChangeAt: 0, firstChangeAt: 0, changed: false }
  }
  if (previous.fingerprint === fingerprint) {
    return { fingerprint, lastChangeAt: previous.lastChangeAt, firstChangeAt: previous.firstChangeAt, changed: false }
  }
  return {
    fingerprint,
    lastChangeAt: now,
    firstChangeAt: previous.firstChangeAt === 0 ? now : previous.firstChangeAt,
    changed: true,
  }
}

/**
 * Is an episode still running at `now`?
 *
 * TRUE while the last change is younger than `stableMs`, unless the whole
 * episode has already lasted `maxBlockMs` (the cap that keeps a stuck install
 * from holding the host forever).
 *
 * @param {{ fingerprint: string|null, lastChangeAt: number, firstChangeAt: number }} state
 * @param {{ now?: number, stableMs?: number, maxBlockMs?: number }} [options]
 * @returns {boolean}
 */
export function filesChanging(state, { now = Date.now(), stableMs = PLUGIN_FILES_STABLE_MS, maxBlockMs = PLUGIN_FILES_MAX_BLOCK_MS } = {}) {
  if (!state || typeof state !== 'object') return false
  const first = Number(state.firstChangeAt) || 0
  const last = Number(state.lastChangeAt) || 0
  if (first === 0 || last === 0) return false
  const cap = Number(maxBlockMs)
  if (Number.isFinite(cap) && cap > 0 && now - first >= cap) return false
  const stable = Number(stableMs)
  if (!Number.isFinite(stable) || stable <= 0) return false
  return now - last < stable
}

/**
 * The external blocker for a running episode, or null.
 *
 * The shape matches the market blocker, so the gate, the record and the copy
 * treat both signals the same way — only `kind` and `reason` differ.
 *
 * @param {{ fingerprint: string|null, lastChangeAt: number, firstChangeAt: number }} state
 * @param {{ now?: number, stableMs?: number, maxBlockMs?: number }} [options]
 * @returns {{ kind: string, reason: string, since: number, files: string[] }|null}
 */
export function filesBlocker(state, options = {}) {
  if (!filesChanging(state, options)) return null
  const since = Number(state.firstChangeAt) || 0
  return { kind: 'plugin-files', reason: 'plugin-files', since, files: [...PLUGIN_FILE_NAMES] }
}

/** One line for the record/logs. */
export function describeFilesEpisode(state, options = {}) {
  if (!filesChanging(state, options)) return 'the plugin files are quiet'
  const now = options.now ?? Date.now()
  const quietForMs = now - (Number(state.lastChangeAt) || now)
  return `the plugin files changed ${Math.max(0, Math.round(quietForMs / 1000))}s ago and have not settled yet`
}
