/**
 * Unit tests for lib/plugin-failure.js — "which plugin did not load?".
 *
 * The parser is the only thing standing between a startup log and a restore, so
 * every branch of it is pinned here: the four line shapes that were really seen
 * in a DSH startup log, the "everything else is ignored" rule (including the
 * process-level dump, which belongs to the watchdog, not to this pass), the
 * stale-line window (`sinceMs`) and the fingerprint that keeps the same old line
 * from being treated as a new incident on every boot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clipText,
  errorFirstLine,
  failureFingerprint,
  FAILURE_KINDS,
  findPluginFailures,
  MAX_ERROR_CHARS,
  mergeFailuresByPlugin,
  parseLogLineTime,
} from '../lib/plugin-failure.js';

/** A real-shaped startup log of a boot in which one entry did not activate. */
const REAL_LOG = [
  '2026-10-31T15:33:37.501Z dsh: loading profile web',
  '2026-10-31T15:33:38.100Z dsh: warning: 1 entry did not activate',
  "2026-10-31T15:33:38.101Z - broken-plugin: failed to import: Error: Cannot find module '@scope/missing-peer'",
  "2026-10-31T15:33:38.102Z     at Module._resolveFilename (node:internal/modules/cjs/loader:1232:5)",
  '2026-10-31T15:33:38.103Z     at Module._load (node:internal/modules/cjs/loader:1078:27)',
  '2026-10-31T15:33:39.000Z dsh: listening on 127.0.0.1:57283',
].join('\n');

test('findPluginFailures recognises the aggregate warning line', () => {
  const failures = findPluginFailures('dsh: warning: 1 entry did not activate');
  assert.equal(failures.length, 1);
  // The line names no plugin: it is a SIGNAL, and a signal is what the report
  // has to show next to the plugin it belongs to.
  assert.equal(failures[0].plugin, null);
  assert.equal(failures[0].kind, FAILURE_KINDS.WARNING);
  assert.match(failures[0].error, /did not activate/);
  assert.match(failures[0].error, /1/);
});

test('findPluginFailures recognises "failed to import" with the plugin name', () => {
  const failures = findPluginFailures(
    "dsh: - broken-plugin: failed to import: Error: Cannot find module '@scope/missing-peer'",
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].plugin, 'broken-plugin');
  assert.equal(failures[0].kind, FAILURE_KINDS.FAILED_TO_IMPORT);
  assert.equal(failures[0].error, "Error: Cannot find module '@scope/missing-peer'");
  assert.equal(failures[0].line, 1);
});

test('findPluginFailures recognises the other import wording and a scoped name', () => {
  const failures = findPluginFailures('dsh: @scope/other-plugin: import failed: SyntaxError: Unexpected token }');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].plugin, '@scope/other-plugin');
  assert.equal(failures[0].kind, FAILURE_KINDS.IMPORT_FAILED);
  assert.match(failures[0].error, /Unexpected token/);
});

test('findPluginFailures recognises "- <plugin>: loading" as "never activated"', () => {
  const failures = findPluginFailures('- slow-plugin: loading');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].plugin, 'slow-plugin');
  assert.equal(failures[0].kind, FAILURE_KINDS.NOT_ACTIVATED);
  assert.match(failures[0].error, /never activated/);
});

test('findPluginFailures reads a multi-line error without swallowing the stack', () => {
  const failures = findPluginFailures('  - stacked-plugin: failed to import:\n    Error: boom\n      at x (y.js:1:1)');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].plugin, 'stacked-plugin');
  assert.equal(failures[0].error, 'Error: boom', 'only the first line of the message is kept');
});

test('findPluginFailures returns an empty array for the empty and the unrelated text', () => {
  assert.deepEqual(findPluginFailures(''), []);
  assert.deepEqual(findPluginFailures('   \n\n\t\n'), []);
  assert.deepEqual(findPluginFailures('dsh: listening on 127.0.0.1:57283'), []);
  assert.deepEqual(findPluginFailures('some plugin: started fine'), []);
  assert.deepEqual(findPluginFailures('Error: cannot find module'), []);
});

test('findPluginFailures ignores the process-level startup dump (that is the watchdog)', () => {
  // This is the REAL dump of a boot that never came up (EADDRINUSE). Recognising
  // it here would make the reported-failure pass fight the watchdog over the
  // same incident.
  const dump = [
    "dsh: startup failed: 2 required plugins did not activate",
    '',
    'Failed plugins (1):',
    '  webserver (required)',
    '    Package: @deepseek-ai/dsh-host-webserver',
    "    Error: listen EADDRINUSE: address already in use 127.0.0.1:3080",
    '        at Server.setupListenHandle (node:net:2328:16)',
    '',
    'Plugins waiting for services (5):',
    '  web-runtime (required)  webServer',
  ].join('\n');
  assert.deepEqual(findPluginFailures(dump), [], 'a boot that does not come up is not a plugin to swap');
});

