# dsh-autorestart

Restart DeepSeek Harness without losing the work that is currently running.

[![npm version](https://img.shields.io/npm/v/dsh-autorestart?style=flat-square)](https://www.npmjs.com/package/dsh-autorestart)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![dsh-plugin](https://img.shields.io/github/topics/dsh-plugin?style=flat-square)](https://github.com/topics/dsh-plugin)
[![language](https://img.shields.io/badge/language-JavaScript-yellow?style=flat-square)](https://github.com/Eason-22/dsh-autorestart)

Chinese version: [README.zh.md](docs/README.zh.md)

## What it does

`dsh-autorestart` turns a DeepSeek Harness restart into a resumable event instead of a dead end.

**New in 0.7.0** — it now also knows *how it was started*: the desktop client, somebody else's
supervisor (a shell script, systemd, a container, pm2, a Windows scheduled task), or a bare process
nobody manages. It never starts a second DSH next to a running one, and when it cannot tell it does
nothing instead of guessing a command. The settings page shows what is really inside the
pre-restart backups (count, local time, size, path), and carries a **Report a problem** entry that
copies the diagnostics and opens a pre-filled GitHub issue.

An agent can request a graceful restart. The plugin waits until every conversation is idle and the
host has been quiet for the settle window, then it restarts the host. Once the host is back, the
interrupted sessions resume automatically: a session that owns a durable goal gets that goal
re-armed so the goal round driver starts the next round, and a session without a goal receives one
continuation message that asks it to pick up where it left off.

Several sessions can request a restart at the same time. Those requests are coalesced into **one**
restart, and every requester is woken afterwards — not only the last one.

A goal-driven session would otherwise keep the restart waiting forever, because its goal starts the
next round as soon as the agent goes idle. The plugin therefore **disarms** such a goal before the
restart: the round that is running right now still finishes normally and nothing is lost, but no new
round starts, so the session goes idle and the restart can proceed. The goal is re-armed after the
restart and continues.

The browser shows the state: a compact "pending restart" pill on the left side of the input toolbar
and a small dot next to the session title in the sidebar. The pill carries ONE short line (12
characters at most: `待重启 · 等待 2 个会话` / `pending restart · waiting for 2 session(s)`) — a
conversation and its own subagents count as one. Everything else lives one layer deeper: the long
sentence is the tooltip, the count and the way out are in the floating panel the pill opens, and the
**stage** of a real restart (backing up / restarting / back) is shown on a **centered overlay card in
the middle of the shell** — never in the composer row, where a longer sentence used to be cut off.
The dot breathes when the restart is about to fire.

Every blocker says **what it is**: a conversation is named by its own title, and a **subagent** is
named after the conversation that created it ("Subagent of *that* conversation"). A raw session id is
never shown to the user.

Before every restart the plugin snapshots the profile, so a restart that leaves the host unable to
boot is rolled back automatically — see
[Pre-restart backup and automatic rollback](#pre-restart-backup-and-automatic-rollback).

The same "wait until everything is quiet" idea is also available as a **graceful shutdown**: a moon
button at the very bottom of the left sidebar (right next to Settings) waits for every conversation
to be idle, counts down on screen (a floating card with a huge number and a small whale) and then
switches the **real host machine** off — see [Graceful shutdown](#graceful-shutdown-收工关机).

Two safety gates protect the restart. The host checks that no conversation is busy, and the detached
helper checks the same gate over loopback immediately before it kills the process, so a turn that
starts in between is never killed.

## Supported platforms

One question decides everything: **which environment below are you in, and has anybody actually run it there?**

| Your machine | Run on a real machine | What you must know |
| --- | --- | --- |
| **Windows desktop** (the DeepSeek Harness client) | **yes — verified** | nothing to configure — `restartMode: app` is the default |
| **`dsh web` on WSL, with `systemd --user`** | **yes — verified** | you must set `restartMode: command` **and** a `restartCommand` that really restarts this host; remember the shutdown button switches off the **whole Windows machine**, not the distro |
| **`dsh web` on WSL, without `systemd --user`** | **not yet** | the same configuration as the row above; the automatic rollback falls back to a detached process of the plugin's own |
| **`dsh web` on Windows** | **not yet** | the same configuration as the row above |
| **`dsh web` on Linux** (not WSL) | **not yet — there is no such machine here** | the same configuration as the row above |

The last three rows are **implemented and covered by unit tests, but no one has run them on a real host**;
they take the same code path as the verified WSL row (`restartMode: command` plus your own restart
command), yet "it should work that way" is not "it was verified there", so it is not claimed. The
**with/without `systemd --user`** split changes only *how* the automatic rollback is triggered (a systemd
user timer versus a detached background process of the plugin's own); everything else is the same. The
settings page always says which one your machine got, and it never promises a rollback it cannot deliver.

### Out of scope — not tested, not supported

These three are **not** in the supported set. The plugin may appear to run there, but nothing is
promised: no real-machine test exists, and some abilities simply cannot be delivered.

| Environment | Status | What you lose |
| --- | --- | --- |
| **macOS** | **not tested / not supported** | no desktop rescue shortcut; the automatic rollback degrades to a background process of the plugin's own (and on a machine without `setsid` it degrades further to *no rollback at all*); the shutdown countdown has never been verified on a real Mac |
| **Remote SSH with no graphical session** | **not tested / not supported** | no desktop and no desktop rescue entry, so the only way back in is a `.sh` script — which means you must already be able to SSH in; the "start at login" advice starts the **host**, not your SSH session; the session resume only happens once *somebody* starts the host again |
| **Containers** (Docker / Compose / Kubernetes) | **not tested / not supported** | no "start at login" at all (the orchestrator owns that); the automatic rollback degrades to a background process of the plugin's own (often no `setsid` in a slim image → *no rollback*); the shutdown countdown is **not** container-aware — it really tries to power off the host, so do not press it in a container; a rebuilt container may take the checkpoint and the backups with it |

If you are on one of those three, install it as an experiment at your own risk, and use
`scripts/restore-profile.sh` / `scripts/emergency-disable.sh` as your way out.

The complete per-capability matrix — every ability × every environment, each cell with the
`file:line` it rests on — is in [docs/platform-matrix.md](docs/platform-matrix.md).

## The whole thing in one page (ordinary users can stop here)

### Why a restart does not lose your work

The plugin turns a restart into a **resumable** event, and the order never changes:

1. **The session state is written to disk first** — what every conversation was doing and which
   goals were still armed goes into a checkpoint on disk;
2. **It queues until every conversation is idle** — whoever is still running is waited for;
3. **The process is replaced** — the old one exits, a new one comes up (the desktop app relaunches
   itself; the hosted web client is covered below);
4. **The new process checks itself** — four things: is the port up, are the routes there, did the
   plugin load, did the sessions resume;
5. **If it did not come up, it rolls back** — a snapshot (configuration + installed plugins) whose
   identity is `known-good` (it was taken before a restart that then came up) is put back, and the
   verdict of that restart is written down honestly.
   **When there is not a single copy with that identity**, it does not put "the newest one" in its
   place: it reports plainly that there is no restore point carrying an identity.

So "the restart lost my work" becomes "the restart carried on": you do not have to type "continue".

### Two shapes of DSH, each minding its own business

| | Desktop client | Hosted web client (`dsh web`) |
|---|---|---|
| Who brings it back | **the app itself** (it closes itself and opens itself again) | it first asks "who started me?" |
| Should a system service be installed | **no** — installing one makes it start **twice**: one more DSH at every login | only when *nobody* manages it |
| Somebody else already manages it (a supervisor script / systemd / a container / pm2 / a Windows scheduled task…) | n/a | **it only exits gracefully** and lets that supervisor bring it back (it does not start a second one) |
| It cannot tell who started it | n/a | **it does nothing and guesses no command** — "I cannot tell" beats starting a second copy next to the first |

### "Start at login": the plugin gives advice, it does not change your system

The plugin **never** changes your system configuration and **never** registers a startup entry for
you. It explains in the settings page how "start at login" works on *this* machine; the commands can
be copied, and whether you use them is your call.

| Your situation | What it recommends | Note |
|---|---|---|
| `dsh web` on Windows | start at login: a scheduled task first (no administrator rights); if this machine refuses that, a `.cmd` in the startup folder | the record runs a **real node** + the supervisor script, not the DSH client itself (that would open a second DSH at every login) |
| Linux (not WSL) | a systemd user service | that is **start after login**; **start at boot** (without a login) needs the linger enabled once |
| WSL with systemd | the same: a systemd user unit + the linger | same |
| WSL without systemd | there is no "start at login" at all. Two ways out: ① turn systemd on inside WSL (change the distribution's configuration and restart the subsystem); ② let the Windows side start the distribution with a scheduled task or a startup-folder entry (much closer to a real boot autostart) | the plugin **never** changes your distribution's configuration for you, and it never recommends a container-orchestration setup inside WSL (the orchestrator of WSL is Windows itself) |
| container / k8s | the orchestrator does it (`restart: always` and friends) | there is no "start at login" inside a container |

**"Start after login" and "start at boot" are not the same thing**: the first waits for you to log
in, the second happens when the machine comes up (and needs the linger enabled once). The plugin
writes that sentence and the matching command into the settings page.

### If DSH does not come up

**First work out which situation you are in**: if the whole environment is broken (a changed
configuration, another plugin, a bad upgrade) → go back to the last good state; if **only this
plugin** is suspect → take this plugin out instead.

**And use the scripts of YOUR host** — a Linux machine has no `.cmd` file, and a Windows machine has
no `.sh`. Pick by the host you are sitting in front of, not by a platform list:

| Your host | back to the last good state | take this plugin out |
|---|---|---|
| **Windows** (the desktop app, `dsh web` on Windows) | double-click `scripts/restore-profile.cmd` | double-click `scripts/emergency-disable.cmd` |
| **WSL / Linux** (`dsh web`) | `sh scripts/restore-profile.sh` | `sh scripts/emergency-disable.sh` |
| **macOS** | `sh scripts/restore-profile.sh` | `sh scripts/emergency-disable.sh` |

On macOS the same two POSIX `sh` scripts apply; they have never been run on a real Mac, so they are
untested and nothing is promised.

Two scripts per platform, and they do different jobs:

- **`restore-profile.cmd` / `restore-profile.sh` — back to the last good state.** It puts the
  newest snapshot that carries a manifest back over the profile, and leaves the broken one behind
  as `profile.broken-<timestamp>` (moved aside, not deleted). It does not restart DSH for you.
- **`emergency-disable.cmd` / `emergency-disable.sh` — take this plugin out and change nothing
  else.** It removes only `dsh-autorestart` from the profile's bundle list and keeps a backup of
  the file.

**Which one:** "back to the last good state" → `restore-profile`; "I only suspect this plugin" →
`emergency-disable`. The boundaries (the profile directory has to exist, a snapshot with a
manifest is required, DSH is never restarted for you, the `broken-` folder stays) are written down
in [`scripts/README.md`](scripts/README.md).

**What each platform can do** (and what it cannot) is spelled out in
[`docs/platform-matrix.md`](docs/platform-matrix.md) — the settings page shows the paths of the
scripts that really exist on the machine you are on.

**The desktop rescue shortcut (Windows only).** The settings page can put a rescue shortcut on the
desktop; double-clicking it runs `restore-profile.cmd`. **Its icon is the plugin's own
`assets/icon.ico` — not DSH's executable.** That is deliberate: on a desktop where DSH will not
start, a shortcut wearing DSH's face reads as "this is the program", which is exactly the thing
that is broken. When an install ships no icon file, the `.lnk` is still created — it simply gets no
`IconLocation` instead of borrowing some other program's face, and nothing is generated at runtime.
Every other platform gets no desktop shortcut at all; the settings page gives a copyable
restore-script command instead.

### What has really been tested

| How it was started | Tested on a real machine? | Evidence |
| --- | --- | --- |
| started by a shell supervisor script (`supervise-*.sh` and friends) | **yes** | recognised on a real machine as external, the evidence points at that script process, and **installing a second supervisor was refused** |
| started by hand in a terminal (foreground) | **partly** | on a real machine it recognised itself as "nobody manages it" (mode `bare`, the evidence is the parent being bash) and handed out an installation plan; the real "install → run → uninstall" was done on an instance that was **already managed by a supervisor**, so the bare instance never had the full install/uninstall cycle |
| started in the background (`nohup` / `setsid`) | **partly** | on a real machine it was recognised as a bare background start; **"the re-launch command outlives its shell" is pinned by unit tests only** (the machine did not report the detached flag back then) |
| WSL with systemd | **yes** | really installed and really removed |
| a Windows login task | **partly** | on a real machine one login-triggered task was created → queried (State=Ready, the logon trigger) → deleted (no leftovers) with the system's own tools, which proves that no administrator rights are needed; **"the fallback into the startup folder when the task is refused" is pinned by unit tests only** |
| the desktop client | **yes** | on a real machine it comes back by itself (there is a snapshot and a self-check record, no rollback was triggered, and it does not start twice); that is the client's own business, it is not part of the hosted matrix |
| pm2 / forever | no, unit tests only | the recognition and the behaviour are pinned by unit tests |
| container / compose | **no — out of scope** | see [Supported platforms](#supported-platforms): containers are **not** a supported environment |
| `npx` / `pnpm dlx` wrapper | no, unit tests only | same |
| started by another DSH plugin | no, unit tests only | same |
| tmux / screen / an SSH session | **no — out of scope** | see [Supported platforms](#supported-platforms): a remote SSH session without a GUI is **not** a supported environment |
| WSL started by a Windows-side process | no, unit tests only | same (it is recognised as "cannot tell", so nothing happens) |

**"Unit tests only" means "not verified on a real machine", not "unsupported"** — on the four
supported platforms those paths are pinned by unit tests, and "no full install/uninstall cycle" does
not mean unsupported either. The three environments listed under
[Supported platforms](#supported-platforms) (macOS, a remote SSH session without a GUI, containers)
are a different case: they are **outside** the supported set, and the table above says so.
If your environment is recognised wrongly, please send us the "startup mode + the evidence" block
from the settings page.

### Report a problem

The settings page has a "**Report a problem**" group at the bottom:

- The main button "**Copy the diagnostics and open a GitHub issue**": one click puts the diagnostics
  on the clipboard and opens a **pre-filled** issue page (title and outline) — paste the clipboard
  text into it.
- The diagnostics carry **no access token and no secrets**: only the plugin version, the platform,
  whether this is the desktop client, how the host was started (with the evidence), the supervisor,
  the restart mode, and the verdict of the last restart (with the checks that failed).
- When the browser refuses the clipboard (an insecure context, or no permission), the plugin shows
  the diagnostics in a **selectable** box and says so — a report never dies because the browser said
  no.
- No GitHub account? The same group shows the mailbox (252170229@qq.com) as plain text, plus a
  "Copy the diagnostics" button.

## What it occupies in DSH

Nothing here is hidden: this is the complete list of where the plugin attaches itself, so you can see
what it adds before you install it.

| Kind | What it adds |
| --- | --- |
| Agent tools (6) | `continuum_restart`, `continuum_status`, `continuum_cancel_restart`, `continuum_park_goal`, `continuum_recover_now`, `continuum_handoff` |
| HTTP routes (7) | Under `<healthPath>` (default `/__dsh_autorestart`): `GET /health` (also `?state=1`, `?gate=1`, `?probeIndex=1`), `POST /park`, `POST /recover`, `POST /handoff`, `GET /sleep` and `POST /sleep` (the graceful shutdown — the desktop client and the hosted web client drive the very same route), `GET /announcements` and `POST /announcements` (the one-time new-feature announcement). Loopback or an authenticated browser only |
| Client slots (6) | `conversation.input.left` — the pending-restart pill (`autorestart-restart-pill`); `sidebar.session.row.leading` — the session status dot (`autorestart-restart-dot`); `conversation.input.dock` — the one-time install question (`autorestart-backup-choice`) and the one-time new-feature announcement (`autorestart-feature-announcement`); `sidebar.footer.action` — the moon button of the graceful shutdown (`autorestart-sleep-button`); `shell.overlay` — the shutdown countdown card and the **centered restart-stage overlay** (`autorestart-sleep-overlay`, `autorestart-restart-overlay`); `settings.section` — the section "Auto-restart & shut down" in the settings page (`dsh-autorestart`), which also carries the save receipt inside the panel itself (no overlay slot of its own) |
| System prompt | One "Restart policy" section that tells the agent how to ask for a restart and what the plugin will do |
| Harness hooks | `agent/status` (tracks which conversations are busy), `tools/pre-execute` (blocks a shell command that would kill or relaunch DSH by hand), and the boot pass that resumes interrupted sessions |
| Profile row | One bundle row, `dsh-autorestart` |
| Writes | Only under `<DSH_HOME>/storages/dsh-autorestart/` — `state.json` (checkpoint), `backups/` (pre-restart snapshots), `restart-<gen>.cmd` / `restart-<gen>-watch.ps1` (the detached helper), `last-rollback.json` (rollback report), `restart-outcome.json` (the decision of a restart the plugin judged itself), `access.json` (the access link of the running instance, mode `0600`). The only time it writes into the profile itself is a rollback, which copies that snapshot's `cordis.patch.yml`, `package.json`, `pnpm-lock.yaml` and `node_modules` back |

## Why

| Situation | Without it | With it |
| --- | --- | --- |
| An agent is running a long task and DSH is restarted or crashes | The round is lost and you have to type "continue" by hand | The new process resumes the session and injects a continuation message, so the work continues without you |
| An agent owns a durable goal (`create_goal`) that should survive a restart | The goal activation lives in the process, so after the restart it is `disarmed` and the automatic continuation stops | The plugin re-arms the goal at boot and the goal round driver starts the next round right away |
| An agent wants to install or upgrade a plugin, but a restart would cut the work short | You either wait or take the risk | Call `continuum_restart`: it waits until every agent is idle and the session continues by itself afterwards |

## Host version requirement

**Requires DSH ≥ `0.1.6-alpha.2`.**

Since `0.1.6-alpha.2` the host handles "a plugin did not come up" in two different ways:

- **Ordinary plugins** (your own, or installed from npm) that fail to load **do not block startup**: the host boots anyway, logs `warning: N entry did not activate`, and leaves the other plugins running. That log line is exactly what this plugin reads to show "these features did not come up this time".
- **Required plugins** (the host's own parts, e.g. the web server) that fail **still fail the startup**: the log says `startup failed: N required plugins did not activate`. That is the case the watchdog handles — restore a verified backup, then bring the host back up.

On `0.1.6-alpha.1` and older there is no such distinction: any failing plugin throws and the host does not come up at all, so the signal this plugin depends on does not exist there.

**How this was established (stated plainly)**: by reading DSH's official `@deepseek-ai/dsh-app-boot` package release by release (`0.1.0-rc.2` / `0.1.3-alpha.2` / `0.1.5-rc.3` / `0.1.6-alpha.1` / `0.1.6-alpha.2` / `0.1.7-rc.2` / `0.2.0-rc.1` / `0.2.1-rc.3` / `0.2.2-alpha.2`); the boundary falls at `0.1.6-alpha.2`. The official DSH release notes do **not** state this: the `0.1.6-alpha.2` entry only says "Group startup errors and pending services, and save full diagnostics to a log file". So this is a source-level finding plus a local measurement, not an official declaration.

## Install

Current version: **0.8.6**.

From npm — the package is published under the name `dsh-autorestart`:

```sh
dsh plugin install dsh-autorestart
```

From source:

```sh
git clone https://github.com/Eason-22/dsh-autorestart.git
cd dsh-autorestart
dsh plugin --profile desktop add /absolute/path/to/dsh-autorestart
```

Inside DSH the equivalent is the `plugin_manager` tool:

```
plugin_manager install_bundle  target = <absolute path to the package>
```

Installing into a profile adds a row with the id `dsh-autorestart` to the plugin list. The host half
of the plugin takes effect immediately, but the client half (the pending restart pill and the
sidebar dot) is loaded by the browser, so refresh the page or restart DSH once after the install.

## Usage

The plugin registers six tools for the agent. All of them are also visible to you in the session,
so you can call them yourself.

| Tool | What it does | Parameters |
| --- | --- | --- |
| `continuum_restart` | Requests a graceful restart. The restart waits until every conversation is idle and the host has been quiet for `settleMs`, then the app is relaunched and this session resumes automatically. | `reason` (string, recorded in the checkpoint and the log), `resume` (boolean, default `true`), `defer_seconds` (number, extra seconds to wait before the first idle check), `parkGoals` (boolean, default `true`) — disarm a goal-driven session before the restart |
| `continuum_status` | Read-only snapshot of the lifecycle: whether a restart is pending, which sessions were checkpointed, why each blocking session blocks, the goals this plugin disarmed, the last recovery action per session, the handoffs, the state file path and the detected restart environment. | `include_sessions` (boolean, default `true`) — include the per-session checkpoint entries |
| `continuum_cancel_restart` | Withdraws a pending restart request. By default it withdraws **only the calling session's own request** (`scope: "mine"`); the other sessions that asked for the same restart keep it. `scope: "all"` cancels the request for everyone. Does nothing when no restart is pending. | `scope` (string, `mine` (default) or `all`), `reason` (string, recorded in the log) |
| `continuum_park_goal` | Disarms the goal of a session so that it no longer blocks the restart. The current round still finishes and the goal is re-armed after the restart. | `sessionId` (string, optional) — defaults to the calling session |
| `continuum_recover_now` | Re-runs the recovery immediately instead of waiting for the next restart, and reports the action and the reason for each session. | `sessionId` (string, optional) — defaults to all sessions pending recovery |
| `continuum_handoff` | Hands a session whose conversation exceeded the model context window over to a fresh session, carrying the goal objective, the recorded reasons and a bounded tail of the conversation. | `sessionId` (string, optional) — defaults to the calling session, `maxChars` (number, default `20000`) — character budget for the conversation tail |

A goal is an enhancement, not a requirement: without one, the plugin injects a single continuation
message instead of re-arming a goal.

### Cancelling a restart: only your own request, or everybody's

A restart request is **coalesced**: several sessions may ask for the same restart, and the plugin
keeps every requester in `restart.requesters` so that all of them are resumed after that one
restart. That is why "cancel" has to say **whose** request it cancels:

| Scope | What happens |
| --- | --- |
| `mine` (the default) | Only the **calling session's** request is withdrawn. The restart stays pending while other requesters remain, and `restart.bySessionId` is re-pointed at one of them. When the calling session was the **last** requester, the restart really goes away: the phase returns to `idle` and the session is released. |
| `all` | The request is cancelled for **everybody**: every requester is released and the pending restart is gone. This is "nobody restarts any more". |

Two calls are refused, and both leave the state untouched — a silent "cancel everything" is never
the fallback:

- the calling session is unknown (the tool was called without a session) → refused;
- the calling session did **not** ask for the pending restart → refused.

The tool reports what happened: `cancelled` (whether the restart request itself is gone),
`remainingRequesters` (how many sessions still wait for it), `scope` and `phase`.

```json
{ "ok": true, "cancelled": false, "scope": "mine", "remainingRequesters": 1, "sessionId": "sess-a", "phase": "deferred" }
```

### The capsule: click it for the details and for the way out

The capsule in the composer row is 22px high and ONE line wide, so it carries ONE short line and
nothing else (`待重启 · 空闲后自动重启` / `待重启 · 等待 2 个会话`, 12 characters at most — never a
name and never a long sentence, because that is exactly what got cut off before). The details live
one layer down: the long sentence is the tooltip, the **stage** (backing up / restarting / back) is on
the **centered overlay card in the middle of the shell**, and the count with the way out is in the
panel below. Clicking it (or pressing Enter/Space on it) opens a small panel above it:

- how many conversations the restart is waiting for (the same number the capsule shows);
- how many OTHER sessions wait for the same restart;
- one button: **Cancel my restart**.

The button opens a confirmation (no timeout, nothing counts down): *Cancel your restart?* — and what
cancelling means right now (only you, or you while the others still get their restart). Only the
confirmation sends the request; `Esc`, a click outside the panel or **Never mind** closes it without
doing anything.

The request withdraws ONLY this session's restart request (`POST /__dsh_autorestart/cancel` with
`{ "sessionId": "…", "scope": "mine" }`): the other sessions keep theirs, and the restart still
happens for them. There is no "cancel everybody" in the panel — that stays an explicit tool call
(`continuum_cancel_restart` with `scope: "all"`).

## Configuration

Two blocks of the settings page are worth a word, because they show facts instead of guesses:

- **What is backed up right now** (right under the two backup switches): the HOST reads
  `<DSH_HOME>/storages/dsh-autorestart/backups/`, so the number of copies, the **local time** of each
  one, how much disk they take together and where the folder lives are all real. Only the directory
  metadata is read — the contents are never walked (one copy can be 150 MB). With no backup at all it
  says: "No backup yet; one is written before every restart."
  Every row is one copy and carries two things: its backup **time**, and the one action that applies
  to it ("Roll back to this copy"). A row carries **no size** — the total sits once, above the list,
  as "Using 156 MB on disk, 2 copies right now". The list does **not** say which copy is the safe
  one — the plugin no longer makes that call (user decision, 2026-11-02): a row is a time and a
  button, and the judgement is the reader's:

  ```
  Using 156 MB on disk, 2 copies right now

  Backup time 2026-10-29 22:08   [Roll back to this copy]
  Backup time 2026-10-29 21:44   [Roll back to this copy]
  ```

  One row can carry one more neutral sentence, and it is not a verdict: the copy the host last
  started from says "This is the state at the most recent startup. DSH starting does not mean every
  plugin is healthy — a broken plugin is excluded and the host still boots. Which copy to roll back
  to is your call." It is attached by the copy's own record, never by its position in the list.

  The identity still exists, but **it is not on disk**. `meta.json` next to each copy records FACTS
  only — when the copy was taken (`takenAt` / `at`), what put it there (`trigger`: `first-install` /
  `pre-restart` / `manual-rollback`), `version`, the content fingerprint, and what the boot that
  followed reported (`boot`: did the host come up, was it running this content, which plugin load
  failures it listed). The three names are **derived from those facts when the copy is read** —
  `known-good` (a boot is on record after it, or it is the first-install copy), `snapshot` (no boot
  after it yet) or `unknown` (no readable `meta.json`, or no usable boot record on an old copy). Being
  restorable is a **second, narrower check** on top of that name: an automatic rollback only restores
  a copy whose recorded boot both started and ran this exact content. The value records what happened
  after the copy was taken; it is not an evaluation of whether the plugins
  inside it work. The browser cannot read `meta.json`, and no identity is printed on a row.

  The time is the local clock of the machine that took the copy, **to the minute and with no
  timezone offset** (a `+08:00` only adds noise — the reader is looking at their own clock). The size
  of the whole folder picks its own unit (`92 KB` / `156 MB`) and keeps the tenth only when it says
  something (`117.7 MB`, never `156.0 MB`); it is printed once in the summary line above the rows,
  never on a row, and it carries no "(plugins included)" bracket. Two copies are two groups with air
  between them.
- **A setting that was saved says so.** Every control writes itself the moment it is changed, so the
  panel has to say whether the write landed: once the HOST answers `ok: true`, a green strip at the
  **top of the settings panel itself** (inside the panel — a `sticky` row, so it stays visible while
  the page scrolls) says **`已生效` / `Saved`** with the time (`Saved 21:40:12`) and fades after 3
  seconds. A refused write says **`没保存成功` / `Not saved`** in red, with the reason the Host gave,
  and it stays until the next change works or you close it. Nothing is ever announced before the
  Host's answer arrived — rendering the page, polling it and clicking a control stay silent.
- **How this host was started** (hosted web only): one plain line ("How I remember you were started:
  by your own script (the restart is its job — I stay out of it)") plus two small actions (detect
  again / undo); the command itself is folded away under **"Technical details"** and stays closed
  until somebody opens it. The **desktop client does not render that block at all** — it brings
  itself back up and must never write a `restartCommand`. When the Host cannot say which kind of
  host this is, the whole block stays away.

Every key has a default, written in the `insert` row of `cordis.patch.yml`. To override a key, add
an `- id: dsh-autorestart` row with the same key to the `cordis.patch.yml` of the profile at
`~/.dsh/profiles/<profile>/cordis.patch.yml` (it replaces the whole config, it is not merged). The
plugin also exports a real schemastery `Config` schema, so the keys, their types and their defaults
show up in the Plugin Manager and in the config editor.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turns the whole plugin off. |
| `stateFile` | `''` | Path of the checkpoint file. Empty means `<DSH_HOME>/storages/dsh-autorestart/state.json`. |
| `resumeOnBoot` | `true` | Whether interrupted sessions are resumed automatically at boot. |
| `recoveryDelayMs` | `6000` | How long to wait after boot before resuming, so the session store and the model are ready. |
| `maxSessions` | `4` | Maximum number of sessions resumed per boot. |
| `maxResumeAttempts` | `2` | Maximum resume attempts per session, counted across boots, so a bad session cannot loop forever. |
| `deferPollMs` | `3000` | Poll interval while waiting for the conversations to go idle. |
| `deferSoftMs` | `300000` | **Deprecated — read but completely ignored.** A pending restart has no deadline. Kept only so existing configuration files stay valid. |
| `deferHardMs` | `900000` | **Deprecated — read but completely ignored.** A pending restart never gives up. Kept only so existing configuration files stay valid. |
| `deferPolicy` | `auto` | Kept for configuration compatibility. Waiting is the same under every value: a pending restart waits for the idle gate, with no deadline. |
| `forceRestartWhenBusy` | `false` | Whether a restart may be forced while a conversation is still running. The default `false` never interrupts a session: the plugin waits until the other conversations finish. |
| `restartMode` | `app` | `app` = restart the DeepSeek Harness desktop app. `command` = run `restartCommand`. |
| `restartCommand` | `''` | Custom restart command. Supports the `{pid}`, `{ppid}` and `{app}` placeholders. |
| `relaunchDelaySeconds` | `2` | How long the detached helper waits before it kills the app (`ping -n 3`, roughly 2 seconds). |
| `settleMs` | `2000` | Quiet window in milliseconds: the host must stay silent this long after the last conversation activity before a restart may start. |
| `restartGraceMs` | `0` | The **restart reserve** in milliseconds: how long the host waits after the last conversation finished before it is really RESTARTED — a dropdown: `0` / `5` / `10` / `20` / `30` / `60` seconds. `0` means "no extra wait". A restart is a daily operation, so the default is none. The settings page calls it *Wait before the restart*. |
| `sleepCountdownSeconds` | `20` | How many seconds the graceful shutdown counts down before the machine goes down — a dropdown: `0` / `10` / `20` / `30` / `60` seconds. `0` means "switch off right away" (still waiting for the conversations to be idle). **This visible countdown IS the wait before the machine goes off** — the shutdown has no second, invisible reserve. The settings page calls it *Shutdown countdown seconds*. |
| `queuedGraceMs` | `60000` | Upper bound in milliseconds for a **queued** (unclaimed) inbox message: how long it may hold the restart back before it is treated as stuck. `0` means "no upper bound" (the behaviour before 0.6.2). A **running** conversation always blocks, under every setting. |
| `autoReloadPage` | `true` | `dsh web`: reload the page automatically when the host boot token changes. |
| `blockManualRestart` | `true` | Hard-block an agent that tries to kill or restart DSH with a shell command, and point it at `continuum_restart` instead. |
| `healthPath` | `/__dsh_autorestart/health` | Health check route. Returns the boot id, the pid, the phase and the self-check flags. |
| `continuationText` | `''` | Overrides the default continuation prompt text. |
| `backupOnRestart` | `true` | Snapshot the profile before every restart, so a restart that leaves the host unable to boot can be rolled back. |
| `backupIncludePlugins` | `true` | Include the installed plugin tree in that snapshot (about 117 MB here, ~3 s). `false` keeps only the configuration files. |
| `maxBackups` | `2` | How many snapshots are kept — **2 by default, settable to 2–10 in the settings page**; older ones are deleted when a new one is written — **except the newest copy whose identity is `known-good`, which is never deleted**. |
| `rollbackTimeoutMs` | `90000` | How long the detached watcher waits for the new host before it restores the snapshot. |
| `restartCommandTimeoutMs` | `30000` | How long the restart command may run before the plugin stops waiting for it. A command that starts the host in the foreground never returns — that is reported as "still running", not as a failure. |
| `rollbackCopyTimeoutMs` | `120000` | How long ONE restore step (the configuration files, then the plugin tree) may take. A restore that does not finish in time is given up and the reason is written into the rollback report. |
| `showSleepButton` | `true` | Whether the moon button of the graceful shutdown is shown at the foot of the left sidebar, next to Settings. |
| `sleepCommand` | `''` | A custom shutdown command for the graceful shutdown. Empty = the host is detected automatically; a value replaces the detected command (`cmd.exe /c …` on Windows, `/bin/sh -c …` everywhere else). |

The two waits are independent of each other, and both default to two seconds:

- `settleMs` (`2000` ms) is the quiet window after the last conversation activity during which the
  host has to stay silent before a restart is allowed to start.
- `relaunchDelaySeconds` (`2` seconds) is how long the detached helper waits before it kills the app.

Both can be overridden separately in the profile config. A larger `settleMs` is the more
conservative choice, because it is less likely to cut a session short that has just started.

### Why the host waits a few more seconds after the work is done

**The blind spot.** This plugin can only see the **DSH agents**: it knows whether a conversation is
running, whether it has queued inbox work, and when the last of them went idle. It cannot see the
work other plugins queue with a timer of their own — a memory plugin that writes its notes a few
seconds after the conversation ended, a summary, an MCP callback, a log flush. That work is
invisible here, so "every agent is idle" does not mean "nothing is happening any more".

**One reserve window, for the restart.** A restart has no countdown of its own: the host restarts
as soon as the conversations are done. `restartGraceMs` is the extra wait that leaves room for the
delayed work of the other plugins — and it is the **only** such window:

| Window | Governs | Default | Offered |
| --- | --- | --- | --- |
| `restartGraceMs` | the **restart** | `0` (no extra wait) | `0` / `5` / `10` / `20` / `30` / `60` seconds |
| `sleepCountdownSeconds` | the **shutdown** (visible!) | `20` (twenty seconds) | `0` / `10` / `20` / `30` / `60` seconds |

- **The restart gate waits `max(settleMs, restartGraceMs)`** of quiet. With the default (`0`) the
  gate waits for the settle window alone — a restart happens as soon as the conversations are done.
- **The graceful shutdown has no invisible reserve.** Its **visible countdown** is the wait before
  the machine goes off: the seconds are on the screen, the user can watch them and cancel them.
  A second, hidden window next to it would only say the same thing twice — so there is none. The
  shutdown starts counting down as soon as every conversation is idle.
- **New activity restarts the timer.** If a conversation starts working again while the host is
  waiting, the reserve starts over — the wait always follows the last activity.
- **Where to change them.** Settings → Auto-restart & shut down, in two titled groups:
  *Restart settings* (the wait before the restart, the two backup switches) and *Shutdown settings*
  (the countdown of the shutdown). The status interfaces report the restart reserve:
  `GET /health?state=1`, `GET /health?gate=1` and `continuum_status` carry `graceMs` (the restart
  reserve) and `effectiveSettleMs` (the window the gate really uses); `GET /sleep` carries
  `restartGraceMs` and `countdownSeconds` (the countdown that is really running). All of them carry
  `quietForMs` (how long the host has actually been quiet).

### Why a queued message cannot block the restart for ever

**The deadlock.** A conversation whose inbox holds a message nobody claimed yet counts as "busy"
for the restart gate. That is right while the message is about to be picked up — the agent claims
it within a second or two — but it is a deadlock when nobody ever claims it. The real case was a
fresh, empty conversation in the UI with one unclaimed message in its inbox: the gate stayed
closed and the restart never happened.

**The upper bound.** `queuedGraceMs` (default **60000** ms) is how long an unclaimed message may
hold the restart back:

- **A message claimed inside the window still blocks.** The normal case is unchanged: the agent
  picks the message up and the restart waits for it.
- **A message that is still unclaimed after the window is stuck.** It stops blocking the restart,
  and the log names the session that holds the queue (`the queued message of session <id> has been
  waiting 61s and nobody claimed it; it no longer blocks the restart`). The restart goes on.
- **A running conversation always blocks — under every setting.** The bound only ever judges
  *queued* work; a live turn is never relaxed, and no configuration can make the plugin kill one.
- **The timer follows the work.** A session that starts working drops its queue timer, and a new
  queue counts from zero again.
- **`0` means "as before".** With `queuedGraceMs: 0` an unclaimed message blocks the restart for
  ever, exactly like it did before this bound existed.
- **Where to look:** `GET /health?state=1`, `GET /health?gate=1` and `continuum_status` all report
  `queuedGraceMs`.

### The four stages of a restart (what you see between the click and the comeback)

A restart is not instant, and for a while it used to look like nothing at all: the click was
accepted, then the host spent ten-odd seconds writing a pre-restart snapshot (a desktop profile
with its plugins is ~150 MB). The button looked dead. It is not — and now it says so:

| Stage | What the interface shows | Where the data comes from |
|---|---|---|
| `waiting` | Nothing on the overlay — the **centered overlay card does not appear at all** while the gate only waits (no backup is running, nothing happens but waiting). The capsule says it in one short line ("pending restart · waiting for N sessions"). **One exception:** when a restart was interrupted by a new conversation, the card stays and says so — "A conversation just started — restart postponed" + "It will retry automatically when idle" — instead of claiming "Restarting…". | the idle gate's blockers |
| `snapshotting` | The **centered overlay card in the middle of the shell**: "Backing up before DSH restart" + a real progress bar, "12.3 MB / 40 MB" and a percentage; the settings page and the tooltip keep the long line, in the same words ("Backing up before DSH restart (about 12s, 78 MB done)…"). The card has NO minimum shown time: it lives exactly as long as the Host reports the stage (a 92 KB copy is gone in about 5 ms, a slow one stays as long as it runs); the size picks its own unit (`92 KB` / `156 MB`) so a small backup never reads "0 MB" | the REAL copy loop: files and bytes written, measured total |
| `restarting` | "Restarting…" — and ONLY while the process is really being killed: the idle gate is re-checked every 350 ms, so a conversation that starts here turns the card into the postponed one above instead of leaving a false "Restarting…" on screen | the host is on its way out |
| `back` | "Back — carrying on where we left off", for **1.5 seconds**, then the card is gone | the new host, once it boots |

**The overlay never hangs.** When a restart is postponed back to waiting, the stage is reset and the
overlay disappears at once; and a stage that has not been updated for more than **15 seconds** is
treated as stale and is not drawn at all (the capsule keeps showing the waiting count). A stale stage
can therefore never sit on top of the interface.

Three things make this honest rather than decorative:

1. **The first stage is written by the click itself** and persisted at once, so the pill (which
   polls the `state=1` route every 2 s, and immediately after a click) has something true to show
   well inside the first second.
2. **The progress is measured, never animated.** The copy reports the files and bytes that really
   landed, against a total measured before it started; the estimate only appears once there is a
   real speed to divide. When there is no measurement yet, the text claims no number at all.
3. **A slow copy is announced** — after five minutes, or when the byte counter has not moved for a
   minute, the line becomes "The backup is slower than expected (the disk may be busy); it is still
   running…". That is the opposite of a progress bar that pretends.

**Cancelling.** While the host is still waiting or copying, cancelling stops the copy between two
files, deletes the half-written snapshot (no fake backup is left behind), withdraws the request and
the host keeps running. Once the stage is `restarting` a cancel is refused (HTTP 409 with the
reason) and the button is greyed out: the host is already on its way out, and a cancel there would
be a promise this plugin cannot keep.

Both `…/health` and `…/health?state=1` carry `restartPhase` (stage, bilingual text, `cancellable`,
`slow`) and `progress` (files, bytes, total, percent, age), and the settings page keeps one status
line next to the restart settings — the pill is only there while a restart is pending, the settings
line is always there.

### What you see while the restart waits

A restart waits for one thing only: **every conversation finishing its work**. There is no deadline
and nothing expires — it keeps waiting for as long as that takes, and only two things end it: the
gate opens (the restart runs) or you withdraw the request.

The wait is visible from the first second, not after some threshold:

- **The request is kept.** The pending restart stays pending, the requester stays checkpointed, and
  the restart fires as soon as the gate is quiet again. Nothing is cancelled behind your back.
- **The wait becomes visible.** The log says it once a minute — "the restart has been waiting for
  17m; `<session>` still holds it — cancel the restart or wait for that work to finish" — and
  `GET /health?state=1` carries a `longWait` object (`since`, `reason`, `blockedBy`).
- **The bubble says it too.** The pending-restart pill shows one more line: "waiting for 17m:
  `<session>` keeps holding it" (「已等 17 分：`<会话>`一直占着」).

A conversation is never killed to make the restart happen: `forceRestartWhenBusy` stays off by
default, and this plugin never turns it on. When it IS turned on, it restarts over a running
conversation — it interrupts it. That is a choice about interrupting work, not a deadline.

### What the quiet window measures

The restart gate has two layers: **no busy conversation** and **a quiet window**
(`max(settleMs, restartGraceMs)`).

The quiet window answers one question: *how long ago did the last real work happen?* It is measured
from the LATER of two markers:

- **the last real activity signal** — a turn that started or ended (`agent/status`), a message that
  was queued (`agent/inbox/inserted`), or a session event that says work happened (a message, a tool,
  a turn);
- **the last moment a conversation was seen working** — a running turn or a queued message
  (`busyAgents()`).

**A routine session event is not activity.** The host emits session events every two to three seconds
while the interface polls and synchronises (a title, a projection, a context request, a job that
settled). Counting those as activity reset the quiet window every couple of seconds, so a window
longer than the event interval could never fill: the restart never fired, however long the user
waited. That is why a grace window of ten seconds used to make the restart impossible.

The rule is one-sided: **an event whose type cannot be read is not activity.** When in doubt the
plugin restarts a little early rather than never.

**A running conversation always blocks.** The quiet window only decides *when* the restart may fire;
the busy check is the hard guarantee, and it is never relaxed by any setting.

**Where to look when the restart does not happen.** The status interfaces report the reason of the
gate next to the blockers (`GET /health?state=1` carries `reason`: `conversation-active` when a
conversation blocks, `settling` when only the quiet window is not full yet, `quiet` when it may go),
and the pending restart writes one diagnostic line into the log per minute:

```
restart gate: action=wait reason=agents-busy-within-soft-window busyCount=1 quietForMs=1432 effectiveSettleMs=10000
```

`action` is what the restart decision did (`wait`, `restart`, `long-wait`, …), `reason` why,
`busyCount` how many conversations block, `quietForMs` how long the host has been quiet, and
`effectiveSettleMs` the window it has to fill.

### Platform note

`restartMode: app` only applies to the DeepSeek Harness desktop app. A hosted `dsh web`
deployment has no desktop app to relaunch, so it must set `restartMode: command` and provide a
restart command of its own:

```yaml
- id: dsh-autorestart
  config:
    restartMode: command
    restartCommand: systemctl --user restart dsh-web
```

Remember that this replaces the whole config instead of merging into it.

## Pre-restart backup and automatic rollback

A restart is only safe if the host comes back. Before every restart the plugin snapshots the profile
it was started from, so a restart that leaves the host unable to boot can be undone automatically.

- **What is backed up:** `cordis.patch.yml`, `package.json` and `pnpm-lock.yaml`, plus — unless
  `backupIncludePlugins` is turned off — the installed plugin tree (`node_modules`). Snapshots live in
  `<storage>/dsh-autorestart/backups/<timestamp>/` with a `manifest.json` next to them. On a profile
  like this one the full snapshot measures about 117 MB and takes under three seconds.
- **PLUGINS INSTALLED WITH `link:` ARE BACKED UP TOO** (2026-10-30, measured gap). Five plugins on
  this machine were installed as links/junctions (`dsh-autorestart` itself among them), and the tree
  copy recorded the LINK and not one byte behind it — so the plugin that does the rescuing could not
  be put back. The manifest now carries `links: [{name, target, kind, exists, readable, copied, files,
  bytes}]` (+ `linkFiles` / `linkBytes`) and the CONTENTS of every enabled linked plugin are kept in
  `node_modules-link/<name>/` (1 216 files / 69.5 MB for these five). On restore each link gets one
  decision, printed as its own line — `kept` (target still there: the development directory keeps
  working), `replaced` (the copy takes its place), `target-missing`, `no-backup`. The restore script
  has `-ForceLinkPlugins` for "replace them all"; the watchdog uses the same rules
  (`decideLinkRestore`) and does not give a link a second chance (`attempts >= 2` ⇒ replaced).
- **The rollback target is the copy taken before an earlier restart that came up, not the newest
  copy** (user decision, 2026-10-30). Every copy carries a `meta.json`, and **it records facts
  only**: when it was taken, what put it there (`trigger`), `version`, the content fingerprint, and
  what the boot that followed reported (did the host come up, was it this content, which plugin load
  failures). The three identity names — `known-good`, `snapshot`, `unknown` — are **derived from
  those facts when the copy is read, never written to disk**: a copy with a boot on record after it
  (or the first-install copy) is `known-good`; a copy with no boot after it yet is `snapshot`; a copy
  with no readable `meta.json`, or an old one with no usable boot record, is `unknown`. That name is
  not the same question as "can it be restored": the automatic rollback additionally requires the
  recorded boot to have started and to have run this exact content. The identity records what
  happened after the copy was taken; it is not an
  evaluation of whether the plugins inside it work. The snapshot taken right before THIS restart is
  never the rollback target — it may be the broken state itself (that is exactly the "I edited a
  plugin and clicked restart" case). The first install seeds one copy with `trigger: first-install`,
  and every boot whose checks pass on this exact content records a `boot` on that restart's snapshot.
- **No `known-good` copy, no restore at all.** When no copy has a boot recorded after it yet, the
  plugin restores nothing and says why: the report carries `no-known-good: <reason>`, the profile is
  left exactly as the failed restart left it, and no watcher is armed (a watcher with nothing to
  restore would only write the broken state back).
- **How many are kept:** the newest `maxBackups` snapshots (**2** by default, settable to **2–10** in the
  settings page); older ones are deleted when a new one is written. The newest copy whose identity is
  `known-good` is never deleted, whatever the limit says — it is the only kind an automatic rollback
  restores.
- **How a failed boot is detected:** a small watcher runs **outside** the host process (so it survives
  the host being killed). It waits for the **new** instance and probes **its** health route for
  `rollbackTimeoutMs` (default `90000`). The new instance publishes its own port and its own boot id
  in `<storage>/dsh-autorestart/access.json`, so the watcher never mistakes the old instance (or the
  old port) for the new one. A healthy answer ends the watch and nothing is touched.
- **What happens when the host never answers:** the watcher copies the snapshot back over the profile
  (configuration files, and the plugin tree when the snapshot holds one) and writes
  `last-rollback.json` next to the checkpoint — including the tail of the newest crash log written
  *after* this restart and the reason the restore failed, if it did. It does **not** start a second
  copy of the host: the instance that was launched is left alone, so there is never a second window
  or a second web server.
- **The hosted mode has the same safety net.** With `restartMode: command` the restart command
  usually kills the very process the plugin runs in, so the plugin cannot confirm anything itself.
  The watcher is therefore started **before** the command runs, and it is the one that decides
  whether the new instance came up.
- **A manual rollback to ANY copy** (user decision, 2026-10-30): the settings page offers
  "roll back to this copy" on every row, so a copy from last week — even one with no boot recorded
  after it — can be restored on purpose. It asks first (which copy, that the current state is replaced, that a restart
  follows); the Host saves the current state as a fresh snapshot BEFORE it restores anything, writes
  `last-manual-rollback.json`, and only then requests a normal restart (the plugin never kills the
  host itself). The route (`POST /__dsh_autorestart/rollback-to`) takes a backup NAME only — a path
  or a traversal is refused before anything is read — and it stands down when the watchdog already
  holds the rollback lock.
- **The command is judged, not assumed.** A restart command that cannot be started, or that exits
  with an error, is reported as a failure (with its exit code and output) and the snapshot is
  restored — it is never reported as a successful restart.
- **How you learn about it:** the next boot reports it. `continuum_status` gains a `lastRollback`
  object (`at`, `waitedMs`, `rolledBack`, `reason`, `backupDir`, `crashLog`, `crashTail`), and the
  next restart clears the report so it is never mistaken for a fresh one.
- **Turning it off:** `backupOnRestart: false` skips the snapshot entirely (no rollback point, and no
  watcher), which is what a user who keeps their own backups may prefer. `backupIncludePlugins:
  false` keeps the snapshot but limits it to the configuration files.

The rollback is deliberately conservative: it only runs when the relaunched host never answers its
own health route. A slow start inside `rollbackTimeoutMs` is never treated as a failure, and a
healthy host is never touched. The restore itself is bounded as well: every copy step gives up after
`rollbackCopyTimeoutMs` (default `120000`) and says so in the report.

### When the machine refuses a scheduled task (the automatic rollback is gone)

The safety net above hangs on a **one-off scheduled task**: the helper that brings the host back
after a restart is a task that fires a minute later. On a machine where such a task cannot be
created (a corporate policy, a locked-down account, a machine without the rights) the net is
silently missing.

So the plugin **checks the machine once** — the first time it runs there — and tells the truth in
the settings page:

- `Automatic rollback: available` — the net is there.
- `Automatic rollback: **not available**` — and exactly what is lost: *DSH will not recover by
  itself when it does not come up after a restart*. The line points at the restore script in
  "If DSH will not start", which is the way out.

**What this deliberately does NOT do:**

- **No fallback chain.** There is no "use the startup folder instead", no "use a systemd timer
  instead", no second mechanism that is tried when the first one is refused.
- **No bypassing the policy.** The plugin does not look for a way around a machine that says no.
  If the machine refuses, the answer is "not available" — and only that is reported.

A refused check is **never** a failed installation: the plugin works exactly as before, only the
safety net is missing. The check itself is harmless by construction — it registers a task that
fires in two minutes and does nothing (`cmd /c exit 0`), reads it back, deletes it, and reads it
back once more to prove that it is gone. It runs **once**, not on every visit of the settings page,
and it never leaves a task behind (not even when a step of it fails).

### The watchdog: the three ways it can be triggered

The rollback above needs somebody to *wait*: the host is restarted, and a
one-off thing has to notice that the new host never came up. That thing is the
**watchdog** (`scripts/watchdog.mjs`), and how it is triggered is the part
that differs between the machines — so the plugin picks the best way the
machine has and says which one it picked:

| Tier | Mechanism | Where |
|---|---|---|
| `scheduled-task` | a one-off Windows scheduled task (read back after it was registered, deleted completely afterwards) | the desktop app and `dsh web` on Windows |
| `systemd-run` | a systemd user timer (`systemd-run --user --on-active=…`), reset when it is over | `dsh web` on Linux, WSL with systemd |
| `detached-process` | a background process of our own (`setsid nohup sh -c 'sleep …; …'`), its pid in the state directory | containers, WSL without systemd |
| `none` | nothing on this machine | then there is **no automatic rollback**, and the settings page says so |

**One function decides it** (`lib/watchdog-tier.js`), and the settings page, the
diagnostics and the watchdog itself all ask that one function — so the warning
("this machine has no automatic rollback") can never drift away from what the
plugin actually does.

The flow is the same for every tier (`lib/watchdog.js`): wait for the new host
to write the ready marker → ask again (a slow host is not a dead host) → is an
instance alive? (then there is nothing to restore) → **ask the health route of
the host itself** (only a host that does not answer may be rolled back; when
there is no port to ask, one more round is waited and the markers are looked at
again) → take the shared lock (`rollback.lock`, so exactly one of us restores) →
and then, **in this order**: restore the snapshot → **remove the stale
`dsh-auth-*` handshake cookies** → start the host again → wait for the ready
marker.

Each pass tries up to **`maxAttempts`** times (3 by default, with a hard ceiling
— never endless): a pass that did not come up backs off (5s / 10s / 20s, capped)
and the three questions above are asked AGAIN before the next start, because the
world changed in between (a slow boot is `not-needed`, an instance that came up
is `abandoned`). The snapshot is restored on the **first** try only (copying the
same tree twice changes nothing), **but the cookies are cleared before every
single start**: starting the host with 71 stale cookies is starting it to die
again (the Cookie header overflows 16 KB and the host answers 431).

**A failure always leaves a report.** Whatever the outcome — recovered,
not-needed, abandoned, decided, failed, or out of attempts — every pass writes
`<stateDir>/last-watchdog-report.json`: which tier it used, `healthCheck`, how
many attempts, and per attempt `restored` / `cookieClear` / `relaunched` /
`ready` / the backoff, plus why it stopped. A report that never reaches the disk
is a report that never happened; that was one of the three defects 0.8.6 fixes.

### What the watchdog does NOT cover

Be clear about the window, because the whole thing is a **window**:

- the watchdog is armed **only while this plugin is restarting the host** — it is
  a one-off item scheduled just before the kill, and the host disarms it at boot
  (`watchdog-pending.json` gone, ready marker written, the scheduling item
  deleted);
- **outside that window nobody is watching.** A host that is killed by the system
  at 03:00, a client that is start-and-die on a manual double-click, or a machine
  that is found with 0 processes in the morning has **no watchdog to bring it
  back**: the plugin is not running (it died with the host) and no one-off item
  was ever registered. What is left in that case is `scripts/restore-profile.cmd`
  (double-click it) and, when the profile itself was emptied, nothing at all;
- the watchdog restores **one snapshot** and starts the host — it repairs no bug
  of the host. A host that dies for the same reason every time ends as `failed`
  with a report that names the attempts;
- `watchdogEnabled: false` (and a machine whose tier is `none`) means no
  automatic rollback at all, and the settings page says so.

### A plugin that did not load: the REPORTED kind of failure

Not every plugin failure keeps the host from booting. The other one is quieter: the
host comes up, one entry **never activates**, and the feature behind it simply 404s.
The startup log says so (`<plugin>: failed to import: <error>`, `<plugin>: import
failed …`, `- <plugin>: loading`, or the aggregate `dsh: warning: N entry did not
activate`) and, without this pass, nobody reads it.

The two failures are handled by two different mechanisms, and they never overlap:

| failure | who handles it |
|---|---|
| **process level** — the host does not come up at all | the pre-restart snapshot + the watchdog: one snapshot is restored and the host is started again |
| **reported** — the host is up, one plugin silently did not activate | **a report and a popup, nothing else** — the user decides, and one button puts ONE plugin back |

**THE BOOT PASS DOES NOT FIX ANYTHING** (user decision, 2026-11-01). It used to
put the backup whose identity is `known-good` back and ask for one restart;
measurement showed that was redundant work on top of what the host already does:

- the host **already survives** a broken plugin — measured at **22 s** on the
  desktop (normal boot, the broken plugin's route 404s, the configuration is not
  touched) and at **2.0–2.6 s** on a hosted `dsh web` instance (the profile's
  `package.json` was byte-identical across five samples, and `supervise-web.sh`
  started the host **once** in 62.9 s);
- so an automatic restore only added a second writer into the profile at boot,
  and an automatic restart on top of it.

What the boot pass does now: **read the previous boot's log, recognise the
failed plugins, write `<stateDir>/last-plugin-recovery.json`.** It never calls
the restore, it never asks for a restart — both facts are pinned by tests (every
file in the profile keeps its sha256, no `<plugin>.broken-<ts>` evidence is
created, `state.restart` stays empty).

**The popup is the half that was missing.** A card in the composer dock says
which plugin did not load and what error it reported, and offers exactly one
action: *"Restore `<plugin>` only"*.

**`POST /__dsh_autorestart/plugin-restore`** with `{ "plugin": "<name>" }` is
the ONLY remaining writer into the profile, and it only runs because a human
pressed the button:

- **`overwrite`** — the newest backup whose identity is `known-good` holds a real copy: the live
  directory is renamed to `<name>.broken-<ts>` (**evidence — nothing is ever
  deleted**) and the backup copy takes its place;
- **`replace-link`** — the backup only holds the CONTENTS of a `link:` install
  (`node_modules-link/<name>`): the live link is moved aside the same way and the
  copied contents take its place;
- **`already-consistent`** — the live plugin already equals the backup: no file
  is written and no restart is asked for (pressing twice is harmless);
- **`no-backup` / a copy that fails** — `ok:false` with a `reason` **and HTTP
  200**: "there is no backup for this plugin" is an answer, not a server error.

A restore touches **that one plugin**: every other plugin, and the profile's
`package.json` / `cordis.patch.yml`, are byte-identical afterwards (asserted
file by file). Each attempt is appended to
`<stateDir>/plugin-restore-history.json` (newest 20) and the newest one is
carried by the health route as `pluginRestore`, so the card can say "already put
back — restart to load it".

The loop guards of the old automatic pass (`duplicate` / `needs-human`) are
**not** applied to a button press: "should the machine act on its own" is a
different question from "a person asked again", and the idempotency check still
protects the disk.

Two loops are possible, and both are stopped:

1. **the same old log line read again.** Every boot would "find" the line the
   previous boot left behind. The pass only reads the log of the **previous** boot,
   drops lines older than that boot, and gives every failure a **fingerprint**
   (plugin + first error line + log time) that is recorded as handled once — the
   second time it is a `duplicate` and nothing happens;
2. **the cause is not in the plugin** (a missing peer dependency, a missing host
   capability). Swapping the copy back cannot fix that, so one plugin is restored
   once per cycle: a second failure reports `needs-human`, touches nothing and asks
   for no restart. One boot without any plugin failure resets the cycle.

It is also **idempotent**: before copying, the live directory is compared with the
backup copy (relative path + size + sha256). When they already match, nothing is
copied and no restart is asked for (`already-consistent`).

**A restart is requested only when files really changed.** `no-backup`,
`duplicate`, `already-consistent` and `needs-human` all leave `restartRequested:
false` — a restart that cannot change the outcome only costs another boot. The
restart goes through the **existing** entry (`requestRestart`, the same gate,
snapshot and resume path); there is no second restart mechanism.

Everything is written to `<stateDir>/last-plugin-recovery.json`:

```json
{
  "at": 1761000900000,
  "atIso": "2026-11-01T01:00:05.000Z",
  "log": "…/logs/startup-…log",
  "backupDir": "…/backups/20261101T000000Z",
  "backupKind": "known-good",
  "restoredAt": 1761000000000,
  "failures": [{ "plugin": "broken-plugin", "error": "Error: Cannot find module 'x'" }],
  "actions": [{
    "plugin": "broken-plugin",
    "mode": "overwrite",
    "restoredFrom": "…/backups/…/node_modules/broken-plugin",
    "restoredAt": 1761000000000,
    "backupKind": "known-good",
    "evidence": { "renamedTo": "…/node_modules/broken-plugin.broken-20261101T010005" }
  }],
  "restartRequested": true,
  "needsHuman": false
}
```

`restoredAt` and `backupKind` come from the **backup's own `meta.json`**, so the
answer to "restored to which point in time" is that copy's own record and not
the moment the clock was read. The file holds facts (when the copy was taken, what
triggered it, `version`, the content fingerprint, what the boot after it reported);
`backupKind` is the identity the Host **derives** from those facts — the file does
not carry a `kind` field any more. The same object is exposed as `pluginRecovery` on
the health route and by `continuum_status` (`null` / omitted when this machine
never had such an incident). The reading of the report is not part of this
change: the interface part is a separate task.


**The disarming is the host's job, and it does it at boot.** As soon as this
plugin is loaded, it writes the ready marker, removes `watchdog-pending.json` and
deletes its own scheduling item (retried with a backoff, verified afterwards by
asking the task scheduler, recorded in `<stateDir>/watchdog-disarm.json`). It
does not wait for anybody to call the health route — the watchdog must be
disarmed even when nobody opens the interface, and a disarm that fails is
visible in `health`, in the diagnostics text and in that record instead of
being silent. That is the fix of 0.8.2: an error swallowed by the health route
left an armed watchdog behind a healthy host.

**Only one watchdog at a time.** There is an older watcher in this plugin as
well (it restores the snapshot but does **not** start the host again). Both take
the same lock, so running them together is worse than running one: the one that
loses the lock gives up — and if the new one lost, the profile would be restored
and **nothing would be running**. So the plugin decides once, in one place
(`lib/watchdog-arbiter.js`): the new watchdog takes over whenever it can be
armed at all, and the old one only runs when the new one cannot (no tier on this
machine, the watchdog is switched off, or the registration failed). The report
names the arbiter (`arbiter: "v2"` or `"v1"`), so it is visible at a glance who
was watching.

`watchdogEnabled: false` switches it off entirely.

### The access link after a restart

The boot token of `dsh web` is created **per process**, so the link the browser holds answers `401`
after a restart — the user would be locked out of their own interface. The plugin therefore writes
the access link of the running instance into `<storage>/dsh-autorestart/access.json` (mode `0600`:
the file holds a secret), and reports it in `continuum_status` and in the log. The browser half
follows that link when the one it holds is stale, so the session comes back on its own.

### Start at login: the supervisor of this plugin

A hosted host (`dsh web`) that was started by hand does not come back when it dies — and a restart
that nobody brings back is a restart the user has to do themselves. The plugin can install a
**supervisor**: a small standalone process that starts the host, watches it, and starts it again when
it is gone.

- **It is a separate process.** The plugin lives inside the host, so it can never be the thing that
  brings the host back. The supervisor is a zero-dependency Node script (`supervisor/supervisor.js`,
  shipped with the package) that the plugin copies into `<storage>/dsh-autorestart/supervisor/` when
  it is installed.
- **What it does:** start the host with the command from `supervisor.json`, wait for it to exit, back
  off (1 s → 30 s; the delay is only reset after a start that actually worked) and start it again.
  When the host does not come back at all, the snapshot of the last restart is restored.
- **How it is registered (no administrator rights):**
  - **Windows:** a scheduled task `dsh-autorestart-web` (`/SC ONLOGON /RL LIMITED`). If the machine
    forbids ordinary users from creating scheduled tasks, the plugin falls back to a `.cmd` in the
    startup folder (same zero rights, same "at login" semantics).
  - **Linux / WSL:** a systemd **user** unit
    (`~/.config/systemd/user/dsh-autorestart-web.service`). A machine without a service manager (a
    container, a WSL without systemd) has no "at login" at all — there the plugin says so and leaves
    the start command to the user.
- **The guide of every platform.** "Start at login" means something different everywhere, so the
  plugin hands out one piece of advice per platform (the settings page shows it, with the commands
  you can copy):

  | platform | what the plugin does |
  |---|---|
  | **Windows** | a scheduled task (`/SC ONLOGON /RL LIMITED`, no administrator); when the machine refuses it, a `.cmd` in the startup folder. The command names a **real node** + `supervisor.js` — never the application executable. |
  | **Linux** | a systemd **user** service — plus the `loginctl enable-linger <user>` hint, because without the linger it only starts *after* a login, not at boot. |
  | **WSL with systemd** | the same user unit, plus the linger hint. |
  | **WSL without systemd** | no "at login" at all: two ways out — ① turn systemd on inside WSL (`/etc/wsl.conf` → `[boot] systemd=true` + `wsl --shutdown`; **a system configuration change**) or ② let Windows start the distribution (`wsl.exe -d <distro> -e <command>`; **needs a Windows-side action, but it is much closer to a real boot autostart**). Inside WSL the plugin **never** recommends a container-orchestration setup — the orchestrator of WSL is Windows. |
  | **container / k8s** | no promise at all: the orchestrator brings it back (`restart: always`). |
  | **unknown** | nothing is installed and nothing is guessed: the plugin says why and asks the user to choose. |

  A host that is only **guessed** to be WSL (the mounted Windows drive is the only evidence) gets no
  automatic anything: the plugin says "not sure, pick one yourself" and changes nothing.
- **It is idempotent:** installing twice leaves exactly ONE record (the task/unit name is fixed, the
  task is created with `/F`, and the daemon takes an exclusive lock — two supervisors are impossible).
- **A failed installation leaves nothing behind:** when a step fails half way, the unit (or the task)
  that was already written is taken away again and the rollback is reported in the step list — a
  half-installed supervisor would start a stale one at the next login.
- **The program is never repeated:** a step carries the program in `file` and the arguments in `args`,
  so the record runs `systemctl --user enable --now …` and never `systemctl systemctl …` (which every
  systemd answers with "Unknown command verb systemctl").
- **It is reversible:** the previous `restartMode` / `restartCommand` are saved before anything
  changes and put back by the uninstall. The settings page has one button for it ("Settings →
  Auto-restart & shut down → Start at login"), and the manual way out is printed in the card and in
  the log. When a step of the uninstall fails, the pending cleanup is written down instead of being
  dropped silently — but only when something is really left, and it lives next to the supervisor
  directory (`<stateDir>/UNINSTALL-PENDING.json`), so writing it cannot bring that directory back.
- **The first-run card:** a hosted host is asked ONCE whether the supervisor may be installed. The
  card says what it would change, which rights it needs, and how to remove it again. Choosing "keep
  the way I start it" changes nothing — the plugin only records that a supervisor of your own is
  already there (so it never installs a second one).

The desktop app is **not** asked: it brings itself back up on its own (`restartMode: app`), so the
question would be noise there. It is also **refused** the installation itself — a login record that
starts the supervisor would start the Electron client, and that would open a **second** copy of the
app at every login. `plan` / `install` answer `ok: false` with `error: "desktop-manages-itself"` and
an empty step list there, and the settings page shows `mode: "app"` (`restartCapable: true`) instead
of the scary "restart not available".

The record that starts the supervisor always names a **real Node interpreter**: the process itself
when it is node, otherwise the runtime that ships with the installation
(`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`), otherwise the `node` of the
PATH. The application executable is never used as a stand-in for node, and when no interpreter is
found the installation is refused with the reason.

### How this host was started (the startup matrix)

A hosted web host can be started in a dozen ways, and the plugin has to behave correctly in every
one of them. The classification is a **pure function** (`lib/startup-mode.js`): it takes the parent
chain, the environment markers, the container markers and the platform, and answers
`{ mode, kind, evidence, selfReplay, canInstallSupervisor, suggestion }`.

| How it was started | `mode` | What the plugin does |
|---|---|---|
| a plain terminal (`dsh web`) | `bare` | the supervisor of this plugin MAY be installed; otherwise the derived command (after your confirmation) |
| `nohup … &` / `setsid` | `bare` | the same — but the restart command is **detached** (`setsid nohup …`), so it does not die with the shell that started it |
| a supervisor script (`supervise-*.sh`) | `external` | graceful exit only (`selfReplay: refused`) — the script brings the host back |
| a systemd unit | `external` | graceful exit only (evidence: `INVOCATION_ID` or the parent chain) |
| pm2 / forever | `external` | graceful exit only |
| docker / compose / kubernetes | `container` | no "at login" at all: the compose fragment (`restart: always`) is the answer, and no supervisor is installed inside a container |
| a Windows scheduled task / an NSSM service | `external` | graceful exit only |
| WSL, started by a Windows process | `unknown` | nothing is written: the parent is invisible in WSL — pick the plain terminal (install your own supervisor) or write your own start command (optional) |
| `npx` / `pnpm dlx` | `bare` (usable) or `unknown` | usable when the resolved script path is in `argv[1]`; otherwise nothing is guessed |
| another DSH plugin spawned it | `external` | graceful exit only — never a second host |
| tmux / screen / an SSH session | `bare` | the command is replayed, but **detached from the session** (a graceful exit would break the session) |

**The two rules that matter more than the table:** only a `bare` host may get a self-replay command
or the supervisor of this plugin, and an `unknown` host gets `selfReplay: 'unknown'` and nothing
else — the plugin would rather say "I cannot tell" than start a second host next to the first.

The settings page shows the verdict **with its evidence** ("Started by … — ancestor:1234: systemd"),
so it is visible WHY the plugin says what it says.

### "Keep the way I start it": the derived restart command (E) and the dry run (B)

When the user keeps their own way of starting the host, the plugin can still write down a command
that starts it again — but only if it can be derived **without guessing**. A wrong command is worse
than no command: it looks like a restart and leaves the user with a dead host.

The candidate is built from what the process itself knows: `[process.execPath, ...process.execArgv,
...process.argv.slice(1)]` plus the working directory. The **priority** decides what happens next:

| Level | Situation | What is written |
|---|---|---|
| **E0** | The supervisor of this plugin started this instance | Nothing — the restart is asked of the supervisor over its control channel (the plugin writes the rollback request and lets the supervisor kill and start the host). |
| **E1** | An **external** supervisor is in charge (systemd, a user script, pm2) | **Not** a self-replay command: `restartCommand` becomes a graceful exit (`kill -TERM <pid>` / `taskkill /PID <pid>`), because the other supervisor starts the host again. A second supervisor would fight over the port. |
| **E2** | No supervisor and no init (a container) | The command is handed out together with a compose fragment (`restart: always`); no automatic start is promised. |
| **E3** | No supervisor, an init is available | The derived command — after the user confirmed the dry run. |

The **refusals** (each one has a code, and each one names the way out): the desktop app (it restarts
itself), a host without a web server, a command line that cannot be read back, an external
supervisor, a container without an init, and a port that changes on every start (the cookie of the
browser would die with it — the port has to be fixed).

The **dry run** (B) is the promise: the command, the working directory, the port and the health URL
are shown **before** anything is written. Only an explicit confirmation writes the command into the
profile configuration; the values that were in effect before are kept, so the settings page can put
them back with one click.

- The dry run: `POST /__dsh_autorestart/supervisor` with `{ "action": "dry-run" }` (or the tool
  `continuum_supervisor` with `action: "dry-run"`) — it writes nothing.
- The confirmation: `{ "action": "apply", "confirmed": true }` — without `confirmed` the Host
  answers `400 confirmation-required` and writes nothing.
- The undo: `{ "action": "revert", "confirmed": true }` — the previous `restartMode` /
  `restartCommand` are written back.

### The one-time install question

The first time the plugin is used, the composer dock shows ONE non-modal panel that asks whether the
pre-restart backup should also snapshot the installed plugin tree:

- **"Configuration + installed plugins"** — about 3 seconds and 117 MB more per restart; a plugin
  that breaks the boot can be rolled back too.
- **"Configuration only"** — instant, about 66 KB; plugin problems cannot be rolled back and need a
  manual reinstall.

Both options share the same base: the **configuration** is always backed up. The plugins are an
addition to it, never a rival of it.

- **It is asked exactly once.** The panel is rendered only while
  `localStorage['dsh-autorestart:backup-choice-v1']` is missing; picking an option records the answer and the
  panel never comes back.
- **Closing the panel counts as answering.** `×` and `Esc` write the very same "already answered" mark as
  picking an option, so that browser is never asked again — and closing keeps the default (configuration *and*
  plugins).
- **It never blocks you.** The panel is a `role="status"` block in the composer dock: the input box
  stays usable, nothing is modal, and the panel does not disappear on its own. It is keyboard
  reachable and `Esc` closes it.
- **Where the answer goes.** The host writes it into the profile configuration with the official
  `configEditor` service — the same `backupIncludePlugins` key the settings section edits, so there is
  one source of truth. If that service is unavailable the answer degrades to
  `<DSH_HOME>/storages/dsh-autorestart/install-choice.json` and a warning is logged. The same fallback
  happens in a hosted profile that declares no `dsh-autorestart` row of its own: there is no row for the
  editor to write, so the answer lands in that file instead of the profile. Declare the row (see
  *Hosted `dsh web` deployments* below) to keep the profile configuration as the single source of truth.
- **How to change your mind later:** Settings → Auto-restart & shut down → `backupIncludePlugins`.
  `continuum_status` always reports the value that is in effect right now
  (`backupIncludePlugins: true | false`).

### The one-time new-feature announcement (upgrades)

**The gap it closes.** The install question above is asked exactly once — on the *first* install. An
installation that already existed therefore never hears of a feature that was added later: for an
upgrade the new moon button would simply not exist. Since **0.5.0** every new feature is announced
once, in the same composer dock, as a small card:

> **New feature: graceful shutdown**
> There is a new 🌙 "Shut down" button at the very bottom of the left sidebar.
> Click it → once every conversation is done it counts down **N** seconds and powers the machine off.
> To change that, go to "Settings → Auto-restart & shut down".
> **Got it**

- **Only after an upgrade.** The host compares the version of the feature with the version it has
  already shown (`seenFeatureVersions` in the checkpoint file). A fresh installation never sees the
  card: the install question already explains the features, and answering it marks the announcement
  as seen.
- **"Seen" means "not older", not "equal".** The card counts as answered as soon as the recorded
  version is **not older** than the current feature version — a record of `0.6.0` counts as seen
  while the feature itself stands at `0.5.0`. Why not equality? Because the record does not say
  *which* release the user answered on (until 0.6.0 the card carried the version of the package),
  so an equality check would tell a user who already dismissed the card that they never saw it. A
  record that is not a version at all counts as seen as well: a broken record must not make the
  card come back for ever.
- **Once per feature version, for ever.** "Got it" records the version, the card disappears at once,
  and it never comes back — not with the next restart of the host, and not with the next release of
  the plugin (a *newer version of the feature* is announced again, of course).
- **The announcement follows the FEATURE, not the release.** The version it carries is a constant in
  the source (`SLEEP_FEATURE_VERSION` in `index.js`), **not** the version of the package: a release
  never brings the card back. Until 0.6.0 the card carried the package version, and every release
  (0.5.0 → 0.6.0) brought "graceful shutdown" back to the users who had already answered it.
- **How to announce it again on purpose.** Raise `SLEEP_FEATURE_VERSION` to a version **newer** than
  the one that was recorded last: the card is then shown exactly once more. Do that **only** when
  the feature itself changed so much that the user has to hear about it again (the shutdown became a
  completely different thing, the button moved somewhere else, …). A release, a bug fix or a small
  addition must **not** touch it — that is exactly the bug this constant exists to prevent.
- **An unanswered card is not swallowed.** The card stays until it is answered, and it comes back with
  the next start of DSH.
- **The countdown is read, not written.** The seconds in the card are the ones that are really in
  effect (`sleepCountdownSeconds`), and when the moon button is switched off the card says so
  ("The button is currently switched off; you can turn it on in the settings").
- **Where the state lives.** `<DSH_HOME>/storages/dsh-autorestart/state.json`, next to the checkpoint
  of the plugin. The host serves it on `GET /announcements` (`{ ok, pending: [{ feature, version }] }`)
  and records it on `POST /announcements` (`{ feature }`). The `version` in that answer is the feature
  version — the same number that `SLEEP_FEATURE_VERSION` holds.

## 0.8.6: what is backed up, the three signals, and the edge of the watchdog

> This chapter covers the 0.8.6 release notes. The Chinese original of the same chapter is in
> [docs/README.zh.md](docs/README.zh.md). It only answers the four questions an ordinary user asks:
> **what is backed up, how many signal layers there are, what the watchdog can save, and what to do in
> which order when something is off.** Implementation details live in the sections above.

### 1. What is backed up, and what is not

| | In the backup | Why |
|---|---|---|
| **Backed up** | the profile configuration (`cordis.patch.yml`, `package.json`, `pnpm-lock.yaml`) **plus the plugins you wrote yourself and installed as a link (`link:`)** — their contents are kept separately in `node_modules-link/<name>/` — **never their `.git`** (history is rebuildable from its remote, and it was the bulk of every copy: one linked plugin, 962 files / ~74 MB). A sweep also removes directories holding neither a manifest nor a configuration file, at most 32 dirs / 2 GB per pass, and reports every removal. An incomplete copy never carries a backup's name at all: it is written as `.staging-<stamp>` and renamed only once its manifest and configuration are on disk, so an interruption leaves a staging directory instead of something that looks restorable. **The boot sweep does not remove those `.staging-*` leftovers** (it skips every dot-named directory on purpose, so it never deletes a copy that is being written right now) — they are simply never listed and never restored from, and removing them by hand is safe | the plugins you write have **no definite source and no definite version**: delete one and nothing can fetch it again, so a backup is the only way |
| **Not backed up** | **third-party plugins** (installed from npm) | they **do have a definite source and version**: `pnpm-lock.yaml` pins every package's version and integrity hash, so reinstalling brings back **the version from the backup, not the latest one** — a backup would be redundant, and reinstalling is more reliable than a copy |

- Measured (from 2026-11-01 the slim backup is the default): one backup went from 308 MB to about 100 MB.
- `backupIncludePlugins: false` → configuration only (about 66 KB, finished instantly). With that setting
  **a plugin problem cannot be rolled back, it has to be reinstalled by hand**, and the settings page says so.
- The old full-copy behaviour is still there: `slimBackup: false`.

### 2. The three signal layers: two are certain, one is only a clue

On every boot the plugin compares three layers against the list the previous boot recorded
(`plugin-watch.json`):

- **tool names** (`tools`) — plugins that provide tools (codekg, vault, release-board and the like);
- **interface modules** (`clientModules`) — plugins that draw something in the interface;
- **registered packages** (`packages`) — packages that register a schema.

| Signal | Strength | What it proves | What it does not prove |
|---|---|---|---|
| **a tool name disappeared** | **certain** | these features really did not come up this time | which plugin caused it |
| **a registered package disappeared** | **certain** | this package did not load this time | whether the files are wrong or the configuration disabled it |
| **a plugin's files differ from the backup** | **clue** | this plugin may have been changed (it may also be your own edit, or an upgrade) | **not the same as broken** — a plugin whose files are all correct and that fails while loading is invisible to this layer |

Three more limits belong right here:

- **interface modules that map to no installed plugin** are counted and reported separately
  ("also N interface module(s) did not appear this time"); they are **never attributed to a plugin** —
  when the owner cannot be identified, no owner is guessed.
- **a layer that cannot be read means "no news", never "gone"**: when a host upgrade changes the shape of
  some API, the only possible answer is "this layer could not be seen this time", never "your plugin is gone".
- **the file comparison uses the set of relative paths plus each file's size**, it never hashes a whole tree
  (a real profile is about 150 MB). So it does find "a file was changed / deleted / is absent from the backup",
  and it **does not find** a plugin whose files are all correct but which fails while loading (a missing peer
  dependency, a throwing initialiser, a version the host refuses).

### 3. "Inconsistent" is not the same as "broken" — the hard wording rule

The popup and the settings page may only say two things:

- "**these features did not come up this time**" (a certain fact — it already happened, it is not a guess);
- "**these plugins differ from the backup**" (a difference list, with no conclusion drawn from it).

**Never write "the plugin is broken"**: differing from the backup may simply mean you edited it, or upgraded
it. The status word of a row in the settings page is only
`fine` / `differs from the backup` / `not in the backup` / `not installed` / `cannot tell (no backup to compare
against)` — there is no "broken" state.

### 4. The watchdog: what it does

- **Configurable**: `watchdogEnabled`, **on by default**; with it off, a new version that does not start has
  to be handled by hand.
- **It only stands watch inside one window**: a restart that **this plugin** started. After the host is
  replaced it waits for the new instance and asks **that instance's own** health route (never the old
  instance, never the old port), then works in a fixed order: **restore the newest backup whose
  identity is `known-good` → clear the stale `dsh-auth-*` handshake cookies → start the host again →
  wait for the ready marker**.
- **Three possible triggers, one chosen from what this machine can do and reported honestly**: a Windows
  scheduled task / a systemd user timer / a background process of its own; **with none of the three this
  machine has no automatic rollback** and the settings page says exactly that.
- **Bounded retries**: 3 by default (hard ceiling 10), with a backoff between passes, and the three questions
  (is it up / is an instance alive / does health answer) are asked again before every start.
- **Every attempt reaches the disk**: `<stateDir>/last-watchdog-report.json` — which tier, how many attempts,
  and per attempt the restore / cookie clear / relaunch / ready, plus why it stopped. A report that never
  reaches the disk is a report that never happened.
- **A restart that goes FINE writes its ending too**: when the new host comes up and the watchdog stands
  down, the report is updated to say so (`result`/`stage`/`outcome: 'disarmed'`, `hostReady`, `disarmed`,
  `disarmedAt`, and a `disarm` block). Before that, the file stayed at `armed` forever for a restart that
  had already finished — while `health` correctly answered `ready:true`. The old fields are kept
  untouched, and `previousResult` still says what the file said before (usually `armed`).
- **The capability probe's tasks are cleaned up**: proving that this machine can create a one-off task
  means creating one — and deleting it as the probe's last step, which a crash leaves behind (two were
  found on a real machine). The boot disarm now removes every leftover task whose name starts with this
  plugin's own probe prefix (`dsh-autorestart-capability-probe-`) and **never** matches anything else;
  the name reported for a root-folder task carries a leading `\` (`schtasks` prints `\task-name`), so one
  leading backslash is stripped before comparing — and a name that still contains a `\` afterwards is a task
  inside a folder and is refused, never deleted;
  what it removed (and what it could not) is written into the disarm record and the log, and a refusal
  never prevents the host from coming up.

### 5. The watchdog's blind spots (say them out loud)

**What it can save**: **a plugin problem of its own making that keeps DSH from booting** — one snapshot is
restored and the host is started again.

**What it cannot save** (this list matters more than the line above):

- **the DSH binary itself or the system environment** (a broken host upgrade, missing environment
  dependencies). It repairs no bug of the host: a host that dies for the same reason every time only ends as
  `failed`, with a report that names the attempts;
- **third-party plugin problems** — it only looks at its own snapshot: it neither diagnoses which plugin
  caused the failure nor fixes a third-party plugin's bug;
- **a full disk, permission problems, changes made by a system update** — restoring a snapshot does not solve
  any of those;
- **everything outside the restart window** — a host killed by the system at 03:00, a client that is
  start-and-die on a manual double-click, a morning with 0 processes: at that moment **nobody is on watch**
  (the plugin died with the host and no one-off item was ever registered), and all that is left is
  `scripts/restore-profile.cmd`, double-clicked by hand;
- **`watchdogEnabled: false`, or a machine whose tier is `none`** → no automatic rollback, and the settings
  page says so.

### 6. The four steps after something went wrong

1. **look at the popup** — it appears by itself after a restart and says two things separately: which
   features did not come up this time, and which plugins' files differ from the backup;
2. **or open the "plugins" section in the settings page and press "check now"** — every installed plugin is
   listed with its current status (`fine` / `differs from the backup` / `not in the backup` / `not installed`
   / `cannot tell`);
3. **a plugin you wrote yourself → press "restore"** — only **that one** named plugin is put back to the
   version in the backup: the live directory is renamed to `<name>.broken-<ts>` as evidence (`broken` is just
   the name of that evidence directory, not a conclusion) and **nothing is ever deleted**; every other plugin
   and `package.json` / `cordis.patch.yml` stay byte-identical;
4. **a third-party plugin → reinstall the version the popup names** — the panel gives the command, and what
   comes back is **the version recorded in the backup (not the latest one)**; when the backup does not record
   the version, the panel says so plainly ("it can only be reinstalled by name").

One precondition behind all four steps: **when there is no usable backup the plugin changes nothing for
you** — it says "it has to be handled by hand" instead of pretending it restored something.

## Graceful shutdown (收工关机)

**What it does.** One moon button at the very bottom of the left sidebar: press it and the plugin
waits until **every** conversation is idle, the screen counts down (a huge number and a small blue
whale, one line of text per second), and then the machine is switched off. The countdown can always
be cancelled — the card has a button, and the moon button itself becomes a toggle while the shutdown
is armed. If a conversation starts working again during the countdown, the countdown goes back to
"waiting" and nothing is switched off.

### Which machine gets switched off?

The plugin works out where it runs and switches off **that machine** — and the label in the
settings says which one, so there is no guessing:

| Where DSH runs | What the shutdown switches off | The label you see |
|---|---|---|
| The Windows desktop app | that Windows computer | "Switch off this Windows computer" |
| `dsh web` on Windows | that Windows computer | "Switch off this Windows computer" |
| `dsh web` on a Linux host | that Linux host | "Shut down this Linux host" |
| **`dsh web` inside WSL** | **the whole Windows machine** (not the little WSL box!) | "The DSH inside WSL → switches off the whole Windows" |
| A container | nothing at all (there is no command) | "This machine has no reliable way to switch off" |

> ⚠️ **A shutdown countdown inside WSL means your whole machine goes down** — not just that
> web service. WSL is a small Linux environment *inside* Windows; shutting that environment
> down would only stop the distribution. To switch off the **host**, the plugin goes through
> the mounted drive: `shutdown.exe` (`/mnt/c/Windows/System32/shutdown.exe /s /f /t 0`), with
> `powershell.exe -Command "Stop-Computer -Force"` and `cmd.exe /c shutdown.exe /s /f /t 0`
> as the fallbacks. In other words: **the host goes off.**

**How far this is verified.** The *plan* is verified for every platform
(`test/sleep-plan-posix.test.mjs`: inside WSL the plan must take the "switch off the whole
Windows" branch, a plain Linux plan must not contain a single Windows command, and a machine
without a way to switch off has an empty command and **executes nothing**). The real power-off
is verified on **Windows**; on POSIX it is deliberately **not** switched off for real — a
common-sense fact is not worth ending every session on the machine for.

The full picture per platform is in [`docs/platform-matrix.md`](docs/platform-matrix.md).

### Shutdown and restart: who goes first

**The short version.** Pressing the moon button means "switch the machine off when the work is
done" — **not** "switch it off right now, whatever else is running". So:

1. **A pending restart wins.** If a restart is still on the list, the shutdown does **not** happen.
   The card says *"Waiting for the pending restart to finish before shutting down"*. The restart
   goes first, the sessions come back with it and keep working, and only then does the machine
   go off.
2. **The work keeps running after the restart.** The sessions that resume with the restart are
   running work: while any of them is busy, the shutdown waits. The machine only goes off when
   **every** session is idle again.
3. **The shutdown intent survives the restart.** You pressed the button **once**. The restart does
   not swallow that request: it is written into the checkpoint file, and the new boot picks it up
   and keeps waiting for the work. You do **not** have to press the button a second time.
4. **You can cancel at any time.** The waiting card has a *"Keep it on"* button; pressing it (or the
   moon button again) forgets the intent for good.

**Where the intent lives.** In the checkpoint file
(`<DSH_HOME>/storages/dsh-autorestart/state.json`) as `sleep: { armed, armedAt, countdownSeconds }`.
It is cleared as soon as the machine went off, when the shutdown failed, and when you cancel. A
record that cannot be read is dropped — asking once more is much better than a machine that switches
itself off for ever because of a half-written file.

**For the troubleshooting.** `GET /sleep` reports `armedAt` (when the shutdown was armed) next to
`phase`, `blockers`, `countdownSeconds` (the countdown that is really running) and
`restartGraceMs` (the restart reserve).

### Troubleshooting: the machine did not switch off

**These are the real answers of a running host** (the copy of the host is Chinese, the fields are
not):

```
POST /__dsh_autorestart/sleep {"action":"arm"}   # three conversations are working
→ phase=waiting  armed=true  remainingMs=20000   (the full value: the countdown has NOT started)
  message: 等 3 个任务收工，收工后开始倒数。

# after a restart was requested:
GET /__dsh_autorestart/sleep
→ phase=waiting  armed=true  remainingMs=20000
  message: 等这次重启完成后再关机……
  blockers: [{"sessionId":"restart-pending","kind":"restart-pending",
              "label":"待执行的重启","name":"待执行的重启"}]
```

`remainingMs` at its full value is the tell: **the countdown has not started**, so the machine is
waiting for something. Here is what it can be, and what to do about it:

1. **Some tasks are still working.** `blockers[]` lists them; look at `kind`:
   `session` is a conversation, `subagent` is a child agent of one. A subagent counts as work on
   purpose — otherwise a restart would cut it off. **What to do:** let it finish, or stop that
   conversation. The list shrinks on its own.
2. **A restart is still pending.** `kind` is `restart-pending` (`label`/`name` are
   `待执行的重启`). That is normal queueing, not a fault: the restart runs first, the sessions
   come back with it, and the countdown continues afterwards. **What to do:** nothing — wait for
   the restart. (You can also cancel the restart with `continuum_cancel_restart`.)
3. **The work just ended and the countdown has not started yet.** The shutdown has **no invisible
   reserve**: as soon as every conversation is idle the countdown starts. **What you see:**
   `phase` is `waiting` while `blockers[]` is empty and `remainingMs` is at its full value only
   while the conversations are still busy — with an empty list the countdown is already running.
   **What to do:** nothing; the countdown is on the screen and it can be cancelled there. (The
   restart has its own window — `restartGraceMs`, default none — and the two never influence each
   other.)
4. **Somebody started working during the countdown.** The countdown goes back to "waiting" and
   `remainingMs` returns to its full value. **What you see:** the message says that somebody
   started working again, and `blockers[]` lists who. **What to do:** let them finish.
5. **You want to know who it is waiting for.** `continuum_status` → `blockedBy[]` and
   `GET /sleep` → `blockers[]` are the **same data**: the first is for agents, the second for
   scripts. Each entry has `kind` (what it is), `label` (the title of the session) and `name`
   (the whole name, e.g. "the subagent of the coding session"). A session whose title could not
   be resolved reports `label: null` and an empty `name` — that is why the waiting line then
   only says "等 3 个任务收工" without a list of names.
6. **You do not want it at all.** The cancel button on the waiting card (or the moon button
   again, or `POST /sleep {"action":"cancel"}`) clears the intent for good: `armed` becomes
   `false` and `armedAt` becomes `null`.

**Where the button is.** The moon button sits at the **very bottom of the left sidebar, right next
to the Settings row** (`sidebar.footer.action`). That seat is a **root** slot, so the button is
there even when no conversation is open — on any page. When the sidebar is collapsed into its narrow
rail, the button shows its icon only (the tooltip and the accessible name still say what it does),
so the rail keeps its width.

**The countdown does not cover the interface.** The countdown is a **floating card** in the corner,
not a full-screen mask: it never dims the page, never locks the scrolling and never swallows a
click. You can keep reading the conversation, keep scrolling and keep switching conversations while
it counts down; only the card's own cancel button takes clicks. Switching a conversation or a page
does not interrupt the countdown either — the seconds come from the host, not from the view that
happens to be open.

**What gets switched off: the real host.** Not a subsystem — the whole machine:

| Host | Command |
| --- | --- |
| Windows | `shutdown.exe /s /f /t 0` |
| WSL (the DSH itself runs inside a distribution) | `/mnt/c/Windows/System32/shutdown.exe /s /f /t 0` — the Windows binary through the mounted `C:` drive, so **Windows itself** goes down. The WSL subsystem is never shut down. |
| A real Linux host | `systemctl poweroff` (fallback `shutdown -h now`) |
| macOS | `osascript -e 'tell application "System Events" to shut down'` |
| Anything else | **Nothing is executed at all.** The button stays hidden and the route reports `phase: "unsupported"`. |

A WSL host is recognised through `WSL_DISTRO_NAME`, `WSL_INTEROP`, a `/proc/version` that mentions
Microsoft, or the mounted Windows binary. The countdown belongs to the plugin, so the operating
system is asked to shut down immediately (`/t 0`) instead of counting down a second time.

**Configuration.** `showSleepButton` (default `true`) decides whether the button is shown,
`sleepCountdownSeconds` (a **dropdown**: `0` / `10` / `20` / `30` / `60` seconds, default `20`) how
long the countdown runs, and `sleepCommand` (default `''`) replaces the detected command with one of
your own — empty means "detect the host automatically". `0` means **no countdown at all**: the machine
is switched off as soon as every conversation is idle (a busy conversation still blocks it), and no
countdown card appears. A profile that still carries a value the dropdown does not offer (`15`,
`45`, …) is snapped onto the nearest offered one instead of breaking.

**One click is all it takes.** The moon button arms the shutdown: the host waits for every busy
conversation, counts down **20 seconds** in a floating card (it never covers the interface), and then
switches the machine off. Clicking the button again — or the cancel button on the card — takes it
back. Nothing else is asked of the user: no confirmation dialog, no second click.

**The desktop client and the hosted web client behave exactly the same.** There is no ticket, no
extra header and no hidden mode: `POST /__dsh_autorestart/sleep` takes nothing but the action, and
the same route serves both. A script (or an agent) can therefore drive the shutdown as well:

```bash
# arm it (the machine counts down and goes off)
curl -s -X POST http://127.0.0.1:<port>/__dsh_autorestart/sleep \
  -H 'content-type: application/json' -d '{"action":"arm"}'
# take it back
curl -s -X POST http://127.0.0.1:<port>/__dsh_autorestart/sleep \
  -H 'content-type: application/json' -d '{"action":"cancel"}'
```

**The one-time install question.** The first time the plugin is used, the composer dock asks once
more whether the button should stay. The answer is written into the profile configuration
(`showSleepButton`) through the same `configEditor` service the backup question uses, so the
settings section and the prompt always show the same value.

**The settings section.** *Settings → Auto-restart & shut down* is a section of its own in the
settings sidebar (right below the Agent presets). It is split into two titled groups — the restart
settings first, the shutdown settings after them:

- **Restart settings**
  - **Wait before the restart** (`restartGraceMs`) — the dropdown `0` / `5` / `10` / `20` / `30` /
    `60` seconds. `0` (the default) means "no extra wait": the host restarts as soon as the
    conversations are done.
  - **Backup before a restart** (`backupOnRestart`) — whether the pre-restart snapshot is taken at all.
  - **Include the installed plugins in the backup** (`backupIncludePlugins`) — whether that snapshot
    also contains the plugin directory of the profile. It is greyed out when the backup itself is off.
- **Shutdown settings**
  - **Shutdown countdown seconds** (`sleepCountdownSeconds`) — the dropdown `0` / `10` / `20` / `30` /
    `60`. `0` means "no countdown": the machine is switched off as soon as every conversation is idle.

A change is written into the profile configuration at once (through the plugin's own choice route)
and is read back from the host, so the section never shows a value the host did not take. A malformed
value is refused with a **400** and **nothing** is written.

**Trying it without switching anything off.** Set `DSH_AUTORESTART_SLEEP_DRYRUN=1` in the host
environment: the plugin then reports the command it *would* run and never runs it.

**The machine-readable state.** `GET <healthPath 前缀>/sleep` (default
`/__dsh_autorestart/sleep`) answers with the phase, the countdown and the host that is about to be
closed. A few of its fields are meant to be read by code rather than by a human: `host.kind` is the
kind of machine (`windows`, `wsl`, `linux`, `macos`, `unsupported`, or `custom` when the platform
could not be recognised but a `sleepCommand` was configured); `host.suspect` is `true` when the host
was only recognised as WSL because the Windows drive is mounted — a hint, not a proof;
`lastRun.dryRun` marks the last run as a rehearsal that switched nothing off; and
`backupOnRestart` / `backupIncludePlugins` report the effective scope of the pre-restart backup.

**The record of the last restart.** `GET <healthPath>?state=1` and the `continuum_status` tool both
report `lastRestart`: the snapshot that was taken before the restart (`snapshot.dir`,
`snapshot.stamp`, `snapshot.atLocal` — the local time, because the directory name is UTC —,
`snapshot.durationMs`, `snapshot.pruned`) and the verdict of the instance that came up
(`result` is `pending`, `ok` or `failed`, plus `verifiedAt`, `durationMs` and the four boot checks
`listener` / `routes` / `plugin` / `recovery`). A restart whose new instance never came up stays
`pending` — that is visible too. The file behind it is
`<stateDir>/last-restart-verdict.json`.

**Who starts this host.** The `supervisor` block of the same payload says `mode`
(`app` / `installed` / `external` / `unknown` / `off`), `restartCapable`, and — since a second supervisor
would fight over the port — `selfReplay` (`allowed` / `refused` / `unknown` / `n/a`) plus the `external`
evidence (`kind`, `evidence`, `commandLine`) when somebody else is in charge. On Linux the parent
chain of the host is read (`/proc/<pid>/cmdline`), so a `supervise-*.sh` script of the user is
recognised. When nobody can be identified the mode is `unknown`, never a silent "bare host": the
plugin then refuses to replay its own command. The **desktop app** is never `unknown`: it brings
itself back up, so it reports `mode: "app"` with `restartCapable: true` and `selfReplay: "n/a"`.

**When the shutdown command does not start.** The host waits for the real answer of the process. If
the command cannot start (missing binary, denied permission), the shutdown does **not** pretend it
worked: the phase goes back to `idle`, the reason is reported ("the shutdown command did not start
(…), the computer is still on, press the moon button again"), and the machine stays on. On screen
the "shutting down" card never locks the interface: after at most eight seconds it offers a button
that closes the card.

## Requirements and limits

- **Windows desktop.** `restartMode: app` restarts the DSH desktop app on Windows. Any other
  platform, and every hosted `dsh web` deployment, has to use `restartMode: command` with its own
  restart command.
- **The manual-restart guard is pattern matching, not a sandbox.** It looks at the command text for
  kill and restart verbs together with DSH process names or the pid of this host. Encoded commands,
  killing by image name, and routes around the guard — a GUI menu, an external script, a system
  reboot — are not covered. It exists to stop an agent from casually killing itself, not to contain
  a hostile command.
- **A session past the model context window cannot continue.** Once a conversation has grown beyond
  the model context window, the provider rejects every request with `invalid_request_error`, and the
  host's own compaction cannot rescue it because the compaction request needs the same oversized
  context. Hand such a session over with `continuum_handoff`; the plugin deliberately refuses to
  auto-resume it.
- **A hosted deployment must let the browser read the state route.** The pending restart pill reads
  `GET <healthPath>?state=1`. The route accepts loopback callers and requests that the host
  connection service considers authenticated browsers. A hosted deployment that blocks it will never
  show the pill.
- **The restart closes and reopens the desktop window.** It is a full app restart, not a hot reload.
- **The resumed round consumes API tokens**, exactly like typing "continue" by hand.

### Hosted `dsh web` deployments

| Deployment | `restartMode` | How the host is restarted |
| --- | --- | --- |
| DeepSeek Harness desktop app (Windows) | `app` (the default) | The host's own app restart: the old process tree is killed and the desktop app is relaunched |
| A hosted `dsh web` deployment | `command` | There is no "restart the app" in a web deployment — you must supply the command yourself |

Minimal configuration for a hosted `dsh web` (it **replaces** the whole `config` block, it is not merged):

```yaml
- id: dsh-autorestart
  config:
    restartMode: command
    restartCommand: systemctl --user restart dsh-web
```

`restartCommand` may use the placeholders `{pid}` (this host), `{ppid}` (its parent) and `{app}` (the desktop
app path).

**Without that configuration the restart fails, and it says so.** A hosted host is not the desktop app, so
the plugin has no way to relaunch it: the log gets
`no restart method available (not the desktop app and restartCommand is empty); leaving the checkpoint in place`,
the pending restart is rolled back (one retry with a backoff, then it is cancelled instead of retrying
forever), and nothing is relaunched — the checkpoint simply stays on disk, so the session is picked up again
when the host is started by hand. `continuum_status` keeps reporting the pending state until it is cancelled.

The same profile row is what the one-time install question writes into: a hosted profile that declares no
`dsh-autorestart` row has no row for the `configEditor` service to edit, so the answer falls back to
`<DSH_HOME>/storages/dsh-autorestart/install-choice.json` instead of the profile configuration. Declaring the
row keeps the profile (and therefore the settings section) as the single source of truth.

## Verify

The health route tells you whether the plugin is alive and what it has done:

```sh
curl http://127.0.0.1:<gui port>/__dsh_autorestart/health
# {"ok":true,"plugin":"dsh-autorestart","bootId":"…","pid":17884,"phase":"running",
#  "pageHeartbeat":true,"systemPrompt":true,"configSchema":true,"indexTaps":1,…}
```

`bootId` and `pid` change with every new process, so a restart is visible right away.

- `?state=1` returns the pending restart state: `pendingRestart`, `waiters`, `blockedBy`,
  `allowRestart`, `quietForMs`, `settleMs`, `parkedGoals`, `recovery` and `handoffs`.
- `?probeIndex=1` applies the page heartbeat injection to a probe HTML page, so the client half can
  be checked without an authenticated page.
- `?gate=1` returns the live idle gate verdict that the detached helper uses before it kills
  anything.
- `POST /__dsh_autorestart/park` disarms a goal, `POST /__dsh_autorestart/recover` re-runs the
  recovery immediately. Both use the same authentication rules as the health route.
- `GET /__dsh_autorestart/sleep` reports the state of the graceful shutdown, `POST
  /__dsh_autorestart/sleep` arms (`{ "action": "arm" }`) or cancels (`{ "action": "cancel" }`) it.
- Inside a session, `continuum_status` reports the same lifecycle.

The plugin ships its own test suite: **250 test cases** in `plugins/dsh-autorestart/test/`, all
green. Run it with the bundled Node, from the workspace root:

```sh
node --test "plugins/dsh-autorestart/test/*.test.mjs"
```

Node 24 treats a positional argument as a glob, so keep the quotes. The same suite also runs with
a bare `node --test` from the package directory. Passing the directory itself (`node --test
test/`) does not work: the argument is read as a glob, and a glob does not match directories.

## Screenshots

![dsh-autorestart icon](assets/icon-180.png)

![dsh-autorestart screenshot 1](assets/screenshot-1.png)

![dsh-autorestart screenshot 2](assets/screenshot-2.png)

![dsh-autorestart screenshot 3](assets/screenshot-3.png)

## License

MIT — see [LICENSE](./LICENSE).

## Submitting to the curated plugin list

The curated list lives in the `awesome-dsh-plugin/awesome-dsh-plugin` repository, and one pull
request that adds a single file is the whole submission: `data/plugins/<owner>__<repo>.yml`. For
this plugin that file is `data/plugins/Eason-22__dsh-autorestart.yml`:

```yaml
url: https://github.com/Eason-22/dsh-autorestart
name: Eason-22/dsh-autorestart
category: session
description:
  en: 'DeepSeek Harness plugin: restart without losing work, with an idle-aware graceful restart and automatic session resume after the host comes back.'
  zh: 'DeepSeek Harness 插件：重启不丢工作——等所有对话空闲后优雅重启，重启后自动接续被打断的会话。'
icon: https://raw.githubusercontent.com/Eason-22/dsh-autorestart/main/assets/icon-180.png
```

The list's CI checks that the repository declares a `dsh.bundle` manifest, that the repository is
at least one day old (the check re-runs by itself, so no need to resubmit), that the repository
exists and is not archived, and that a pull request adds at most three entries. Descriptions are
read as claims about the plugin and are checked against the code, so keep them factual and free of
marketing. The marketplace icon must be a GitHub-hosted raster image (png, jpg, jpeg or webp; SVG
is refused) — this repository ships `assets/icon-180.png` — and the optional `screenshots.json` next
to `package.json` lets the storefront show the images listed in `assets/`. The two READMEs of the
list are generated from the entry files; do not edit them by hand.

## AI-generated notice

This plugin was generated by an AI and has **not** been reviewed by a human. It restarts your DSH
process and writes local state files, so it can interrupt a running session. Try it in a test
profile first, evaluate the risk yourself, and only then use it in your daily profile.
