# dsh-autorestart

Restart DeepSeek Harness without losing the work that is currently running.

[![npm version](https://img.shields.io/npm/v/dsh-autorestart?style=flat-square)](https://www.npmjs.com/package/dsh-autorestart)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![dsh-plugin](https://img.shields.io/github/topics/dsh-plugin?style=flat-square)](https://github.com/topics/dsh-plugin)
[![language](https://img.shields.io/badge/language-JavaScript-yellow?style=flat-square)](https://github.com/Eason-22/dsh-autorestart)

Chinese version: [README.zh.md](docs/README.zh.md)

Current version: **0.9.6**

## What it does

Three small things, all around restarting.

**1. The restart is queued.** An agent asks for a restart; the plugin does not cut off the conversations that are still running. It waits until every one of them is idle, restarts the host, and picks the interrupted work back up — the sessions resume and a goal is re-armed. When several conversations ask at once the requests are merged into one restart, and every requester is woken afterwards. A goal-carrying session cannot block the restart forever: its goal is disarmed before the restart (the running round still finishes) and re-armed after it.

**2. It backs up before each restart.** The configuration and the local `link:` plugin directories are saved under `~/.dsh/storages/dsh-autorestart/backups/`. At most `maxBackups` copies are kept (default 2, range 2–10); old and incomplete ones are pruned. A snapshot that cannot be removed (for example because a file inside it is locked) is reported in `backupHygiene.error` rather than silently kept, so the count can briefly exceed the limit.

**3. It clears the login cookies.** Every launch leaves a `dsh-auth-*` entry behind; they pile up until the request header overflows (~16 KB), the server answers 431, and the client can only say `Web authentication failed`. The plugin clears those stale credentials before each restart and records the outcome in `last-cookie-clear.json`.

There is also a **countdown shutdown**: a moon button at the bottom of the sidebar waits for every conversation to finish, counts down on screen, and powers the machine off.

## What it does not do

- It does **not watch the host** and does **not decide** whether a restart came back.
- It does **not restore anything on its own**. The backup is never applied automatically; it is there for you to inspect or roll back by hand. The one exception is the start-at-login supervisor, if you installed it: that separate process rolls the last snapshot back when the host refuses to start.
- There is **nothing left to run by hand**. If the host will not start, use its own crash dialog or reinstall the plugin.

## Tools for the agent

| Tool | What it does |
|---|---|
| `continuum_restart` | Queue a graceful restart (waits for every conversation to be idle) |
| `continuum_status` | Phase, generation, queued requests, which sessions are blocking |
| `continuum_cancel_restart` | Withdraw a queued request (`scope: "mine"` or `"all"`) |
| `continuum_park_goal` | Disarm a goal so a queued restart can proceed |
| `continuum_recover_now` | Retry post-restart recovery immediately |
| `continuum_handoff` | Hand an over-limit session off to a fresh one |
| `continuum_supervisor` | Inspect or install the self-starting supervisor |

## Configuration

The settings page writes these; the defaults are the ones in the code.

| Key | Default | Meaning |
|---|---|---|
| `restartMode` | `app` | `app` = ask the desktop client to relaunch itself; `command` = run your own restart command |
| `restartCommand` | `''` | The command used when `restartMode` is `command`; supports the `{pid}`, `{ppid}` and `{app}` placeholders |
| `settleMs` | `2000` | How long the host must stay quiet before the restart may start |
| `restartGraceMs` | `0` | Extra wait after the last conversation went idle, before the host is really restarted — a dropdown: `0` / `5` / `10` / `20` / `30` / `60` seconds. `0` = no extra wait |
| `queuedGraceMs` | `60000` | How long a queued inbox message may sit before it stops blocking the restart. A **running** conversation always blocks |
| `marketStatusUrl` | `''` | Where the plugin market reports whether it is installing something. Empty = the status route of this host (`/dsh-market/status`). Read only — the probe never writes anything |
| `marketProbeTimeoutMs` | `800` | Upper bound of one market probe in milliseconds (a caller can shorten it, never extend it past 800) |
| `marketProbeIntervalMs` | `1500` | How often the market is asked while a restart is waiting (milliseconds) |
| `marketInstallCooldownMs` | `15000` | How long the restart still waits after the market reported that it finished, to bridge the gap between two operations of its queue (milliseconds) |
| `pluginFilesWatch` | `true` | Also wait while the profile's plugin files are being changed — `package.json`, `pnpm-lock.yaml`, `node_modules` and `node_modules-link`. This covers the installs that never go through the market: a manual `pnpm add`, or the host's own plugin manager |
| `pluginFilesStableMs` | `15000` | How long the plugin files must stay unchanged before the change counts as finished (milliseconds) — a dropdown in the settings page: `5` / `10` / `15` / `30` / `60` seconds. A false positive clears itself after this window |
| `pluginFilesMaxBlockMs` | `300000` | The longest a single file-change episode may hold a restart, so a stuck installation cannot pin the host shut (milliseconds) — a dropdown in the settings page: `5` / `10` / `30` / `60` minutes (the shortest wait is 5 minutes) |
| `forceRestartWhenBusy` | `false` | Interrupt a running conversation instead of waiting. The default never interrupts a session |
| `deferPollMs` | `3000` | Poll interval while waiting for the conversations to go idle |
| `relaunchDelaySeconds` | `2` | How long the detached helper waits before it kills the app |
| `restartWindow` | `background` | How the restart command script is started: `background` = no window at all, and it never takes the focus (the default since this version); `foreground` = the visible console window. An existing profile that already says `foreground` keeps it — only a missing or unreadable value falls back to `background` |
| `backupOnRestart` | `true` | Take a snapshot before every restart |
| `backupIncludePlugins` | `true` | Include the locally linked plugins in that snapshot (~117 MB here, ~3 s). `false` keeps only the configuration files |
| `maxBackups` | `2` | How many snapshots to keep (2–10) |
| `restartCommandTimeoutMs` | `30000` | How long the restart command may run before the plugin stops waiting for it |
| `showSleepButton` | `true` | Show the countdown-shutdown button |
| `sleepCountdownSeconds` | `10` | Countdown length before powering off — a dropdown: `0` / `10` / `20` / `30` / `60` seconds. `10` is only the default for an instance that never set it: a profile that already stores `20` (or `30`, or `60`) keeps that value — nothing is migrated or overwritten |
| `sleepCommand` | `''` | Override the power-off command |
| `resumeOnBoot` | `true` | Resume interrupted sessions after a restart |
| `recoveryDelayMs` | `6000` | Wait before the first resume attempt |
| `maxResumeAttempts` | `2` | Resume attempts per session, counted across boots |
| `maxSessions` | `4` | How many sessions are resumed per boot |
| `continuationText` | `''` | Override the continuation prompt text |
| `stateFile` | `''` | Path of the checkpoint file. Empty = `<DSH_HOME>/storages/dsh-autorestart/state.json` |
| `autoReloadPage` | `true` | Reload the web page after a restart |
| `blockManualRestart` | `true` | Refuse an agent that tries to kill or relaunch DSH by hand, and point it at `continuum_restart` instead |
| `healthPath` | `/__dsh_autorestart/health` | Health check route: the boot id, the pid, the phase and the self-check flags |
| `enabled` | `true` | Turns the whole plugin off |
| `watchEnabled` | `true` | The **plugin watch**: after the host settles, compare what the loaded plugins provide with the previous reading and report what is no longer there. A report, not an automatic repair |
| `watchDelayMs` | `8000` | How long the watch waits after boot before it reads |
| `deferSoftMs`, `deferHardMs`, `deferPolicy` | `300000` / `900000` / `auto` | **Deprecated — read but completely ignored.** A pending restart has no deadline |

Four of the keys above — `restartWindow`, `pluginFilesWatch`, `pluginFilesStableMs` and `pluginFilesMaxBlockMs` —
have a control in the settings page, in the **More settings** block. The four `market*` keys are configuration
keys without a settings-page control; the **More settings** subsection below says which is which.

### The settings page

Every section is one row per thing: the title is on the left, the control is on the right, and the explanation
is folded behind **Show details** (`查看说明`) so the page stays readable. A row that is switched off in its own
title is a **sliding switch**, not a checkbox. The control column is wide enough (260 px, dropdowns at least
200 px) that a long choice such as *Background (no window at all, and it never takes the focus; the default)*
is shown in full instead of being squeezed.

A row that only means something while the row above it is on is drawn as that row's **subordinate**: indented
under it, behind a faint vertical line, and greyed out (its control cannot be used) when the parent is off.

| Section | What is in it |
|---|---|
| **Restart settings** | The wait before the restart, **Back up before a restart** with **Include the installed plugins in the backup** as its subordinate row, the backup limit, and the **Backup info** fold |
| **Shutdown settings** | The countdown of the graceful shutdown |
| **More settings** | A block of its own, **closed by default**: how the restart command script runs, and the plugin-folder watchdog |
| **Start at login** | How "start at login" works on *this* machine, with copyable commands. The plugin never changes your system configuration for you. Not shown on the desktop client — it relaunches itself, so there is nothing to install |
| **Something is wrong** | The diagnostics and a **Report a problem** button that copies them and opens a pre-filled GitHub issue. The diagnostics carry no access token and no secrets |

**Backup info** is the fold that explains what has been backed up: how many copies there are and what they take
on disk, when a copy is taken, the list with a button that rolls back to that one copy, and the path. It is
**closed by default** — except on a boot the system had to restore, where it opens itself and says so on its
title, because an intervention is the one thing that must not be hidden. It used to be titled *Show details*
like every other row's explanation, which read as "one more way to open the explanation of this row"; it has a
name of its own now, and its contents are unchanged.

The **last restart** row is gone from the page: which launcher really ran (`wscript`, the PowerShell fallback,
the foreground window) is still reported by the host — it is in the status payload and in the diagnostics — it
simply does not take up room on the settings page any more.

### More settings (「更多设置」)

A block of its own, after **Shutdown settings** and before **Something is wrong**, **closed by default** —
until you click the title you only see the title.

| Row (as it reads on the page) | Key | Control |
|---|---|---|
| **How the restart command script runs** | `restartWindow` | Dropdown: *Foreground (a window appears briefly)* / *Background (no window at all, and it never takes the focus; the default)* |
| **Do not restart or shut down while plugins are installing** | `pluginFilesWatch` | Sliding switch |
| **How many seconds without a file change mean the plugin is installed** | `pluginFilesStableMs` | Dropdown: 5 / 10 / 15 / 30 / 60 seconds |
| **How long to wait at most for the plugin install** | `pluginFilesMaxBlockMs` | Dropdown: 5 / 10 / 30 / 60 minutes |

The last two are **subordinate to the switch above them**: they are drawn indented under it, and they are
greyed out (their dropdown cannot be used) while that switch is off. Their own sentence says so as well —
"When the switch above is off, these two do nothing."

A value that is not one of the offered choices is not rewritten: it shows up in the dropdown as **Current
value**, so an existing profile keeps working and nothing changes until you pick a choice.

**Background is the default since this version.** The restart command script used to run in the foreground, in
a console window that stayed visible for the length of the grace delay. An existing profile that already says
`foreground` keeps the foreground — the default only fills in a missing or unreadable value. Nothing else about
the restart changed: the wait, the idle gate, the kill of the whole process tree, the cookie clear and the
relaunch happen in the same order. If this machine does not allow such little scripts to run, a hidden
PowerShell runs the same command instead and the reason is written into the restart report.

The four **market probe** keys — `marketStatusUrl`, `marketProbeTimeoutMs`, `marketProbeIntervalMs` and
`marketInstallCooldownMs` — have **no control in the settings page**. They are configuration keys: set them
in the profile row or through the configuration API. The defaults in the table above are the ones the probe
actually uses.

## What the restart waits for

A restart is queued, not cut through. The gate waits for the work that is still going on — and the graceful
shutdown (the moon button) waits for the same three things plus one more, because a shutdown cuts an
installation in half even more surely than a restart does.

| It waits for | How it is decided | What you see |
|---|---|---|
| **Every conversation to be idle** | The plugin asks the host which sessions are still running. A queued (unclaimed) inbox message blocks for at most `queuedGraceMs`; a **running** conversation always blocks | The restart stays queued; `continuum_status` names the sessions that block it |
| **The plugin market to be done** | A read-only `GET` of the market's status route (`/dsh-market/status`): `busy` or `active` means "installing". An answer that cannot be read — a timeout, a 404, a non-2xx answer, a body that is not an object — means **"nothing is being installed"**, and the restart goes on exactly as it did before this feature existed | The restart capsule shows a pill ("waiting for the plugin market to finish installing"); the sidebar dot's tooltip says the same thing |
| **The plugin files to settle** | The profile's `package.json`, `pnpm-lock.yaml`, `node_modules` and `node_modules-link` are fingerprinted; while the fingerprint keeps moving, the restart waits. This catches the installs that never go through the market: a manual `pnpm add`, or the host's own plugin manager | The restart capsule shows a pill ("waiting for a plugin install to finish") |
| **A goal that is still going** (the shutdown only) | A goal counts as running while it is still **armed**, has not reached a terminal phase (`paused` / `blocked` / `complete` / `completed` / `done`) and still has rounds left. A paused goal, a disarmed goal and a finished goal never hold the machine | The shutdown is held and names the goal that is still working |

Both of the installation waits have an upper bound, so a broken signal cannot hold the host for ever:

- **The market**: an "installing" answer is remembered for at most `marketInstallCooldownMs` (15 s by default),
  and only while the market cannot be reached at all. Past that window the market counts as idle.
- **The plugin files**: one episode of file changes holds a restart for at most `pluginFilesMaxBlockMs`
  (5 minutes by default), and it only counts as "changing" while the last change is younger than
  `pluginFilesStableMs` (15 s by default).

Both probes are read-only: one `GET`, no body, no retry, nothing is written.

## Where it writes

| Path | What |
|---|---|
| `~/.dsh/storages/dsh-autorestart/state.json` | Boot generation, phase, per-session restart state |
| `~/.dsh/storages/dsh-autorestart/backups/<stamp>/` | `config/` + `node_modules-link/` of one snapshot |
| `~/.dsh/storages/dsh-autorestart/last-cookie-clear.json` | How many credentials the last clear removed |
| `~/.dsh/storages/dsh-autorestart/access.json` | The loopback port and token the plugin listens on |

## About that backup

It holds the **configuration files** (`package.json`, `cordis.patch.yml`, `pnpm-lock.yaml`) and the **local `link:` plugin directories**. Plugins installed from npm are not in it — they can be reinstalled from `package.json` + `pnpm-lock.yaml`. So it is good for "what did this look like before" and "put this one plugin version back", not a one-click reinstall.

## Platforms

| Platform | Status |
|---|---|
| Windows desktop client (`restartMode: app`) | Verified on the real machine |
| Hosted `dsh web` on WSL with systemd (`restartMode: command`) | Verified on a real instance |
| Hosted `dsh web` on Windows | Not verified |
| WSL without systemd, native Linux | Not verified |

macOS, a remote SSH session without a graphical session and containers are **out of scope** — not
tested, and not supported. The per-capability matrix is in
[docs/platform-matrix.md](docs/platform-matrix.md).

### The floating overlay in hosted `dsh web` — read this before expecting it

The restart / sleep / plugin-failure surfaces are drawn in the **client** slot `shell.overlay` —
"a frame-wide floating layer, above every column and outside their scroll containers". Both facts
below were checked against the shipped packages and a live client, not assumed:

* The slot is declared by the shared workspace UI package
  (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts`), which is what the hosted web UI
  mounts — so the slot itself is **not** desktop-only.
* On the desktop client all three of our entries are registered and `active: true`:
  `autorestart-plugin-failure` (order 9), `autorestart-restart-overlay` (order 55),
  `autorestart-sleep-overlay` (order 60). Verified through the live client Slot inspection.

**On hosted web the restart has fewer phases, and one of them does not exist at all.** Measured on
a real instance (0.9.5, `restartMode: command`), sampling `/health?state=1` every 300 ms across a
full restart — 121 frames:

```
waiting      17 frames (~4 s)
DOWN         1 frame          old process gone
restarting    1 frame
DOWN         4 frames         process swap
back          1 frame
DOWN         3 frames
```

**There is no `snapshotting` frame.** On the desktop the backup happens in the old process before it
quits, and that is what the overlay reports. Hosted web does it the other way round: the old process
only goes `waiting → restarting`, and the backup is written by the **new** process at boot, surfaced
as `firstInstallBackup`. So the "backing up, plugins included" sentence has **no phase to attach
to** on the web — it is not hidden, it does not happen there.

The backup itself is still real and still includes plugins on web — verified on the same run:

```
manifest.json  stamp: 2026-11-09T09-41-41-335Z  atLocal: 2026-11-09T17:41:41+08:00
               includePlugins: true   profileDir: /home/fg/.dsh/profiles/web
```

**Treat the restart overlay as a desktop-client feature** and do not plan around seeing it in a
browser. This is a property of "the page is not the host", not a defect fixable from the plugin
side. The restart stays fully visible in the HTTP surface on both platforms —
`GET /__dsh_autorestart/health?state=1` reports the live `restartPhase` and the finished
`firstInstallBackup` — so a scripted check observes what a browser tab cannot.

## Install

From npm:

```
dsh plugin install dsh-autorestart
```

From source:

```
git clone https://github.com/Eason-22/dsh-autorestart.git
cd dsh-autorestart
dsh plugin --profile desktop add /absolute/path/to/dsh-autorestart
```

Inside DSH the equivalent is the `plugin_manager` tool:

```
plugin_manager install_bundle  target = <absolute path to the package>
```

The plugin needs no configuration to work: the defaults queue restarts, take a snapshot before each
one, and clear the stale cookies.

## Uninstall

Remove the `dsh-autorestart` row from your profile's bundle list — in the Plugin Manager of the UI,
or with the `dsh plugin` CLI:

```
dsh plugin remove dsh-autorestart
```

The snapshots under `~/.dsh/storages/dsh-autorestart/backups/` are yours; they are not deleted for you.

## Tests

The plugin ships its own test suite in `plugins/dsh-autorestart/test/`. There is no `node` on `PATH` in the
desktop environment, so the repository ships a script that runs the suite with the bundled Node:

```
pwsh -NoProfile -File plugins/dsh-autorestart/scripts/run-tests.ps1
```

On Windows PowerShell the same thing is:

```
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/dsh-autorestart/scripts/run-tests.ps1
```

**Do not hand a directory to `node --test`.** Node 24 and newer treat the positional arguments of `--test` as
glob patterns, so `node --test plugins/dsh-autorestart/test` fails with `MODULE_NOT_FOUND`. The script passes
the glob `plugins/dsh-autorestart/test/*.test.mjs` instead.

All **1189** test cases pass (1189 passed, 0 failed, 0 skipped) — measured on 2026-11-11 with the bundled
Node: `tests 1189 / pass 1189 / fail 0`, exit code 0.

## License

MIT
