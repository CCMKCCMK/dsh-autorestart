# dsh-autorestart

Restart DeepSeek Harness without losing the work that is currently running.

[![npm version](https://img.shields.io/npm/v/dsh-autorestart?style=flat-square)](https://www.npmjs.com/package/dsh-autorestart)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![dsh-plugin](https://img.shields.io/github/topics/dsh-plugin?style=flat-square)](https://github.com/topics/dsh-plugin)
[![language](https://img.shields.io/badge/language-JavaScript-yellow?style=flat-square)](https://github.com/Eason-22/dsh-autorestart)

Chinese version: [README.zh.md](docs/README.zh.md)

Current version: **0.9.0**

## What it does

Three small things, all around restarting.

**1. The restart is queued.** An agent asks for a restart; the plugin does not cut off the conversations that are still running. It waits until every one of them is idle, restarts the host, and picks the interrupted work back up — the sessions resume and a goal is re-armed. When several conversations ask at once the requests are merged into one restart, and every requester is woken afterwards. A goal-carrying session cannot block the restart forever: its goal is disarmed before the restart (the running round still finishes) and re-armed after it.

**2. It backs up before each restart.** The configuration and the local `link:` plugin directories are saved under `~/.dsh/storages/dsh-autorestart/backups/`. At most `maxBackups` copies are kept (default 2, range 2–10); old and incomplete ones are pruned.

**3. It clears the login cookies.** Every launch leaves a `dsh-auth-*` entry behind; they pile up until the request header overflows (~16 KB), the server answers 431, and the client can only say `Web authentication failed`. The plugin clears those stale credentials before each restart and records the outcome in `last-cookie-clear.json`.

There is also a **countdown shutdown**: a moon button at the bottom of the sidebar waits for every conversation to finish, counts down on screen, and powers the machine off.

## What it does not do

- It does **not watch the host** and does **not decide** whether a restart came back.
- It does **not restore anything on its own**. The backup is never applied automatically; it is there for you to inspect or roll back by hand.
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
| `forceRestartWhenBusy` | `false` | Interrupt a running conversation instead of waiting. The default never interrupts a session |
| `deferPollMs` | `3000` | Poll interval while waiting for the conversations to go idle |
| `relaunchDelaySeconds` | `2` | How long the detached helper waits before it kills the app |
| `backupOnRestart` | `true` | Take a snapshot before every restart |
| `backupIncludePlugins` | `true` | Include the locally linked plugins in that snapshot (~117 MB here, ~3 s). `false` keeps only the configuration files |
| `maxBackups` | `2` | How many snapshots to keep (2–10) |
| `restartCommandTimeoutMs` | `30000` | How long the restart command may run before the plugin stops waiting for it |
| `showSleepButton` | `true` | Show the countdown-shutdown button |
| `sleepCountdownSeconds` | `20` | Countdown length before powering off — a dropdown: `0` / `10` / `20` / `30` / `60` seconds |
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

### The settings page

Four groups, all reachable from the settings page:

| Group | What is in it |
|---|---|
| **Restart settings** | The wait before the restart, the two backup switches, the backup limit, and the list of the snapshots — each with its time and a button that rolls back to that one copy |
| **Shutdown settings** | The countdown of the graceful shutdown |
| **Start at login** | How "start at login" works on *this* machine, with copyable commands. The plugin never changes your system configuration for you |
| **Something is wrong** | The diagnostics and a **Report a problem** button that copies them and opens a pre-filled GitHub issue. The diagnostics carry no access token and no secrets |

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

The plugin ships its own test suite in `plugins/dsh-autorestart/test/`. Run it with the bundled Node:

```
node --test plugins/dsh-autorestart/test
```

All **939** test cases pass (939 passed, 0 failed, 0 skipped).

## License

MIT
