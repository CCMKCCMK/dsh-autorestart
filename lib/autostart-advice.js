/**
 * dsh-autorestart — THE "START AT LOGIN" GUIDE OF EVERY PLATFORM.
 *
 * A hosted web host can be started in a dozen ways, and "start at login" means
 * something different on every platform. The plugin therefore hands out ONE
 * piece of advice per platform, and it always says what the record really is:
 *
 *   | platform              | what the plugin does                                      |
 *   |-----------------------|----------------------------------------------------------|
 *   | Windows               | a scheduled task (`/SC ONLOGON /RL LIMITED`, no admin); when the machine refuses it, a `.cmd` in the startup folder. The command is a REAL node + supervisor.js — never the app executable. |
 *   | Linux (not WSL)       | a systemd USER service (`systemctl --user`, no admin) — plus the `loginctl enable-linger` hint, because without the linger it only starts after a login. |
 *   | WSL with systemd      | the same systemd user unit, plus the linger hint.         |
 *   | WSL without systemd   | NO "at login" at all: two ways out (turn systemd on inside WSL, or let Windows start the distribution). NEVER Docker/Compose. |
 *   | container / k8s       | no promise at all: the orchestrator brings it back (compose `restart: always`). |
 *   | unknown               | nothing is installed and nothing is guessed: the user is told why and asked to choose. |
 *
 * The advice is a pure function of its input, so every branch is testable
 * without a machine.
 *
 * ESM only, Node builtins only.
 */

import { HOST_KINDS } from './host-kind.js'

/** The kinds of the advice (one per platform). */
export const AUTOSTART_ADVICE_KINDS = Object.freeze({
  /** Windows: a scheduled task (with the startup folder as the fallback). */
  WINDOWS: 'windows-task',
  /** Linux: a systemd user service (+ the linger hint). */
  LINUX: 'linux-systemd',
  /**
   * Linux WITHOUT systemd: there is no "at login" at all, and the plugin
   * installs nothing (the installer refuses on such a machine).
   */
  LINUX_NO_SYSTEMD: 'linux-no-systemd',
  /** WSL with systemd: the same, and the linger is the missing piece. */
  WSL_SYSTEMD: 'wsl-systemd',
  /** WSL without systemd: the user has to pick one of two ways. */
  WSL_MANUAL: 'wsl-manual',
  /** A container: the orchestrator decides. */
  CONTAINER: 'container',
  /** Nobody can tell: nothing is installed, nothing is guessed. */
  UNKNOWN: 'unknown',
})

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The advice of one platform.
 *
 * @param {{
 *   host?: { kind?: string, suspect?: boolean, distro?: string, evidence?: string },
 *   platform?: string,
 *   hasSystemd?: boolean,
 *   container?: boolean,
 *   user?: string,
 *   distro?: string,
 *   startCommand?: string,
 *   command?: string,
 * }} [options]
 * @returns {{
 *   kind: string,
 *   reason: string,
 *   notes: string[],
 *   commands: string[],
 *   options: Array<{ id: string, label: string, command: string, cost: string, recommended: boolean }>,
 *   canInstall: boolean,
 * }}
 */
