/**
 * THE DESKTOP SHORTCUT MUST WEAR THE ICON THIS BUILD SHIPS (2026-11-03).
 *
 * The real-machine report: the `.lnk` kept pointing at `shortcut-icon-9c245e5b.ico`
 * (the old flame) while the plugin's health said `shortcut-icon-1902bb15.ico`, and a
 * host restart changed nothing - the file is written ONLY when the user presses the
 * button, so it never follows the plugin.
 *
 * `syncShortcutIcon()` closes that: compare the icon the `.lnk` names with the icon
 * this build would use, rewrite only when they differ, keep `TargetPath` as it was.
 * All four tests here run with injected readers/writers, so no real desktop file is
 * touched.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { readShortcutLink, syncShortcutIcon } from '../lib/rescue-paths.js'

/** A fake `.lnk` that remembers what was written to it. */
function fakeLink({ targetPath = 'C:\\state\\restore-profile.cmd', iconLocation = '' } = {}) {
  const state = { targetPath, iconLocation, writes: 0 }
  return {
    state,
    read: () => ({ ok: true, exists: true, targetPath: state.targetPath, iconLocation: state.iconLocation }),
    write: ({ linkPath, targetPath, iconPath }) => {
      state.writes += 1
      state.targetPath = targetPath
      state.iconLocation = iconPath + ',0'
      state.linkPath = linkPath
      return { ok: true, path: linkPath }
    },
  }
}

test('a shortcut pointing at an older icon is repointed once, and keeps its target', () => {
  const link = fakeLink({ iconLocation: 'C:\\state\\shortcut-icon-9c245e5b.ico,0' })
  const wanted = 'C:\\state\\shortcut-icon-1902bb15.ico'

  const result = syncShortcutIcon({ linkPath: 'C:\\desk\\x.lnk', iconPath: wanted, readLink: link.read, createLink: link.write })

  assert.equal(result.changed, true, 'the file really was rewritten')
  assert.equal(result.reason, 'icon-repointed')
  assert.equal(link.state.writes, 1, 'exactly one write')
  assert.equal(link.state.iconLocation, wanted + ',0', 'and it now names the icon this build ships')
  assert.equal(
    link.state.targetPath,
    'C:\\state\\restore-profile.cmd',
    'TargetPath is preserved byte for byte - the button still launches the restore',
  )
})

test('a shortcut that already wears the right icon is NOT touched (idempotent)', () => {
  const wanted = 'C:\\state\\shortcut-icon-1902bb15.ico'
  const link = fakeLink({ iconLocation: wanted + ',0' })

  const first = syncShortcutIcon({ linkPath: 'C:\\desk\\x.lnk', iconPath: wanted, readLink: link.read, createLink: link.write })
  const second = syncShortcutIcon({ linkPath: 'C:\\desk\\x.lnk', iconPath: wanted, readLink: link.read, createLink: link.write })

  assert.equal(first.changed, false, 'nothing to do')
  assert.equal(first.reason, 'already-current')
  assert.equal(second.changed, false)
  assert.equal(link.state.writes, 0, 'a normal start must not write the desktop file at all')
})

test('no shortcut on the desktop is left alone - creating one is the button\'s job', () => {
  let writes = 0
  const result = syncShortcutIcon({
    linkPath: 'C:\\desk\\missing.lnk',
    iconPath: 'C:\\state\\shortcut-icon-1902bb15.ico',
    readLink: () => ({ ok: false, exists: false, targetPath: '', iconLocation: '', error: 'not found' }),
    createLink: () => { writes += 1; return { ok: true } },
  })

  assert.equal(result.changed, false)
  assert.equal(result.reason, 'no-shortcut')
  assert.equal(writes, 0, 'boot must not put files on the desktop behind the user\'s back')
})

test('the icon name is never hard-coded: two different icons produce two different targets', () => {
  const a = fakeLink()
  const b = fakeLink()

  syncShortcutIcon({ linkPath: 'C:\\desk\\x.lnk', iconPath: 'C:\\state\\shortcut-icon-aaaaaaaa.ico', readLink: a.read, createLink: a.write })
  syncShortcutIcon({ linkPath: 'C:\\desk\\x.lnk', iconPath: 'C:\\state\\shortcut-icon-bbbbbbbb.ico', readLink: b.read, createLink: b.write })

  assert.equal(a.state.iconLocation, 'C:\\state\\shortcut-icon-aaaaaaaa.ico,0')
  assert.equal(b.state.iconLocation, 'C:\\state\\shortcut-icon-bbbbbbbb.ico,0')
  assert.notEqual(a.state.iconLocation, b.state.iconLocation, 'the writer follows whatever path it is handed')
})

test('a shortcut whose target cannot be read is not rewritten', () => {
  let writes = 0
  const result = syncShortcutIcon({
    linkPath: 'C:\\desk\\x.lnk',
    iconPath: 'C:\\state\\shortcut-icon-1902bb15.ico',
    readLink: () => ({ ok: true, exists: true, targetPath: '', iconLocation: 'C:\\state\\shortcut-icon-9c245e5b.ico,0' }),
    createLink: () => { writes += 1; return { ok: true } },
  })

  assert.equal(result.changed, false)
  assert.equal(result.reason, 'unreadable-target')
  assert.equal(writes, 0, 'without the target there is nothing safe to preserve')
})

test('readShortcutLink normalizes whatever the shell answers', () => {
  const read = readShortcutLink({
    linkPath: 'C:\\desk\\x.lnk',
    readLink: () => ({ ok: true, exists: true, targetPath: 'T', iconLocation: 'I' }),
  })
  assert.deepEqual(
    { ok: read.ok, exists: read.exists, targetPath: read.targetPath, iconLocation: read.iconLocation },
    { ok: true, exists: true, targetPath: 'T', iconLocation: 'I' },
  )

  const failed = readShortcutLink({ linkPath: 'C:\\desk\\x.lnk', readLink: () => { throw new Error('no shell') } })
  assert.equal(failed.ok, false)
  assert.equal(failed.exists, false)
  assert.match(String(failed.error), /no shell/)
})
