/**
 * THE COPY REPORTS WHAT IT REALLY MOVES (2026-11-06).
 *
 * WHAT WAS WRONG ON THE REAL MACHINE: the copy of a linked plugin went into
 * `node_modules-link/<name>` WITHOUT a progress callback, so the interface sat
 * at "89 KB / 0%" while 258 MB were being written. The denominator was the
 * WHOLE profile, measured before the copy started — a slim backup copies the
 * configuration and the linked plugins only, so that number could never be
 * reached even when the copy was done.
 *
 * THE TWO RULES PINNED HERE:
 *   1. the copy of a LINKED plugin REPORTS while it runs (several times, with
 *      growing numbers), and
 *   2. the denominator is WHAT THIS BACKUP REALLY COPIES — so the copy ends at
 *      100% instead of at a number that can never be reached.
 *
 * The fixture is built so that both are provable: the linked plugin has 60
 * files (so the copy reports more than once) and the profile ALSO holds a
 * third-party plugin that this backup never copies (so a denominator that
 * counts it is visibly too big).
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBackup } from '../lib/backup.js'

/** How many files the linked plugin holds (the copy reports every 25). */
const LINK_FILES = 60

/** How big one file of the linked plugin is. */
const LINK_FILE_BYTES = 1024

/** The third-party plugin: published as-is, so this backup never copies it. */
const THIRD_PARTY_BYTES = 200 * 1024

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-progress-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

/**
 * A profile with ONE linked plugin (a working checkout) and one third-party
 * plugin (installed from npm, not edited here — so it is only named).
 */
function makeProfile(root) {
  const profile = path.join(root, 'profile')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'host: 127.0.0.1\n', 'utf8')
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'probe-profile', dsh: { profile: { bundles: ['dsh-linked'] } } }, null, 2),
    'utf8',
  )
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

  // THE LINKED PLUGIN: enough files that the copy reports more than once.
  const source = path.join(root, 'plugin-source')
  fs.mkdirSync(source, { recursive: true })
  for (let index = 0; index < LINK_FILES; index += 1) {
    fs.writeFileSync(path.join(source, 'f' + index + '.js'), 'x'.repeat(LINK_FILE_BYTES), 'utf8')
  }
  // THE THIRD-PARTY PLUGIN: a big file this backup must NOT copy.
  const thirdParty = path.join(profile, 'node_modules', 'third-party')
  fs.mkdirSync(thirdParty, { recursive: true })
  fs.writeFileSync(path.join(thirdParty, 'index.js'), 'y'.repeat(THIRD_PARTY_BYTES), 'utf8')

  fs.symlinkSync(source, path.join(profile, 'node_modules', 'dsh-linked'), 'junction')
  return { profile, source }
}

/** The bytes the configuration alone takes — the copies report it first. */
function configBytesOf(profile) {
  let total = 0
  for (const name of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']) {
    total += fs.statSync(path.join(profile, name)).size
  }
  return total
}

test('the copy of a LINKED plugin reports while it runs, and it ends at 100%', async (t) => {
  const root = tempRoot(t)
  const { profile } = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  const reports = []
  const result = await createBackup({
    profileDir: profile,
    backupsDir,
    includePlugins: true,
    onProgress: (progress) => { reports.push({ ...progress }) },
  })
  assert.equal(result.ok, true, String(result.error))

  // ① IT REPORTED SEVERAL TIMES.
  assert.ok(reports.length >= 3, 'the copy reported more than once: ' + reports.length)

  // ② THE NUMBERS ONLY EVER GROW.
  for (let index = 1; index < reports.length; index += 1) {
    assert.ok(
      reports[index].bytes >= reports[index - 1].bytes,
      'the bytes never go back: ' + JSON.stringify(reports.slice(index - 1, index + 1)),
    )
    assert.ok(
      reports[index].files >= reports[index - 1].files,
      'the file count never goes back: ' + JSON.stringify(reports.slice(index - 1, index + 1)),
    )
  }

  // ③ THE REPORTS ARE ABOUT THE LINKED PLUGIN, NOT ONLY THE CONFIGURATION.
  const configBytes = configBytesOf(profile)
  const duringLink = reports.filter((entry) => entry.bytes > configBytes)
  assert.ok(
    duringLink.length >= 2,
    'the copy of the linked plugin reported while it ran: ' + duringLink.length + ' reports',
  )
  const linkBytes = duringLink[duringLink.length - 1].bytes - configBytes
  assert.ok(
    linkBytes > 0 && linkBytes <= LINK_FILES * LINK_FILE_BYTES,
    'the reported link bytes are the ones really copied: ' + linkBytes,
  )

  // ④ THE DENOMINATOR IS WHAT THIS BACKUP REALLY COPIES.
  const last = reports[reports.length - 1]
  assert.ok(
    last.total < THIRD_PARTY_BYTES,
    'the third-party tree is not part of what this backup copies: ' + last.total,
  )
  assert.ok(
    last.total >= LINK_FILES * LINK_FILE_BYTES,
    'but the linked plugin is: ' + last.total,
  )

  // ⑤ AND THE COPY ENDS AT 100%.
  assert.equal(last.bytes, last.total, 'the copy ends at 100%: ' + last.bytes + ' of ' + last.total)
  assert.equal(last.files, last.filesTotal, 'and the file count ends at 100% too')
  const percent = last.total > 0 ? Math.round((last.bytes / last.total) * 100) : 0
  assert.equal(percent, 100, 'the percentage the interface shows is 100')
})

test('the linked plugin really is in the copy, and the third-party one is not', async (t) => {
  const root = tempRoot(t)
  const { profile } = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  const result = await createBackup({ profileDir: profile, backupsDir, includePlugins: true })
  assert.equal(result.ok, true, String(result.error))

  const copied = path.join(result.dir, 'node_modules-link', 'dsh-linked')
  assert.equal(fs.existsSync(path.join(copied, 'f0.js')), true, 'the linked plugin is in the copy')
  assert.equal(fs.existsSync(path.join(copied, 'f' + (LINK_FILES - 1) + '.js')), true, 'all of it')
  assert.equal(
    fs.existsSync(path.join(result.dir, 'node_modules', 'third-party')),
    false,
    'the third-party plugin is NOT copied — it is reinstallable from the lock file',
  )
})