test('findPluginFailures drops the lines of an older boot (sinceMs)', () => {
  const failures = findPluginFailures(REAL_LOG, {
    // Everything in REAL_LOG happened at 15:33:37-39Z; a boot that started
    // later must not look at it again.
    sinceMs: Date.parse('2026-10-31T15:40:00.000Z'),
  });
  assert.deepEqual(failures, [], 'an old line is not new information');
  const kept = findPluginFailures(REAL_LOG, { sinceMs: Date.parse('2026-10-31T15:33:00.000Z') });
  assert.deepEqual(
    kept.map((failure) => failure.plugin),
    [null, 'broken-plugin'],
    'the aggregate warning and the named plugin of THIS boot are kept',
  );
});

test('findPluginFailures keeps a line whose time cannot be told', () => {
  // A log without a timestamp prefix: throwing the line away would hide the
  // only record of the failure.
  const failures = findPluginFailures('- timeless-plugin: failed to import: Error: nope', {
    sinceMs: Date.parse('2026-10-31T15:40:00.000Z'),
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].at, null);
});

test('findPluginFailures falls back to the log time for a line without a prefix', () => {
  const logAt = Date.parse('2026-10-31T15:33:37.000Z');
  const failures = findPluginFailures('- timeless-plugin: failed to import: Error: nope', { logAt });
  assert.equal(failures[0].at, logAt);
});

test('the fingerprint of the same old line is stable, and a different one differs', () => {
  const text = '- broken-plugin: failed to import: Error: boom\n';
  const first = findPluginFailures(text, { logAt: 1_700_000_000_000 });
  const again = findPluginFailures(text, { logAt: 1_700_000_000_000 });
  assert.equal(first[0].fingerprint, again[0].fingerprint, 're-reading the same log must not create a new incident');
  const other = findPluginFailures('- broken-plugin: failed to import: Error: other', { logAt: 1_700_000_000_000 });
  assert.notEqual(first[0].fingerprint, other[0].fingerprint);
  const otherPlugin = findPluginFailures('- different-plugin: failed to import: Error: boom', { logAt: 1_700_000_000_000 });
  assert.notEqual(first[0].fingerprint, otherPlugin[0].fingerprint);
  const laterLine = findPluginFailures('- broken-plugin: failed to import: Error: boom', { logAt: 1_700_000_900_000 });
  assert.notEqual(first[0].fingerprint, laterLine[0].fingerprint, 'a different boot is a different incident');
});

test('findPluginFailures de-duplicates the same failure inside one text', () => {
  const text = [
    '- twice-plugin: failed to import: Error: boom',
    '- twice-plugin: failed to import: Error: boom',
  ].join('\n');
  const failures = findPluginFailures(text, { logAt: 1_700_000_000_000 });
  assert.equal(failures.length, 1);
});

test('findPluginFailures clips a very long error', () => {
  const long = 'x'.repeat(MAX_ERROR_CHARS * 3);
  const failures = findPluginFailures(`- noisy-plugin: failed to import: Error: ${long}`);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].error.length <= MAX_ERROR_CHARS + 1);
  assert.match(failures[0].error, /…$/, 'a shortened value says so');
});

test('parseLogLineTime reads the ISO prefix and the bracketed clock', () => {
  assert.equal(
    parseLogLineTime('2026-10-31T15:33:37.501Z dsh: something'),
    Date.parse('2026-10-31T15:33:37.501Z'),
  );
  const clock = parseLogLineTime('[15:33:37] dsh: something', Date.parse('2026-10-31T00:00:00Z'));
  assert.ok(clock !== null, 'a bracketed clock is understood');
  assert.equal(parseLogLineTime('dsh: no prefix'), null);
});

test('errorFirstLine and clipText behave', () => {
  assert.equal(errorFirstLine('Error: boom\n  at x'), 'Error: boom');
  assert.equal(errorFirstLine(''), '');
  assert.equal(clipText('  a   b  '), 'a b');
  assert.equal(clipText('abcdef', 4), 'abc…');
});

test('mergeFailuresByPlugin keeps the entry that carries a real error', () => {
  const merged = mergeFailuresByPlugin([
    { plugin: 'p', error: 'the entry was still loading', kind: FAILURE_KINDS.NOT_ACTIVATED, line: 1, fingerprint: 'a' },
    { plugin: 'p', error: 'Error: boom', kind: FAILURE_KINDS.FAILED_TO_IMPORT, line: 2, fingerprint: 'b' },
    { plugin: null, error: 'warning: 1 entry/entries did not activate', kind: FAILURE_KINDS.WARNING, line: 3, fingerprint: 'c' },
  ]);
  assert.equal(merged.length, 2, 'one entry per plugin, plus the aggregate signal');
  const plugin = merged.find((entry) => entry.plugin === 'p');
  assert.equal(plugin.error, 'Error: boom');
  assert.ok(merged.some((entry) => entry.plugin === null), 'the aggregate warning is reported on its own');
});

test('failureFingerprint is a stable short digest', () => {
  const one = failureFingerprint({ plugin: 'p', error: 'Error: boom', at: 1_700_000_000_500 });
  const two = failureFingerprint({ plugin: 'p', error: 'Error: boom', at: 1_700_000_000_900 });
  assert.equal(one, two, 'the same second is the same incident');
  assert.match(one, /^[0-9a-f]{16}$/);
});
