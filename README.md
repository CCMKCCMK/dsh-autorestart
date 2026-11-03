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

**2. It backs up before each restart.** Configuration and the local plugin directories are saved under `~/.dsh/storages/dsh-autorestart/backups/`. At most `maxBackups` copies are kept (default 2, range 2–10); old and incomplete ones are pruned.

**3. It clears the login cookies.** Every launch leaves a `dsh-auth-*` entry behind; they pile up until the request header overflows (~16 KB), the server answers 431, and the client can only say `Web authentication failed`. The plugin clears those stale credentials before each restart and records the outcome in `last-cookie-clear.json`.

There is also a **countdown shutdown**: a moon button at the bottom of the sidebar waits for every conversation to finish, counts down on screen, and powers the machine off.

## What it does not do

- It does **not watch the host** and does **not decide** whether a restart came back.
- It does **not restore anything on its own**. The backup is never applied automatically; it is there for you to inspect or roll back by hand.
- There are **no rescue scripts**. If the host will not start, use its own crash dialog or reinstall the plugin.

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
| `restartCommand` | `''` | The command used when `restartMode` is `command` |
| `settleMs` | `2000` | How long the host must stay quiet before the restart may start |
| `restartGraceMs` | 10000 | Grace window added after the last conversation went idle |
| `queuedGraceMs` | 60000 | How long a queued inbox message may sit before it stops blocking |
| `forceRestartWhenBusy` | `false` | Interrupt a running conversation instead of waiting |
| `blockManualRestart` | `true` | Refuse ad-hoc kills while a restart is in flight |
| `backupOnRestart` | `true` | Take a snapshot before every restart |
| `backupIncludePlugins` | `true` | Include the installed plugin tree in that snapshot |
| `maxBackups` | `2` | How many snapshots to keep (2–10) |
| `resumeOnBoot` | `true` | Resume interrupted sessions after a restart |
| `recoveryDelayMs` | `6000` | Wait before the first resume attempt |
| `maxResumeAttempts` | `2` | Resume attempts per session |
| `maxSessions` | `4` | How many sessions are resumed in parallel |
| `autoReloadPage` | `true` | Reload the web page after a restart |
| `supervisorMode` | `auto` | `auto` / `installed` / `external` / `off` — who is expected to start the host |
| `showSleepButton` | `true` | Show the countdown-shutdown button |
| `sleepCountdownSeconds` | `10` | Countdown length before powering off |
| `sleepCommand` | `''` | Override the power-off command |

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

## Install

```
dsh plugin add dsh-autorestart
```

The plugin needs no configuration to work: the defaults queue restarts, snapshot before each one, and clear the stale cookies.

## Uninstall

```
dsh plugin remove dsh-autorestart
```

The snapshots under `~/.dsh/storages/dsh-autorestart/backups/` are yours; they are not deleted for you.

## License

MIT