export function planAutostartAdvice(options = {}) {
  const host = options.host && typeof options.host === 'object' ? options.host : {}
  const platform = text(options.platform) || text(host.platform) || process.platform
  const kind = text(host.kind)
  const suspect = host.suspect === true
  const user = text(options.user) || text(process.env.USER) || text(process.env.LOGNAME) || '你的用户名'
  const distro = text(options.distro) || text(host.distro) || '你的发行版'
  const startCommand = text(options.startCommand)
  const command = text(options.command)
  const hasSystemd = options.hasSystemd === true
  const isContainer = options.container === true

  // A host that is only GUESSED to be WSL (the mounted Windows drive is the
  // only evidence) gets no automatic anything: the plugin says so and leaves
  // the choice to the user.
  const suspectNote = suspect
    ? '没把握：这台机器只是「挂载了 Windows 盘」才被猜成 WSL，插件不会替你改任何系统配置，建议你手动选一条。'
    : ''

  const linger = 'loginctl enable-linger ' + user

  // (1) A CONTAINER. The orchestrator brings it back — there is no "at login".
  if (isContainer) {
    return {
      kind: AUTOSTART_ADVICE_KINDS.CONTAINER,
      reason: '容器里没有「开机自启」这回事：由编排器负责（compose 的 restart: always / k8s 的 restartPolicy）。',
      notes: [
        '容器里没有「开机自启」这回事：由编排器负责（compose 的 restart: always / k8s 的 restartPolicy）。',
        '插件不会在容器里装 systemd —— 容器里也没有 systemd 可装。',
      ],
      commands: [],
      options: [],
      canInstall: false,
    }
  }

  // (2) WINDOWS. The scheduled task first, the startup folder as the fallback.
  if (kind === HOST_KINDS.WINDOWS || platform === 'win32') {
    return {
      kind: AUTOSTART_ADVICE_KINDS.WINDOWS,
      reason: 'Windows 托管端：登录时自启用**计划任务**（/SC ONLOGON /RL LIMITED，不需要管理员）；这台机器若不允许普通用户建计划任务，会自动降级到「启动文件夹」里的一个 .cmd（同样不需要管理员）。注册的命令是**真正的 node + supervisor.js**，不是 DSH 客户端本体。',
      notes: [
        '登录时自启：计划任务（/SC ONLOGON /RL LIMITED，零管理员权限）。',
        '这台机器拒绝计划任务时自动降级为「启动文件夹」里的 .cmd（同样零权限）。',
        '注册的命令是真正的 node + supervisor.js —— 绝不会用 DSH 客户端本体去跑守护脚本（那会在每次登录时再开一个 DSH）。',
      ],
      commands: command === '' ? [] : [command],
      options: [],
      canInstall: true,
    }
  }

  // (3) WSL. With systemd it is a user unit (+ the linger); without it there
  // is no "at login" at all — and NEVER a Docker answer.
  if (kind === HOST_KINDS.WSL) {
    if (hasSystemd) {
      return {
        kind: AUTOSTART_ADVICE_KINDS.WSL_SYSTEMD,
        reason: 'WSL 里有 systemd：守护装成 systemd 用户单元（登录后自启）。'
          + '若要「开机自启」（不必先登录），在 WSL 里运行一次：' + linger
          + (suspectNote !== '' ? suspectNote : ''),
        notes: [
          'WSL 里有 systemd：守护装成 systemd 用户单元（登录后自启）。',
          '若要「开机自启」（不必先登录），在 WSL 里运行一次：' + linger
            + '（只需一次；linger 让 systemd 在你没登录时也把这个用户的服务拉起来）。',
        ],
        commands: [linger],
        options: [],
        canInstall: true,
      }
    }
    const systemdOption = {
      id: 'wsl-systemd-enable',
      label: '① 在 WSL 内部开启 systemd',
      command: '在 /etc/wsl.conf 里加上 [boot] systemd=true，然后在 Windows 侧运行 wsl --shutdown 重启子系统',
      cost: '这是系统配置改动：要改发行版里的 /etc/wsl.conf，并且要重启整个 WSL 子系统（别的发行版和正在跑的进程会一起停）。',
      recommended: false,
    }
    const windowsOption = {
      id: 'wsl-windows-task',
      label: '② 在 Windows 侧用计划任务 / 启动文件夹拉起 WSL',
      command: 'wsl.exe -d ' + distro + ' -e ' + (startCommand !== '' ? startCommand : '<启动命令>'),
      cost: '需要 Windows 侧操作（新建一条计划任务，或往启动文件夹放一个快捷方式），但更接近真正的开机自启。',
      recommended: true,
    }
    return {
      kind: AUTOSTART_ADVICE_KINDS.WSL_MANUAL,
      reason: 'WSL 里没有 systemd：这里没有「登录时自启」这回事。'
        + '两条路（插件不会替你改任何系统配置）：① 在 WSL 内部开启 systemd；② 在 Windows 侧用计划任务/启动文件夹拉起 WSL（推荐）。'
        + (suspectNote !== '' ? suspectNote : ''),
      notes: [
        'WSL 里没有 systemd：这里没有「登录时自启」这回事，所以插件不装任何东西。',
        suspectNote !== '' ? suspectNote : '插件不会替你改任何系统配置，两条路都需要你自己动手。',
        '① 在 WSL 内部开启 systemd —— 这是系统配置改动（改 /etc/wsl.conf + 重启子系统）。',
        '② 在 Windows 侧用计划任务 / 启动文件夹拉起 WSL（推荐）—— 需要 Windows 侧操作，但更接近真正的开机自启。',
      ],
      commands: [windowsOption.command],
      options: [systemdOption, windowsOption],
      canInstall: false,
    }
  }

  // (4) LINUX (and every other real Linux).
  //
  // WITH systemd: a user service, and the linger that turns "after a login"
  // into "at boot".
  //
  // WITHOUT systemd (2026-11-02): the advice used to promise the same user
  // service on EVERY Linux — while the installer refuses on a machine with no
  // systemd (`STARTUP_NOT_INSTALLABLE`). The page then promised something the
  // install button could not deliver. Now the advice says what is true: there is
  // no "at login" here, the plugin installs nothing, and the user has to start
  // the host from their own supervisor / init script / rc.local.
  if (kind === HOST_KINDS.LINUX || platform === 'linux') {
    if (!hasSystemd) {
      return {
        kind: AUTOSTART_ADVICE_KINDS.LINUX_NO_SYSTEMD,
        reason: '这台 Linux 没有 systemd：这里没有「登录时自启」这回事，插件不会给你装 systemd 用户服务（这台机器没有 systemd 可装），也不会替你改任何系统配置。'
          + '想让宿主开机就起来，请用你自己的方式拉起它（rc.local、你的 init 脚本、或你在用的进程守护工具），命令就是启动这个宿主的命令行。',
        notes: [
          '没有 systemd：插件不装任何东西，也没有可以装的东西。',
          '需要你自己拉起宿主（rc.local / init 脚本 / 进程守护工具），用的是启动这个宿主的同一行命令。',
          '插件不会替你改系统配置 —— 这条建议只是告诉你「该怎么办」。',
        ],
        commands: [],
        options: [],
        canInstall: false,
      }
    }
    return {
      kind: AUTOSTART_ADVICE_KINDS.LINUX,
      reason: 'Linux 托管端：用 systemd 用户服务（systemctl --user，不需要管理员）。这是「登录后自启」；若要「开机自启」（不必先登录），运行一次 ' + linger + '。',
      notes: [
        'systemd 用户服务：登录后自启（零管理员权限）。',
        '若要「开机自启」（不必先登录），运行一次：' + linger + '（只需一次；没有 linger 就只是登录后自启）。',
      ],
      commands: [linger],
      options: [],
      canInstall: true,
    }
  }

  // (5) UNKNOWN. Nothing is installed, nothing is guessed.
  return {
    kind: AUTOSTART_ADVICE_KINDS.UNKNOWN,
    reason: '认不出这个宿主是怎么被拉起来的：插件不装任何东西，也不猜命令。请你手动选一条（或告诉插件该怎么拉起它）。',
    notes: [
      '认不出这个宿主是怎么被拉起来的：插件不装任何东西，也不猜命令。',
      '这是「宁可说不知道，也不双开」的保守做法 —— 请你手动选一条。',
    ],
    commands: [],
    options: [],
    canInstall: false,
  }
}
