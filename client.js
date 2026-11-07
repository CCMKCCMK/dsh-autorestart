/**
 * dsh-autorestart browser half: a compact "pending restart" pill and a
 * matching dot in the left sidebar session row.
 *
 * Classic script loaded by dsh-client-modules via `window.__ModuleLoader__.load`.
 * No JSX, no build step. Two surfaces read the Host's loopback-only health
 * route (`GET /__dsh_autorestart/health?state=1`):
 *
 *   - the pill in the composer tool row (`conversation.input.left` slot);
 *   - an 8px dot in the leading 16px state cell of a left-sidebar session row
 *     (`sidebar.session.row.leading` slot).
 *
 * Both are visible only for the session that is actually queued for the
 * restart (the session id must appear in the route's `waiters` list), and both
 * read ONE shared poller: the route is fetched once every 2s no matter how
 * many surfaces are mounted.
 *
 * Two upgrades on top of the plain marker:
 *
 *   1. an "imminent" pulse: when the restart is pending AND the Host's idle
 *      gate is open (`allowRestart`), the dot of both surfaces breathes. One
 *      shared `@keyframes` rule is injected into the document head (guarded by
 *      an id, removed when the last subscriber leaves) and applied through the
 *      `animation` style property, so it never changes the layout. Users who
 *      ask for reduced motion never see it;
 *   2. a click-to-open details panel: the pill is a keyboard-operable
 *      button that reveals why the restart is still pending, which sessions
 *      block it (by title when the Host provided one) and how long this
 *      session has been waiting.
 *
 * Goal-aware states on top of that:
 *
 *   - a blocker whose reason is `goal-active` is a session whose armed goal
 *     keeps driving rounds by itself, so it holds the restart on its own.
 *     The pill shows that state and offers a button which parks that goal
 *     and asks for the restart immediately (`POST <parkUrl>` with
 *     `{ sessionId, restart: true }`);
 *   - a blocker whose reason is `goal-exhausted` cannot be parked at all
 *     (the round budget of its goal is used up), so the pill explains that
 *     and offers no button for it;
 *   - the Host also reports the goals it already parked (`parkedGoals`): the
 *     pill says how many were parked and that they continue automatically
 *     after the restart, and the details panel lists them.
 *
 * Everything here is side-effect free until `apply(ctx)` runs: no timers, no
 * fetches, no DOM access at module scope.
 *
 * The graceful-shutdown ("sleep") half adds three more surfaces:
 *
 *   - the shutdown BUTTON at the foot of the left sidebar, beside the
 *     Settings row (`sidebar.footer.action` slot): a moon icon and the label
 *     "收工关机". That slot is a ROOT slot, so the button is there even when
 *     no conversation is open. It renders NOTHING at all when the Host says
 *     the button must not be shown, so no empty space is left behind;
 *   - the COUNTDOWN CARD in the shell's overlay layer (`shell.overlay`
 *     slot): a FLOATING rounded card with a very big number, a hand drawn
 *     whale (inline SVG + CSS keyframes, no image and no other plugin) and
 *     one funny line per second — plus a "算了，别关" button that cancels
 *     the shutdown. The card NEVER covers the interface: it sits in a corner,
 *     it lets every click through (only the cancel button takes clicks), so
 *     the conversation stays readable and the sidebar stays usable while the
 *     machine counts down. While the sessions are still working, a small
 *     corner card takes the place of the countdown card, so nothing is
 *     covered up;
 *   - the SECOND install question: the first install asks about the backup
 *     scope, and only after that answer was persisted does it ask whether the
 *     shutdown button should stay.
 *
 * All of them read the Host's `GET/POST {prefix}/sleep` route and share ONE
 * poller with the same 2s cadence as the pending-restart store.
 */

/* ------------------------------------------------------------------ *
 * The pure half of the graceful-shutdown ("sleep") feature.
 *
 * This file is a CLASSIC script: the client module loader evaluates a
 * plugin bundle as a same-origin external classic script, so the ESM
 * `export` keyword is NOT available here. The pure helpers are
 * therefore published in the two places a test can reach them:
 *
 *   1. as NAMED properties of this module's exports — the client module
 *      system materializes `factory(require) -> exports`, so the exports
 *      object carries `pickSleepCaption`, `shouldShowSleepButton`,
 *      `buildChoiceBody`, `formatRemainingMs`, `formatLongWaitNote`,
 *      `formatLongWaitNoteParts`, `groupBlockers`, `summarizeBlockers`
 *      and `truncateBlockerName`;
 *   2. on the global namespace `globalThis.__dshAutorestartClient`, which
 *      exists as soon as this file is evaluated (no factory call needed).
 *
 * The copy lives in the two dictionaries below. They are the SOURCE: the
 * Host registers them (`ctx.locale.register`), and locale/zh.json +
 * locale/en.json are their MIRROR (same keys, same words — a test holds the
 * three key sets together).
 *
 * The translator of this plugin NEVER shows a key name: the Host's
 * translator answers with the KEY when it does not know one (that is what
 * the DSH locale service does), and then the built-in dictionary answers.
 * ------------------------------------------------------------------ */

// THE WHOLE FILE IS ONE IIFE.
//
// The client module loader evaluates this file as a CLASSIC script, and the
// browser concatenates the client scripts of ALL the plugins into ONE bundle:
// they therefore share ONE global lexical scope. A top-level `const ZH` here
// collided with another plugin's `const ZH`, and the whole bundle died with
// "Identifier 'ZH' has already been declared" — every client plugin was dead
// and the desktop app could not start at all.
//
// Wrapping the file keeps every declaration of this plugin private to it: the
// bundle scope stays free of our names, so no other plugin can collide with
// them. The loader call at the end of the file still runs at the same moment
// as before, and nothing else changes.
;(function () {
  'use strict'

  /**
   * The browser-side record of the "keep the sleep button?" answer.
   *
   * The question is asked exactly once (on the first install), so the key is
   * written as soon as the user answers — or closes the prompt.
   */
  const SLEEP_BUTTON_KEY = 'dsh-autorestart:sleep-button-v1'

  /**
   * The longest countdown the settings page offers (60 seconds).
   *
   * The first twenty seconds have a line each; every second above that uses
   * the generic fallback line, so no offered length ever shows a blank.
   */
  const SLEEP_MAX_COUNTDOWN_SECONDS = 60

  /** The countdown length the settings page offers (a dropdown). */
  const SLEEP_COUNTDOWN_CHOICES = Object.freeze([0, 10, 20, 30, 60])

  /** The countdown length used when the Host did not report one. */
  const SLEEP_DEFAULT_COUNTDOWN_SECONDS = 20

  /** How long the note of a finished rehearsal stays on screen (ms). */
  const SLEEP_DRY_RUN_NOTICE_MS = 8_000

  /**
   * The RESTART reserve the settings page offers (a dropdown, in seconds).
   *
   * It belongs to the restart only: a restart is a daily operation, so it
   * should happen as soon as the conversations are done. The graceful shutdown
   * has no reserve of its own — its VISIBLE countdown is the wait before the
   * machine goes off.
   */
  const GRACE_CHOICES_SECONDS = Object.freeze([0, 5, 10, 20, 30, 60])

  /** The RESTART reserve used when the Host did not report one (ms / seconds). */
  const GRACE_DEFAULT_MS = 0
  const GRACE_DEFAULT_SECONDS = 0

  const ZH = {
    label: '待重启',
    busyPrefix: ' · 等待 ',
    busySuffix: ' 个会话',
    idle: ' · 空闲后自动重启',
    goalActive: ' · 被某个自动续跑的 goal 占着',
    goalExhausted: ' · 某个任务的 goal 轮次额度已用完，无法续跑',
    settling: ' · 还在等这段安静期',
    parkedGoals: ' · 已停泊 {n} 个 goal，重启后自动继续',
    parkButton: '停泊并重启',
    parkButtonAria: '停泊该会话的 goal，并立即请求重启',
    parkBusy: '停泊中…',
    parkError: '停泊失败：{message}',
    tooltip: '等待其他会话空闲后自动重启；重启后会自动继续本会话进度',
    tooltipBusy: '等待其他会话结束（计数含“排队但还没开始”的会话）后自动重启；重启后本会话会自动继续进度',
    tooltipWithError: '等待其他会话空闲后自动重启；重启后本会话会自动继续进度。{message}',
    dotAria: '待重启',
    panelHeading: '待重启',
    panelStateBusy: '等待其他会话空闲后重启',
    panelStateIdle: '等待空闲窗口后重启',
    panelStateGoalActive: '等待其他会话停泊它自动续跑的 goal',
    panelStateGoalExhausted: '等待其他会话的 goal（轮次额度已用完）',
    panelBlockedTitle: '占用会话：{title}',
    panelBlockedGeneric: '有一个任务正在运行',
    // One line per blocker: a session and a subagent are told apart, and
    // neither of them is ever shown as a raw session id.
    panelBlockedSession: '会话「{label}」正在运行',
    panelBlockedSubagent: '{name}正在运行',
    panelBlockedSubagentGeneric: '有一个子智能体正在运行',
    // The N subagents of ONE session are one line: the session is named once
    // and the number of its subagents says how many there are.
    panelBlockedSubagentGroup: '会话「{label}」的 {n} 个子智能体正在运行',
    panelBlockedSubagentGroupGeneric: '有 {n} 个子智能体正在运行',
    panelBlockedRestartPending: '等这次重启完成后再关机',
    panelGoalActiveLine: '占用会话「{title}」：goal 正在自动续跑（goal-active）',
    panelGoalExhaustedLine: '占用会话「{title}」：goal 轮次额度已用完，无法继续（goal-exhausted）',
    panelParkedTitle: '已停泊的 goal（重启后自动继续）：',
    panelParkedGoal: '会话 {session} · {goal}',
    panelWaiting: '已等待 {duration}',
    panelResume: '重启后本会话会自动继续进度',
    // The long wait: the restart is still waiting while a conversation runs on.
    // There is no deadline and nothing expires. The capsule is ONE clipped line: it holds a
    // number and a duration, NEVER a name. Every name goes into the tooltip,
    // where there is room for all of them.
    longWaitPill: ' · 已等 {duration} · {n} 项任务在跑',
    longWaitTooltip: '已等 {duration}。在跑：{blockers}',
    // The blockers of one list. They are grouped by the session that created
    // them (N subagents of one session are ONE item), the tooltip names them
    // ALL and the shutdown card lists them. One rule, two surfaces: the
    // tooltip of the capsule and the list of the shutdown card.
    blockerGeneric: '有会话',
    blockerJoin: '、',
    blockerGroupSubagents: '{label}（{n} 个子智能体）',
    blockerGroupSubagentsGeneric: '{n} 个子智能体',
    blockerMore: '…等 {n} 项',
    blockersTitleLine: '占用会话：{blockers}',
    durationSeconds: '{n} 秒',
    // A CANCELLED QUEUED RESTART, IN PLAIN WORDS (user report, 2026-11-03): the request
    // waited over two hours, then a host restart cancelled it and the page said nothing.
    // No internal identifier may reach the screen.
    'settings.restart.cancelledNote': '上次要的重启没有做成：你在 {at} 请求重启，等了 {waited}，它一直没有执行；这次宿主重启之后，那个请求已经被取消了。想重启的话，再点一次就行。',
    'restart.waitedSeconds': '几秒',
    'restart.waitedMinutes': '约 {n} 分钟',
    'restart.waitedHours': '约 {n} 小时 {m} 分',
    'restart.waitedHoursExact': '约 {n} 小时',
    durationMinutes: '{n} 分 {m} 秒',
    durationHours: '{n} 小时 {m} 分',
    // The COMPACT duration of the capsule: it can afford "16 分钟", not
    // "16 分 37 秒" — the capsule is one clipped line.
    durationMinutesShort: '{n} 分钟',
    durationHoursShort: '{n} 小时',
    durationHoursMinutesShort: '{n} 小时 {m} 分',
    // The manual cancel of the capsule: the panel, the confirmation and the
    // readable reasons. The capsule's own text stays free of hints — the panel
    // is the discoverability.
    cancelPanelTasks: '还在等 {n} 个会话',
    cancelPanelOthers: '还有 {n} 个会话也在等这次重启',
    cancelPanelOthersAfter: '还剩 {n} 个会话在等',
    cancelPanelAria: '待重启详情',
    cancelButton: '取消我的这次重启',
    cancelButtonAria: '取消我的这次重启',
    cancelLocked: '正在重启，已经不能取消了',
    cancelConfirmTitle: '取消你的这次重启？',
    cancelConfirmOnlyMe: '取消后这次重启就不会发生了。',
    cancelConfirmOthers: '还有 {n} 个会话也在等这次重启——取消只影响你自己，他们仍会重启。',
    cancelConfirmUnknown: '当前会话未知，无法只撤自己。',
    cancelConfirmButton: '确认取消',
    cancelConfirmButtonAria: '确认取消这次重启',
    cancelDismissButton: '再想想',
    cancelDismissButtonAria: '算了，不取消',
    cancelFailed: '没能取消这次重启。',
    cancelFailedWith: '没能取消这次重启：{message}',
    cancelNotRequester: '这个会话没有请求这次重启，所以什么都没取消。',
    cancelNothingPending: '现在没有待重启的请求。',
    cancelUnknownSession: '当前会话未知，无法只撤自己。',
    cancelNoRoute: '找不到取消接口（宿主版本太旧）。',
    // The one-time install prompt (the choice is asked exactly once).
    // "Backup" is the verb and BOTH options share the "configuration" base:
    // the plugins are an ADDITION to the configuration, never a rival of it.
    backupChoiceTitle: '重启前自动备份：要不要把已安装的插件也一起备份？',
    backupChoiceBody: '每次重启前会快照当前配置，留一份可以手工翻回去的存档——插件不会自动使用它。',
    backupChoiceWithPlugins: '配置 + 已安装插件',
    backupChoiceWithPluginsHint: '多约 3 秒、约 117 MB；插件把启动搞坏时，可以拿这份存档手工回退。',
    backupChoiceConfigOnly: '只备份配置',
    backupChoiceConfigOnlyHint: '瞬间完成、约 66 KB；插件问题无法回退，需要手动重装。',
    backupChoiceFootnote: '以后可在 设置 → 自动重启与关机 修改',
    backupChoicePickPrimary: '用这个',
    backupChoicePickSecondary: '只备份配置',
    backupChoiceRecommended: '推荐',
    backupChoiceDismissAria: '关闭这个一次性提示',
    backupChoiceError: '保存失败：{message}',
    'supervisor.title': '让 DSH 自己把自己拉起来？',
    'supervisor.body': '现在这个 DSH 托管实例是手动/外部启动的——它挂了不会自己回来。我可以给你装一个自带的守护：登录时自动启动，进程掉了自动拉起，启动失败自动回滚上次快照。守护不会碰你的会话数据，只做「拉起 + 看住 + 回滚」三件事。',
    'supervisor.changes': '会改什么：新增 <stateDir>/supervisor/（守护脚本 + 配置 + 日志 + 锁）；Windows 注册一条登录自启记录（计划任务 dsh-autorestart-web），Linux 注册一个 systemd 用户服务。不改：会话数据、模型配置、已装插件。',
    'supervisor.rights': '需要什么权限：Windows 不需要管理员（用「登录时运行」；若该机策略禁止普通用户建计划任务，会自动降级到「启动文件夹」，同样不需要）；Linux 需要能写自己的家目录（systemctl --user，普通用户即可）。',
    'supervisor.uninstall': '怎么卸：设置页「开机自启 → 卸载」一键；或手动 schtasks /Delete /TN "dsh-autorestart-web" /F（Linux：systemctl --user disable --now dsh-autorestart-web.service && rm ~/.config/systemd/user/dsh-autorestart-web.service），两者都要再删掉 <stateDir>/supervisor/ 目录。',
    'supervisor.install': '帮我装（推荐）',
    'supervisor.installHint': '会写一个守护脚本到 <stateDir>/supervisor/，并在 Windows 注册一条登录自启记录 / Linux 注册一个 systemd 用户服务。不需要管理员。之后宿主进程退出，守护会在几秒内拉起它；起不来会自动回滚到重启前的快照。随时可以在设置里一键卸载。',
    'supervisor.keep': '保持我现在的启动方式',
    'supervisor.keepHint': '什么都不改。你现在用什么启动就继续用什么。代价：宿主进程退出后不会自动回来——重启功能会退化成「只能在有外部守护时生效」。',
    'supervisor.later': '以后再说',
    'supervisor.laterHint': '这张卡片不再出现。你可以随时在「设置 → 自动重启与关机 → 开机自启」里手动装。',
    'supervisor.error': '操作失败：{message}',
    'supervisor.busy': '正在处理…',
    // The graceful-shutdown (sleep) surfaces: the button at the foot of the
    // left sidebar, the floating countdown card, the waiting card and the
    // second install question.
    'sleep.button.label': '收工关机',
    'sleep.button.cancel': '取消关机',
    'sleep.button.aria': '收工关机：等所有会话收工后关机',
    'sleep.button.title': '等所有会话收工，再倒数 {n} 秒关机',
    'sleep.button.titleImmediate': '等所有会话收工后立即关机（不倒数）',
    'sleep.button.busy': '准备中…',
    'sleep.error': '没能联系上关机服务：{message}',
    // The settings section: the entry in the settings sidebar.
    'nav': '自动重启与关机',
    'settings.groups.restart': '重启相关设置',
    'settings.groups.shutdown': '关机相关设置',
    'settings.seconds.label': '关机倒数秒数',
    'settings.seconds.immediate': '不倒数（立即关机）',
    'settings.seconds.value': '{n} 秒',
    'settings.seconds.hint': '所有会话收工后，屏幕上会显示这段倒数（可点「不关了」取消），数完才关机；想要更多落盘时间就把倒数调大。',
    'settings.restartGrace.label': '重启前等待',
    'settings.restartGrace.hint': '重启没有倒数环节，会话一收工就会立刻重启；如果你装了“会话结束后才写”的记忆/总结类插件，把这里调大（默认 0 秒）。',
    'settings.restartGrace.value': '{n} 秒',
    'settings.restartGrace.immediate': '不等（立即重启）',
    'settings.backup.label': '重启前备份',
    'settings.backup.details': '详情',
    'settings.backup.section': '备份说明及手动备份操作',
    'settings.backup.hint': '重启前自动存一份存档；插件不会自动还原，要回退得在下面自己点。存的是：你的设置（一定）；你自己写的、直接链接到源码目录的插件（连文件一起拷）；从网上下载装的插件（只记下装过哪些、什么版本，不拷文件，真出事时按清单重装）。',
    'settings.backupPlugins.label': '备份包含已安装插件',
    'settings.backupPlugins.hint': '关闭后只备份 DSH 自身状态，不含 profile 里的插件目录。',
    'settings.restartBanner.title': '这台机器现在还没有重启能力：本插件不会重启，也不会在重启前备份。点一下「帮我配好」，我自动推导并写入；配错了可以撤销。',
    'settings.restartBanner.fix': '帮我配好',
    'settings.groups.supervisor': '开机自启',
    'settings.supervisor.status': '当前由',
    'settings.supervisor.installed': '插件守护',
    'settings.supervisor.external': '你自己的方式',
    'settings.supervisor.unknown': '未知',
    'settings.supervisor.off': '关闭',
    'settings.supervisor.capable': '重启能力',
    'settings.supervisor.capableYes': '可用：宿主退出后会自动回来',
    'settings.supervisor.capableNo': '不可用：宿主退出后不会自动回来',
    'settings.supervisor.install': '装上守护',
    'settings.supervisor.uninstall': '卸载守护',
    'settings.supervisor.hint': '守护是一个独立进程：登录时自动启动，宿主进程掉了自动拉起，启动失败自动回滚上次快照。不需要管理员。',
    'settings.supervisor.noInstallDesktop': '桌面版自带重启，这里不用装守护。',
    'settings.supervisor.noInstallExternal': '已经有别的守护在管这个宿主：再装一个会两个一起拉起、抢同一个端口，所以这里不提供安装。',
    'settings.supervisor.noInstallUnknown': '宿主没说清是谁在拉起它，所以这里不提供安装。',
    'settings.supervisor.access': '当前访问链接',
    'settings.supervisor.accessHint': '重启后 token 会变，链接也会变。这个链接一直是最新的。',
    'settings.supervisor.pending': '卸载没有完成，请手动执行：{commands}',
    'settings.supervisor.reason': '说明',
    'settings.supervisor.command': '重启命令',
    'settings.supervisor.derive': '推导重启命令',
    'settings.supervisor.apply': '就用这条命令',
    'settings.supervisor.revert': '撤销',
    'settings.supervisor.noCommand': '推不出可重放的重启命令',
    'settings.supervisor.plan': '干跑预览',
    'settings.supervisor.reason.ok': '可以用这条命令重新拉起这个 DSH。',
    'settings.supervisor.reason.desktop-app': '桌面版自带重启，不用管这条命令。',
    'settings.supervisor.reason.not-a-web-host': '这个 DSH 不是网页型宿主，没有端口也没有监听器。',
    'settings.supervisor.reason.argv-unavailable': '读不回启动命令行（它是被一个特殊方式拉起来的），所以不猜。',
    'settings.supervisor.reason.external-supervisor': '已经有别的守护在管这个进程：装第二个会抢端口。改为「优雅退出，让它拉起我」。',
    'settings.supervisor.reason.container-no-init': '这台机器没有开机自启机制（容器），所以不承诺自动拉起。',
    'settings.supervisor.reason.port-not-fixable': '端口每次都变，浏览器会被踢出去；得先把端口固定下来。',
    'settings.supervisor.reason.supervised': '插件自己的守护在管这个进程，重启直接交给它。',
    'settings.supervisor.status.external': '我记下的启动方式：由你的脚本拉起（重启交给它，我不插手）',
    'settings.supervisor.status.bareWritten': '我记下的启动方式：按你确认过的那条命令重启',
    'settings.supervisor.status.bareUnknown': '我还不知道怎么把你拉起来',
    'settings.supervisor.status.unknown': '我看不出你是怎么启动的（我不猜，也不会自己乱拉）',
    'settings.supervisor.status.selfSupervised': '我记下的启动方式：插件自己的守护在管（重启交给它）',
    'settings.supervisor.status.container': '这里没有"登录时自启"这回事：由编排器负责',
    'settings.supervisor.redetect': '重新检测',
    'settings.supervisor.deriveHelp': '帮我看看怎么重启',
    'settings.supervisor.technical': '技术细节',
    'settings.supervisor.technicalHint': '以下是插件实际会执行的命令',
    'settings.supervisor.previous': '撤销后会还原成',
    'settings.supervisor.app': '桌面版自带重启',
    'settings.supervisor.startup': '启动方式',
    'settings.supervisor.startup.bare': '手动启动（没人管它）',
    'settings.supervisor.startup.external': '由别的守护在管',
    'settings.supervisor.startup.container': '容器里（由编排器管）',
    'settings.supervisor.startup.desktop': '桌面版自带重启',
    'settings.supervisor.startup.selfSupervised': '插件自己的守护在管',
    'settings.supervisor.startup.unknown': '认不出是谁拉起它的',
  'settings.autostartKind.other': '其他方式',
  'settings.autostartKind.windows-task': 'Windows 计划任务',
  'settings.autostartKind.windows-startup': 'Windows 启动文件夹',
  'settings.autostartKind.systemd-user': 'systemd 用户服务',
  'settings.autostartKind.systemd-system': 'systemd 系统服务',
  'settings.autostartKind.wsl-systemd': 'WSL 里的 systemd',
  'settings.autostartKind.wsl-no-systemd': 'WSL（没有 systemd）',
  'settings.autostartKind.linux-no-systemd': 'Linux（没有 systemd）',
  'settings.autostartKind.container': '容器',
  'settings.autostartKind.desktop': '桌面版自带重启',
  'settings.autostartKind.unknown': '认不出',
  'settings.autostartKind.pm2': 'pm2（进程守护工具）',
  'settings.startupWhy.desktop': '这个进程就是桌面客户端本体，它自己会重启自己',
  'settings.startupWhy.bare': '它是被人在终端里手动起的，没人管它',
  'settings.startupWhy.external': '它是由另一个守护进程拉起来的',
  'settings.startupWhy.container': '它跑在容器里，由编排器负责',
  'settings.startupWhy.unknown': '看不出它是怎么被拉起来的',
  'settings.startupWhy.self-supervised': '它由本插件自己的守护在管',
    'settings.supervisor.autostart': '开机自启怎么做',
    'meta.title': 'dsh-autorestart — 重启不断线',
    'meta.description': '让 DeepSeek Harness 重启后接着干活：落盘的检查点、启动时重新武装 goal 或给一条续接提示，以及一次等人闲下来的优雅重启。',
    'text.missing': '（这条文案还没写）',
    'settings.backup.list': '现在备份了什么',
    // TWO LINES, NOT FIVE (user report, 2026-11-02). One line says how many
    // copies there are and how much disk they take together; the next one says
    // the rule that keeps their number bounded. Everything else about the folder
    // was a restatement of one of those two — or a number written into a
    // sentence, where it went stale the moment the dropdown changed it.
    'settings.backup.count': '当前 {n} 份，实际占用 {size}。',
    // NO "内含：…" LINE (user decision, 2026-11-02): its only job was to point at
    // the per-plugin recovery while the fold was closed, and that entry is gone —
    // a note advertising a deleted feature is worse than no note.
    // MORE THAN ONE PROFILE (2026-11-02): the host cannot tell which profile to
    // back up, so backups and rollbacks stop. Saying nothing would look like
    // "everything is fine".
    'settings.backup.multiProfile': '检测到多个 profile，备份和回滚已暂停：它不知道该备份哪一个。解决办法：启动时指定 DSH_PROFILE，或者只保留一个 profile。',
    'settings.backup.keep': '最多保留 {n} 份，超出自动删最旧的那份。',
    // THE SECOND SENTENCE THE USER SAW TWICE IS GONE (user report, 2026-11-02):
    // "最多保留 2 份" said the same thing as the line above, and the long
    // paragraph about what the folder is for repeated the number a third time.
    // Two lines say everything the page can promise; the dropdown below changes
    // the number, so no sentence carries a frozen copy of it.
    'settings.backup.kindsLocal': '链接安装（自己写的）和本地化过的插件（目录里有 .git）都已完整备份，可以回档。',
    'settings.backup.kindsThirdParty': '第三方插件由插件作者维护，有异常建议重装',
    'settings.backup.limitLabel': '保留份数',
    // THE DISK WARNING SITS NEXT TO THE DROPDOWN (user report, 2026-11-02): it
    // used to be a line BELOW the control, so the warning arrived after the
    // choice was made. Same place in the tree, right of the select.
    'settings.backup.limitHint': '备份会占用磁盘空间，建议尽量选更少的备份数。',
    'settings.backup.limitAsk': '将删除 {remove} 份最旧的备份，删除后无法恢复。当前 {from} 份 → 保留 {to} 份。',
    'settings.backup.limitConfirm': '确认删除并改为保留 {to} 份',
    'settings.backup.limitCancel': '取消',
    'settings.backup.limitDeleted': '已删除 {removed} 份，现在保留 {kept} 份。',
    'settings.backup.limitMore': '已选 {requested} 份，实际保留 {kept} 份。',
    'settings.backup.limitFailed': '没能改成功，份数保持原样。',
    'settings.backup.empty': '还没有备份；每次重启前会自动生成一份。',
    // THE SKIPPED BACKUP MUST BE VISIBLE (2026-11-07): a backup that was not
    // taken, announced only in the log, is a backup the user believes exists.
    'settings.backup.profileUnknown': '这次没有备份：没找到你的配置目录（发现 {n} 个候选）。',
    'settings.backup.path': '存放路径',
    'settings.backup.copyPath': '复制路径',
    'settings.backup.copied': '路径已复制',
    'settings.backup.copyFailed': '复制失败，请手动选中上面的路径',
    'settings.backup.time': '备份时间',
    // THE SIZE OF ONE COPY IS NOT SHOWN, so its label is gone as well (user
    // decision, 2026-11-02): a row is a time and a button, and the disk a copy
    // needs is only stated once for the whole folder (`settings.backup.count`).
    // A key nothing renders is a promise the page does not keep — the same reason
    // the identity keys went.
    'settings.backup.withPlugins': '（含已装插件）',
    'settings.backup.withoutPlugins': '（不含已装插件）',
    // THE ONE LINE A COPY GETS WHEN IT IS NOT THE ONE (user decision,
    // 2026-11-02): a copy automatic recovery would never use is still listed,
    // but as a sentence with its time and its size — never as a card with a
    // button next to it. Two wordings, because a seed and a restart snapshot are
    // two different things to promise about.
    'settings.backup.fallback.seed': '另有一份首装备份（只含设置、未验证，仅在前一份不可用时才用），{time}，{size}',
    'settings.backup.fallback.other': '另有一份未验证的备份（不会被自动还原，仅在前一份不可用时才用），{time}，{size}',
    // THE FOLD (user report, 2026-11-02): fifteen copies used to be fifteen
    // sentences. The first two stay; the rest are behind this one line, and the
    // line says how many and what they are worth.
    'settings.backup.othersSummary': '另有 {n} 份重启前自动拍的备份（未验证，不会自动还原）',
    // THE CERTIFICATE VOCABULARY IS GONE (user decision, 2026-11-02). Two rounds
    // of deletion ended here: first the rendering stopped grading copies, then the
    // labels and now the evidence sentences themselves. Nothing draws them any
    // more — a copy is a time and a button — and a dictionary that still carried
    // them could be picked up again by a later change without anyone noticing that
    // it re-introduces a verdict the plugin cannot support.
    'settings.backup.scopeLabel': '内容范围',
    'settings.backup.scope.config-only': '只含配置',
    'settings.backup.scope.config+plugins': '配置 + 已装插件',
    'settings.backup.scope.config+links': '配置 + 链接插件',
    'settings.backup.scope.slim': '精简份（配置 + 手装插件）',
    'settings.backup.scopeMissing': '（没有记录）',
    'settings.backup.interventionLabel': '这次启动有没有被系统介入',
    'settings.backup.intervention.true': '有（系统还原过一份）',
    'settings.backup.intervention.false': '没有',
    'settings.backup.intervention.unknown': '没有记录',
    // THE MANUAL ROLLBACK (user decision, 2026-10-30): the user may know better
    // than "the newest proven copy", so ANY copy can be restored — but only
    // after a card that says which one, what it replaces, and that a restart
    // follows.
    'settings.backup.rollback': '回退到这一份',
    // THE ONE SENTENCE THE PAGE MAY SAY ABOUT A COPY (user decision, 2026-11-02).
    //
    // It hangs on exactly one copy — the one taken at the most recent startup —
    // and it says only WHAT THAT COPY IS: the state the host last started from.
    // It does not say the copy is good, because the plugin cannot know that: a
    // plugin that fails to load is dropped and the host comes up anyway. Which
    // copy to roll back to is the reader's call, and the sentence ends by saying
    // so. Verbatim — do not reword.
    'settings.backup.startupHint': '这是最近一次启动时的状态。DSH 能启动不代表插件都正常——坏掉的插件会被排除，主机照样起来。要回退到哪一份，请自己判断。',
    'settings.backup.rollbackConfirmTitle': '确定回退到这一份？',
    'settings.backup.rollbackConfirmBody': '会把 {time} 的那份备份还原到现在——**当前状态会被它覆盖**（覆盖前会先自动存一份当前快照，所以这次回退还能再退回来）。',
    'settings.backup.rollbackConfirmRestart': '还原完成后会自动重启一次：回退前已自动存了一份可撤回的现场；回退后的这次重启不会再额外备份。重启期间这个页面会断开，回来后接着用。',
    'settings.backup.rollbackConfirmYes': '确认回退',
    'settings.backup.rollbackConfirmNo': '取消',
    'settings.backup.rollbackBusy': '正在回退…',
    'settings.backup.rollbackDone': '已回退，正在重启…',
    'settings.backup.rollbackFailed': '回退没成功：{message}',
    'settings.groups.report': '遇到问题',
    'settings.report.label': '遇到问题了？',
    'settings.report.github': '复制诊断信息并去 GitHub 提问题',
    'settings.report.hint': '诊断信息里没有你的访问令牌，也没有任何密钥；把它贴进 issue，我们就能看出问题出在哪。',
    'settings.report.email': '没有 GitHub 账号？发邮件到 {email}',
    'settings.report.copy': '复制诊断信息',
    'settings.report.copyFailed': '复制失败，请手动复制这段',
    'settings.report.issueTitle': '重启 / 开机自启相关的问题',
    'settings.report.issueBody': '请把刚才复制的诊断信息粘贴到下面。\n\n## 发生了什么\n\n\n## 期望什么\n\n\n## 怎么复现\n',
    'settings.error': '没能保存设置：{message}',
    'settings.saveNotice.saved': '已生效',
    'settings.saveNotice.failed': '没保存成功',
    'settings.saveNotice.dismiss': '关闭',
    'sleep.dryRun.title': '试运行：不会真的关机',
    'sleep.dryRun.body': '彩排结束，本来会执行这条命令（真的什么都没执行）：',
    'sleep.dryRun.close': '知道了',
    'sleep.countdown.caption.20': '鲸鱼娘开始收网了',
    'sleep.countdown.caption.19': '备份已经替你打包好',
    'sleep.countdown.caption.18': '没说完的话，再讲一句',
    'sleep.countdown.caption.17': '大家都在慢慢安静下来',
    'sleep.countdown.caption.16': '最后再巡一圈房间',
    'sleep.countdown.caption.15': '海面开始变暗了',
    'sleep.countdown.caption.14': '灯一盏一盏熄了',
    'sleep.countdown.caption.13': '房间已经安静下来',
    'sleep.countdown.caption.12': '还有一小会儿',
    'sleep.countdown.caption.11': '再看一眼屏幕吧',
    'sleep.countdown.caption.10': '鲸鱼娘在数最后几秒',
    'sleep.countdown.caption.9': '灯已经关了一半',
    'sleep.countdown.caption.8': '声音越来越小',
    'sleep.countdown.caption.7': '马上就到道别的时候了',
    'sleep.countdown.caption.6': '最后一口海水',
    'sleep.countdown.caption.5': '晚风越来越轻',
    'sleep.countdown.caption.4': '说声晚安吧',
    'sleep.countdown.caption.3': '真的只剩三秒啦',
    'sleep.countdown.caption.2': '还来得及说声再见',
    'sleep.countdown.caption.1': '晚安 🌙',
    'sleep.countdown.caption.default': '晚安 🌙',
    'sleep.countdown.remaining': '还剩 {n} 秒',
    'sleep.countdown.cancel': '算了，别关',
    'sleep.countdown.goodNight': '晚安 🌙',
    'sleep.countdown.hint': '再过 {n} 秒就关机，点「算了，别关」可以留下。',
    'sleep.waiting.title': '还在等大家收工',
    'sleep.waiting.body': '等这些会话忙完，就轮到关机啦：',
    'sleep.waiting.count': '还有 {n} 个任务在干活',
    'sleep.waiting.subagents': '其中 {k} 个是子智能体',
    'sleep.waiting.blocker': '· {title}',
    'sleep.waiting.none': '（正在确认还有谁在忙）',
    'sleep.waiting.cancel': '不关了',
    'sleep.shuttingDown.title': '晚安 🌙',
    'sleep.shuttingDown.body': '正在关机，鲸鱼娘把灯关好了。',
    'sleep.shuttingDown.dryRun': '试运行：不会真的关机（本来会执行 {command}）',
    'sleep.shuttingDown.dismiss': '关掉这个提示',
    'sleep.choice.title': '收工关机按钮要不要留着？',
    'sleep.choice.body': '它待在左侧栏最底部、设置按钮旁边：点一下就等所有会话收工，倒数几秒后关机。',
    'sleep.choice.keep': '留着（推荐）',
    'sleep.choice.keepCta': '留着',
    'sleep.choice.keepHint': '左侧栏底部多一个月亮按钮，一键收工关机。',
    'sleep.choice.hide': '不要这个按钮',
    'sleep.choice.hideCta': '不要',
    'sleep.choice.hideHint': '界面保持原样；以后想用，再从设置里打开。',
    'sleep.choice.footnote': '以后可在 设置 → 自动重启与关机 修改',
    'sleep.choice.diagramLabel': '按钮出现在左侧栏最底部、设置按钮旁边',
    'sleep.choice.error': '保存失败：{message}',
    // The one-time announcement of a new feature. An installation that already
    // existed never sees the install prompt again, so this card is the only way
    // a new feature reaches it.
    'announcement.title': '新功能：收工关机',
    'announcement.line1': '左侧栏最底部多了一个 🌙「收工关机」按钮。',
    'announcement.line2': '点一下 → 所有会话收工后倒数 {n} 秒关机。',
    'announcement.line2.generic': '点一下 → 所有会话收工后倒数几秒关机。',
    'announcement.line3': '想改行为，去「设置 → 自动重启与关机」。',
    'announcement.disabled': '按钮目前关闭，可在设置里打开。',
    'announcement.button': '知道了',
    'announcement.error': '没能记下来：{message}',
    // THE LEFTOVERS OF AN OLDER BUILD (2026-11-06): asked ONCE, and gone for
    // good after the answer. There is deliberately no settings entry and no
    // permanent banner for this — the problem must disappear with the answer.
    'shellBackups.title': '旧版本留下的备份残留',
    'shellBackups.line1': '残留 {count} 个目录，共 {size}。',
    'shellBackups.line2': '它们是没有 manifest 的半成品备份：恢复不了，也不会再被用到。',
    'shellBackups.clean': '清理掉',
    'shellBackups.self': '我自己处理',
    'shellBackups.cleaned': '已清理 {count} 个目录，释放 {size}。',
    'shellBackups.cleanedNothing': '没有需要清理的残留。',
    'shellBackups.failed': '有 {count} 个目录删不掉：{reason}',
    'shellBackups.selfDone': '好，之后不再提醒。',
    'shellBackups.error': '没能记下来：{message}',
    'shellBackups.line1.noSize': '残留 {count} 个目录（占用未统计）。',
    'shellBackups.working': '正在清理，请稍候',
    'shellBackups.refused': '宿主没有接受这个操作。',
    'shellBackups.maybeLater': '清理可能还在进行，刷新一下页面就能看到结果。',
    // THE CLICK MUST BE SEEN (2026-11-07): a click that fails is a SENTENCE,
    // and the sentence is in the language of the user — never a silence and
    // never an English sentence from the browser.
    'shellBackups.error.cleanup': '没能完成清理：{message}',
    'shellBackups.error.failed': '请再试一次。',
    'shellBackups.error.broken': '页面出了点问题，请刷新一下再试。',
    'shellBackups.workingSelf': '正在记下来，请稍候',
    // THE PLUGIN THAT DID NOT LOAD (用户拍板 2026-11-01)：宿主照常起来，只是某个
    // 插件这次没激活 —— 把这件事搬到前台，并且只给一个动作：只恢复这一个。
    'pluginFailure.title': "启动后有东西没起来",
        'pluginFailure.hint': "这些功能已经记下来了，之后可以在「插件」页里再恢复。",
        'settings.description': "自动重启 DSH、重启前备份；出问题有存档可查，不会自动还原。",
        'settings.restore': "恢复",
        // THE TWO SENTENCES THAT REPLACED THE PER-PLUGIN THIRD-PARTY LINE (user
    // correction, 2026-11-02). The old copy said "the backup holds only its name
    // and version", which reads as "there is something in there" — and there is
    // nothing: third-party plugins are NOT backed up. Built-in ones are shipped
    // with DSH, so they need no backup and must not be reinstalled.
    'settings.thirdParty': "这个插件不是你自己开发的，没法从备份恢复，需要重新安装。",
        'settings.version': "版本 {version}",
    'pluginFailure.dismiss': "知道了",
    'pluginFailure.dismissLabel': "关掉这个提示（这次启动不再显示，下次启动会重新出现）",
    'pluginFailure.certainTitle': "这些功能这次没起来",
    'pluginFailure.certainIntro': "上次启动时这些功能还在，这次没有。这是已经发生的事，不是猜测。",
    'pluginFailure.clueTitle': "这些插件跟备份不一样",
    'pluginFailure.clueIntro': "这些插件的文件和最近一次备份不同。可能只是升级过，也可能有别的原因，所以这里只列出差异，不下结论。",
    'pluginFailure.uiBlindSpot': "另外有 {count} 个界面模块这次没出现（它们没有对应到你安装的插件，所以不在这里列出）。",
    'pluginFailure.restoreAll': "全部恢复（{count} 个）",
    'pluginFailure.restoreAllDone': "恢复完成：{done} 个成功，{failed} 个没成功。",
    'pluginFailure.close': "关掉这个提示",
    'pluginFailure.linkedHint': "这个插件是你自己写在本地、以链接方式安装的，可以直接恢复到备份里的版本。",
    'pluginFailure.thirdPartyHint': "这个插件是第三方安装的，备份里没有它的文件。要还原就用下面这条命令，它会装回原来的那个版本（不是最新版）：",
    'pluginFailure.commandLabel': "复制这条命令",
    // THE WAY OUT FOR THE PEOPLE WHO DO NOT LIKE COMMANDS (user report,
    // 2026-11-05). It says WHAT the reinstall gives: the LATEST version, not
    // the one in the backup — the command above installs the backup version,
    // reinstalling from the interface does not.
    'pluginFailure.reinstallHint': "不习惯用命令的话，可以回「插件」页重新安装它——但从界面重装拿到的是最新版，不是备份里这个版本。",
    'pluginFailure.noCommandHint': "这个插件是第三方安装的，备份里没有它的文件，也没有记下它的精确版本，所以这次给不出可以直接执行的还原命令。",
    'pluginFailure.restore': "只恢复 {plugin}",
    'pluginFailure.restoring': "正在恢复 {plugin}…",
    'pluginFailure.restored': "已经把 {plugin} 恢复到备份版本（备份时间 {at}）。",
    'pluginFailure.failed': "{plugin} 恢复没有完成：{reason}",
    'pluginFailure.noBackup': "这台机器没有可用备份，只能手动处理。",
    // THE COPY OF THE COMPOSER ROW. It is one SHORT line and never a sentence:
    // the long stage sentence was clipped away there (user report,
    // 2026-10-29). While the gate waits the pill keeps its own composed line
    // ("待重启 · 空闲后自动重启" / "待重启 · 等待 N 个会话"); the three
    // other stages REPLACE that line with one of these.
    'restart.stage.snapshotting': '重启前备份中',
    'restart.stage.restarting': '正在重启…',
    'restart.stage.back': '已回来',
    // The centred overlay of a restart that is REALLY RUNNING (the backup, the
    // shutdown, the return): one short line per stage, never wrapped, never cut
    // with an ellipsis (the card shrinks its font instead). The numbers come
    // from the Host's real measurements. There is no copy for `waiting`: no
    // card is drawn while the gate merely waits.
    'restart.overlay.snapshotting': 'DSH 重启前备份中',
    // The unit travels WITH the number (KB or MB, chosen by the size): a 92 KB
    // profile must never be rounded down to "0 MB".
    'restart.overlay.size': '{done} / {total}',
    'restart.overlay.sizeDone': '{done}',
    'restart.overlay.restarting': '正在重启…',
    // THE HONEST CARD (user report, 2026-10-30): a restart that was interrupted
    // by a new conversation said "正在重启…" for 25 s, which was not true. It now
    // says what actually happened — and it may stay, because it IS the truth.
    'restart.overlay.deferred': '有新会话在跑，重启已暂缓',
    'restart.overlay.deferredNote': '等它结束会自动继续 · 已等 {count} 个会话',
    'restart.overlay.deferredNoteZero': '等它结束会自动继续',
    'restart.overlay.back': '已回来',
  }

  const EN = {
    label: 'Pending restart',
    busyPrefix: ' · waiting for ',
    busySuffix: ' session(s)',
    idle: ' · restarts once idle',
    goalActive: ' · held by a self-continuing goal',
    goalExhausted: ' · a goal ran out of rounds',
    settling: ' · still waiting for the quiet window',
    parkedGoals: ' · {n} goal(s) parked, they continue after the restart',
    parkButton: 'Park & restart',
    parkButtonAria: 'Park that session goal and request the restart now',
    parkBusy: 'Parking…',
    parkError: 'Park failed: {message}',
    tooltip:
      'Waits for the other sessions to become idle, then restarts automatically; this session resumes its progress after the restart.',
    tooltipBusy:
      'Waits for the other sessions to finish (the count includes work that is queued but not started yet), then restarts automatically; this session resumes its progress after the restart.',
    tooltipWithError:
      'Waits for the other sessions to become idle, then restarts automatically; this session resumes its progress after the restart. {message}',
    dotAria: 'Pending restart',
    panelHeading: 'Pending restart',
    panelStateBusy: 'Waiting for the other sessions to become idle',
    panelStateIdle: 'Waiting for the idle window',
    panelStateGoalActive: 'Waiting for the other sessions to park their self-continuing goal',
    panelStateGoalExhausted: 'Waiting for the other sessions\' goal (its round budget is used up)',
    panelBlockedTitle: 'Blocking session: {title}',
    panelBlockedGeneric: 'One task is running',
    // One line per blocker: a session and a subagent are told apart, and
    // neither of them is ever shown as a raw session id.
    panelBlockedSession: 'Session "{label}" is running',
    panelBlockedSubagent: '{name} is running',
    panelBlockedSubagentGeneric: 'One subagent is running',
    // The N subagents of ONE session are one line.
    panelBlockedSubagentGroup: 'The {n} subagents of session "{label}" are running',
    panelBlockedSubagentGroupGeneric: '{n} subagents are running',
    panelBlockedRestartPending: 'Waiting for the pending restart to finish before shutting down',
    panelGoalActiveLine: 'Blocking session "{title}": the goal keeps driving rounds by itself (goal-active)',
    panelGoalExhaustedLine: 'Blocking session "{title}": the goal ran out of rounds and cannot continue (goal-exhausted)',
    panelParkedTitle: 'Parked goals (they continue after the restart):',
    panelParkedGoal: 'session {session} · {goal}',
    panelWaiting: 'Waiting for {duration}',
    panelResume: 'This session resumes its progress automatically after the restart.',
    // The long wait: the restart is still waiting while a conversation runs on.
    // There is no deadline and nothing expires. The capsule is ONE clipped line: it holds a
    // number and a duration, NEVER a name. Every name goes into the tooltip,
    // where there is room for all of them.
    longWaitPill: ' · waiting for {duration} · {n} task(s) running',
    longWaitTooltip: 'Waiting for {duration}. Running: {blockers}',
    // The blockers of one list: they are grouped by the session that created
    // them (N subagents of one session are ONE item), the tooltip names them
    // ALL and the shutdown card lists them. One rule, two surfaces.
    blockerGeneric: 'another session',
    blockerJoin: ', ',
    blockerGroupSubagents: '{label} ({n} subagents)',
    blockerGroupSubagentsGeneric: '{n} subagents',
    blockerMore: '… and {n} more',
    blockersTitleLine: 'Blocking sessions: {blockers}',
    durationSeconds: '{n}s',
    'settings.restart.cancelledNote': 'The restart you asked for did not happen: you requested it at {at}, waited {waited}, and it was never carried out; after the host restarted, that request was cancelled. If you still want it, just ask once more.',
    'restart.waitedSeconds': 'a few seconds',
    'restart.waitedMinutes': 'about {n} min',
    'restart.waitedHours': 'about {n}h {m}m',
    'restart.waitedHoursExact': 'about {n}h',
    durationMinutes: '{n}m {m}s',
    durationHours: '{n}h {m}m',
    // The COMPACT duration of the capsule: it can afford "16 min", not
    // "16m 37s" — the capsule is one clipped line.
    durationMinutesShort: '{n} min',
    durationHoursShort: '{n}h',
    durationHoursMinutesShort: '{n}h {m}m',
    // The manual cancel of the capsule: the panel, the confirmation and the
    // readable reasons. The capsule's own text stays free of hints — the panel
    // is the discoverability.
    cancelPanelTasks: 'Still waiting for {n} session(s)',
    cancelPanelOthers: '{n} other session(s) are waiting for this restart too',
    cancelPanelOthersAfter: '{n} session(s) are still waiting',
    cancelPanelAria: 'Pending restart details',
    cancelButton: 'Cancel my restart',
    cancelButtonAria: 'Cancel my restart',
    cancelLocked: 'Restarting — this can no longer be cancelled',
    cancelConfirmTitle: 'Cancel your restart?',
    cancelConfirmOnlyMe: 'After this, the restart will not happen.',
    cancelConfirmOthers: '{n} other session(s) are waiting for this restart too — cancelling only affects you; they will still restart.',
    cancelConfirmUnknown: 'The current session is unknown, so its own request cannot be withdrawn.',
    cancelConfirmButton: 'Cancel it',
    cancelConfirmButtonAria: 'Confirm the cancellation',
    cancelDismissButton: 'Never mind',
    cancelDismissButtonAria: 'Keep the restart',
    cancelFailed: 'The restart could not be cancelled.',
    cancelFailedWith: 'The restart could not be cancelled: {message}',
    cancelNotRequester: 'This session did not request the pending restart, so nothing was cancelled.',
    cancelNothingPending: 'There is no pending restart to cancel.',
    cancelUnknownSession: 'The current session is unknown, so its own request cannot be withdrawn.',
    cancelNoRoute: 'The cancel route is not available (the Host is too old).',
    // The one-time install prompt (the choice is asked exactly once).
    // "Backup" is the verb and BOTH options share the "configuration" base:
    // the plugins are an ADDITION to the configuration, never a rival of it.
    backupChoiceTitle: 'Automatic pre-restart backup: include the installed plugins too?',
    backupChoiceBody: 'A snapshot of the current configuration is taken before every restart - an archive you can roll back by hand; the plugin never uses it on its own.',
    backupChoiceWithPlugins: 'Configuration + installed plugins',
    backupChoiceWithPluginsHint: 'About 3 seconds and 117 MB more; if a plugin breaks the boot, you can roll back to this snapshot by hand.',
    backupChoiceConfigOnly: 'Configuration only',
    backupChoiceConfigOnlyHint: 'Instant, about 66 KB; plugin problems cannot be rolled back and need a manual reinstall.',
    backupChoiceFootnote: 'You can change this later in Settings → Auto-restart & shut down',
    backupChoicePickPrimary: 'Use this',
    backupChoicePickSecondary: 'Configuration only',
    backupChoiceRecommended: 'Recommended',
    backupChoiceDismissAria: 'Close this one-time prompt',
    backupChoiceError: 'Could not save the choice: {message}',
    'supervisor.title': 'Let DSH bring itself back up?',
    'supervisor.body': 'This hosted DSH instance is started by hand (or by something else) — when it dies it does not come back. I can install a supervisor of my own: it starts at login, it starts the host again when the process is gone, and it restores the last snapshot when the host does not come up. The supervisor never touches your session data; it only starts, watches and rolls back.',
    'supervisor.changes': 'What it changes: a new <stateDir>/supervisor/ directory (the supervisor script, its configuration, its log and its lock); on Windows a login record (the scheduled task dsh-autorestart-web), on Linux a systemd user service. What it does NOT change: your session data, your model configuration, the installed plugins.',
    'supervisor.rights': 'Which rights it needs: on Windows NO administrator rights (it runs "at login"; if the machine forbids ordinary users from creating scheduled tasks, it falls back to the startup folder, which needs none either); on Linux it needs write access to your own home directory (systemctl --user — an ordinary user is enough).',
    'supervisor.uninstall': 'How to remove it: one click on "Start at login → Uninstall" in the settings; or by hand: schtasks /Delete /TN "dsh-autorestart-web" /F (on Linux: systemctl --user disable --now dsh-autorestart-web.service && rm ~/.config/systemd/user/dsh-autorestart-web.service). Both ways also delete the <stateDir>/supervisor/ directory.',
    'supervisor.install': 'Install it for me (recommended)',
    'supervisor.installHint': 'It writes a supervisor script into <stateDir>/supervisor/ and registers a login record on Windows / a systemd user service on Linux. No administrator rights needed. After that the host is started again within seconds when its process is gone; when it does not come up, the snapshot of the last restart is restored. You can uninstall it with one click at any time.',
    'supervisor.keep': 'Keep the way I start it',
    'supervisor.keepHint': 'Nothing is changed. Whatever starts the host today keeps starting it. The price: the host does not come back by itself when its process is gone — the restart only works while something else (a docker "restart: always", your own systemd unit) brings it back.',
    'supervisor.later': 'Later',
    'supervisor.laterHint': 'This card does not come back. You can install the supervisor by hand at any time in "Settings → Auto-restart & shut down → Start at login".',
    'supervisor.error': 'That did not work: {message}',
    'supervisor.busy': 'Working…',
    // The graceful-shutdown (sleep) surfaces: the button at the foot of the
    // left sidebar, the floating countdown card, the waiting card and the
    // second install question.
    'sleep.button.label': 'Shut down',
    'sleep.button.cancel': 'Cancel the shutdown',
    'sleep.button.aria': 'Graceful shutdown: wait for every session to finish, then power off',
    'sleep.button.title': 'Waits for every session to finish, counts down {n} seconds, then powers off',
    'sleep.button.titleImmediate': 'Waits for every session to finish, then powers off right away (no countdown)',
    'sleep.button.busy': 'Getting ready…',
    'sleep.error': 'Could not reach the sleep service: {message}',
    // The settings section: the entry in the settings sidebar.
    'nav': 'Auto-restart & shut down',
    'settings.groups.restart': 'Restart settings',
    'settings.groups.shutdown': 'Shutdown settings',
    'settings.seconds.label': 'Shutdown countdown seconds',
    'settings.seconds.immediate': 'No countdown (switch off right away)',
    'settings.seconds.value': '{n} seconds',
    'settings.seconds.hint': 'Once every conversation is done, this countdown is shown on screen (pick "Never mind, keep it on" to cancel); the machine goes off when it reaches zero. Raise it when you want more time to write.',
    'settings.restartGrace.label': 'Wait before the restart',
    'settings.restartGrace.hint': 'A restart has no countdown: the host restarts as soon as the conversations are done. Raise this if you rely on a memory or summary plugin that writes its notes after the conversation ended (default 0 seconds).',
    'settings.restartGrace.value': '{n} seconds',
    'settings.restartGrace.immediate': 'Do not wait (restart right away)',
    'settings.backup.label': 'Backup before a restart',
    'settings.backup.details': 'Details',
    'settings.backup.section': 'What is backed up, and the manual backup steps',
    'settings.backup.hint': 'A copy is taken before every restart - an archive, not an automatic rollback: nothing is put back unless you click it below. What it holds: your settings (always); plugins you wrote and linked from a source directory (copied file by file); plugins downloaded from the internet (only which ones and which version are recorded - never copied; they are reinstalled from that list).',
    'settings.backupPlugins.label': 'Include the installed plugins in the backup',
    'settings.backupPlugins.hint': 'Off: only the state of DSH itself is backed up — the plugin directory of the profile is left out.',
    'settings.restartBanner.title': 'This machine has no restart capability right now: this plugin will not restart, and will not take a backup before a restart. Press "Set it up for me" and I derive and write it — and that can be undone.',
    'settings.restartBanner.fix': 'Set it up for me',
    'settings.groups.supervisor': 'Start at login',    'settings.supervisor.status': 'Started by',
    'settings.supervisor.installed': 'the supervisor of this plugin',
    'settings.supervisor.external': 'your own way',
    'settings.supervisor.unknown': 'nobody knows',
    'settings.supervisor.off': 'switched off',
    'settings.supervisor.capable': 'Restart capability',
    'settings.supervisor.capableYes': 'available: the host comes back on its own',
    'settings.supervisor.capableNo': 'not available: the host does not come back on its own',
    'settings.supervisor.install': 'Install the supervisor',
    'settings.supervisor.uninstall': 'Uninstall the supervisor',
    'settings.supervisor.hint': 'The supervisor is a process of its own: it starts at login, it starts the host again when its process is gone, and it restores the last snapshot when the host does not come up. No administrator rights needed.',
    'settings.supervisor.noInstallDesktop': 'The desktop app restarts itself — there is no supervisor to install here.',
    'settings.supervisor.noInstallExternal': 'Another supervisor is already in charge of this host. A second one would start the host as well and both would fight over the port, so there is nothing to install here.',
    'settings.supervisor.noInstallUnknown': 'The host did not say who starts it, so there is nothing to install here.',
    'settings.supervisor.access': 'The current access link',
    'settings.supervisor.accessHint': 'The token changes with every restart, and so does the link. This one is always the current one.',
    'settings.supervisor.pending': 'The uninstall did not finish. Please run it by hand: {commands}',
    'settings.supervisor.reason': 'Why',
    'settings.supervisor.command': 'The restart command',
    'settings.supervisor.derive': 'Derive the restart command',
    'settings.supervisor.apply': 'Use this command',
    'settings.supervisor.revert': 'Undo',
    'settings.supervisor.noCommand': 'No replayable restart command could be derived',
    'settings.supervisor.plan': 'Dry run',
    'settings.supervisor.reason.ok': 'This command starts this DSH again.',
    'settings.supervisor.reason.desktop-app': 'The desktop app restarts itself; there is no command to write.',
    'settings.supervisor.reason.not-a-web-host': 'This DSH is not a web host: it has no port and no listener.',
    'settings.supervisor.reason.argv-unavailable': 'The command line cannot be read back (it was started in a special way), so nothing is guessed.',
    'settings.supervisor.reason.external-supervisor': 'Another supervisor is already in charge: a second one would fight over the port. The restart becomes "exit gracefully and let it start me again".',
    'settings.supervisor.reason.container-no-init': 'This machine has no "at login" (a container), so no automatic start is promised.',
    'settings.supervisor.reason.port-not-fixable': 'The port changes every time, so the browser would be logged out; the port has to be fixed first.',
    'settings.supervisor.reason.supervised': 'The supervisor of this plugin is in charge: the restart is handed to it.',
    'settings.supervisor.status.external': 'How I remember you were started: by your own script (the restart is its job — I stay out of it)',
    'settings.supervisor.status.bareWritten': 'How I remember you were started: restarted with the command you confirmed',
    'settings.supervisor.status.bareUnknown': "I don't know yet how to start you again",
    'settings.supervisor.status.unknown': "I cannot tell how you were started (I don't guess, and I won't start you on my own)",
    'settings.supervisor.status.selfSupervised': 'How I remember you were started: my own supervisor is in charge (the restart is its job)',
    'settings.supervisor.status.container': "There is no 'at login' here: the orchestrator is in charge",
    'settings.supervisor.redetect': 'Detect again',
    'settings.supervisor.deriveHelp': 'Help me find out how to restart',
    'settings.supervisor.technical': 'Technical details',
    'settings.supervisor.technicalHint': 'What the plugin would actually run',
    'settings.supervisor.previous': 'What the undo restores',
    'settings.supervisor.app': 'the desktop app itself',
    'settings.supervisor.startup': 'How it was started',
    'settings.supervisor.startup.bare': 'started by hand (nobody manages it)',
    'settings.supervisor.startup.external': 'another supervisor is in charge',
    'settings.supervisor.startup.container': 'in a container (the orchestrator is in charge)',
    'settings.supervisor.startup.desktop': 'the desktop app restarts itself',
    'settings.supervisor.startup.selfSupervised': 'the supervisor of this plugin is in charge',
    'settings.supervisor.startup.unknown': 'it could not be established who started it',
  'settings.autostartKind.other': 'something else',
  'settings.autostartKind.windows-task': 'Windows scheduled task',
  'settings.autostartKind.windows-startup': 'Windows startup folder',
  'settings.autostartKind.systemd-user': 'systemd user service',
  'settings.autostartKind.systemd-system': 'systemd system service',
  'settings.autostartKind.wsl-systemd': 'systemd inside WSL',
  'settings.autostartKind.wsl-no-systemd': 'WSL without systemd',
  'settings.autostartKind.linux-no-systemd': 'Linux without systemd',
  'settings.autostartKind.container': 'a container',
  'settings.autostartKind.desktop': 'the desktop app itself',
  'settings.autostartKind.unknown': 'cannot tell',
  'settings.autostartKind.pm2': 'pm2 (a process manager)',
  'settings.startupWhy.desktop': 'this process is the desktop client itself — it relaunches itself',
  'settings.startupWhy.bare': 'it was started by hand in a terminal; nobody manages it',
  'settings.startupWhy.external': 'another supervisor started it',
  'settings.startupWhy.container': 'it runs in a container; the orchestrator is in charge',
  'settings.startupWhy.unknown': 'it could not be established how it was started',
  'settings.startupWhy.self-supervised': 'the supervisor of this plugin started it',
    'settings.supervisor.autostart': 'How "start at login" works here',
    'meta.title': 'dsh-autorestart — restart continuation',
    'meta.description': 'Keeps agent work alive across a DeepSeek Harness restart: a durable checkpoint, goal re-arm or a continuation message on boot, and an idle-aware graceful restart the agent can request itself.',
    'text.missing': '(this text is missing yet)',
    'settings.backup.list': 'What is backed up right now',
    'settings.backup.count': '{n} copies right now, using {size}.',
    'settings.backup.multiProfile': 'More than one profile was found, so backups and rollbacks are paused: it cannot tell which one to back up. Fix it by starting with DSH_PROFILE set, or by keeping a single profile.',
    'settings.backup.keep': 'At most {n} copies are kept; the oldest one is deleted when there are more.',
    'settings.backup.kindsLocal': 'Both linked plugins (written by hand) and localized ones (their directory has a .git) are in the copy in full, so they can be rolled back.',
    'settings.backup.kindsThirdParty': 'Third-party plugins are maintained by their authors; if something is wrong, reinstall them.',
    'settings.backup.limitLabel': 'Copies kept',
    'settings.backup.limitHint': 'Backups take disk space, so it is best to keep as few copies as possible.',
    'settings.backup.limitAsk': 'This deletes the {remove} oldest copies and cannot be undone. {from} copies now → {to} kept.',
    'settings.backup.limitConfirm': 'Delete and keep {to}',
    'settings.backup.limitCancel': 'Cancel',
    'settings.backup.limitDeleted': 'Deleted {removed} copies; {kept} are kept now.',
    'settings.backup.limitMore': 'You picked {requested}; {kept} are kept.',
    'settings.backup.limitFailed': 'The change did not go through; the copy limit is unchanged.',
    'settings.backup.empty': 'No backup yet; one is written before every restart.',
    // THE SKIPPED BACKUP MUST BE VISIBLE (2026-11-07): a backup that was not
    // taken, announced only in the log, is a backup the user believes exists.
    'settings.backup.profileUnknown': 'No backup this time: your profile directory could not be found ({n} candidates).',
    'settings.backup.path': 'Where they live',
    'settings.backup.copyPath': 'Copy the path',
    'settings.backup.copied': 'The path is on the clipboard',
    'settings.backup.copyFailed': 'The copy failed — please select the path above by hand',
    'settings.backup.time': 'Backup time',
    // THE SIZE OF ONE COPY IS NOT SHOWN, so its label is gone as well (user
    // decision, 2026-11-02): a row is a time and a button, and the disk a copy
    // needs is only stated once for the whole folder (`settings.backup.count`).
    // A key nothing renders is a promise the page does not keep — the same reason
    // the identity keys went.
    'settings.backup.withPlugins': '(plugins included)',
    'settings.backup.withoutPlugins': '(plugins excluded)',
    // THE ONE LINE A COPY GETS WHEN IT IS NOT THE ONE (user decision,
    // 2026-11-02): listed, but as a sentence with its time and its size — never
    // as a card with a button next to it.
    'settings.backup.fallback.seed': 'There is also a first-install seed copy (settings only, not verified, used only when the copy above is unavailable), {time}, {size}',
    'settings.backup.fallback.other': 'There is also an unverified copy (never restored automatically, used only when the copy above is unavailable), {time}, {size}',
    'settings.backup.othersSummary': '{n} more pre-restart snapshots (unverified, never restored automatically)',
    // THE CERTIFICATE VOCABULARY IS GONE (user decision, 2026-11-02). Two rounds
    // of deletion ended here: first the rendering stopped grading copies, then the
    // labels and now the evidence sentences themselves. Nothing draws them any
    // more — a copy is a time and a button — and a dictionary that still carried
    // them could be picked up again by a later change without anyone noticing that
    // it re-introduces a verdict the plugin cannot support.
    'settings.backup.scopeLabel': 'What it holds',
    'settings.backup.scope.config-only': 'configuration only',
    'settings.backup.scope.config+plugins': 'configuration and installed plugins',
    'settings.backup.scope.config+links': 'configuration and linked plugins',
    'settings.backup.scope.slim': 'slim copy (configuration and by-hand plugins)',
    'settings.backup.scopeMissing': '(not recorded)',
    'settings.backup.interventionLabel': 'Was this boot restored by the system',
    'settings.backup.intervention.true': 'yes, the system restored a copy',
    'settings.backup.intervention.false': 'no, nothing had to step in',
    'settings.backup.intervention.unknown': 'not recorded',
    // THE MANUAL ROLLBACK (user decision, 2026-10-30): any copy can be restored
    // — but only after a card that says which one, what it replaces, and that
    // a restart follows.
    'settings.backup.rollback': 'Roll back to this copy',
    // THE ONE SENTENCE THE PAGE MAY SAY ABOUT A COPY (user decision, 2026-11-02).
    //
    // It hangs on exactly one copy — the one taken at the most recent startup —
    // and it says only WHAT THAT COPY IS: the state the host last started from.
    // It does not say the copy is good, because the plugin cannot know that: a
    // plugin that fails to load is dropped and the host comes up anyway. Which
    // copy to roll back to is the reader's call, and the sentence ends by saying
    // so. Verbatim — do not reword.
    'settings.backup.startupHint': 'This is the state at the most recent startup. DSH starting does not mean every plugin is healthy — a broken plugin is excluded and the host still boots. Which copy to roll back to is your call.',
    'settings.backup.rollbackConfirmTitle': 'Roll back to this copy?',
    'settings.backup.rollbackConfirmBody': 'The backup from {time} will be restored over the current state — **what you have now is replaced** (a snapshot of it is taken first, so this rollback can be undone).',
    'settings.backup.rollbackConfirmRestart': 'A restart follows automatically: a restorable copy of what was here before the rollback was already saved; this restart takes no further backup. This page disconnects during the restart and works again afterwards.',
    'settings.backup.rollbackConfirmYes': 'Roll back',
    'settings.backup.rollbackConfirmNo': 'Cancel',
    'settings.backup.rollbackBusy': 'Rolling back…',
    'settings.backup.rollbackDone': 'Rolled back — restarting…',
    'settings.backup.rollbackFailed': 'The rollback did not work: {message}',
    'settings.groups.report': 'Something is wrong',
    'settings.report.label': 'Something wrong?',
    'settings.report.github': 'Copy the diagnostics and open a GitHub issue',
    'settings.report.hint': 'The diagnostics carry no access token and no secrets — paste them into the issue and we can see what went wrong.',
    'settings.report.email': 'No GitHub account? Write to {email}',
    'settings.report.copy': 'Copy the diagnostics',
    'settings.report.copyFailed': 'The copy failed — please copy this by hand',
    'settings.report.issueTitle': 'A problem with the restart / start at login',
    'settings.report.issueBody': 'Please paste the diagnostics you just copied below.\n\n## What happened\n\n\n## What you expected\n\n\n## How to reproduce\n',
    'settings.error': 'Could not save the settings: {message}',
    'settings.saveNotice.saved': 'Saved',
    'settings.saveNotice.failed': 'Not saved',
    'settings.saveNotice.dismiss': 'Dismiss',
    'sleep.dryRun.title': 'Dry run: the machine stays on',
    'sleep.dryRun.body': 'The rehearsal is over. This is the command it WOULD have run (nothing was executed):',
    'sleep.dryRun.close': 'Got it',
    'sleep.countdown.caption.20': 'The whale is casting her net',
    'sleep.countdown.caption.19': 'Your backup is already packed',
    'sleep.countdown.caption.18': 'One unfinished thought, one more',
    'sleep.countdown.caption.17': 'Everyone is quieting down',
    'sleep.countdown.caption.16': 'One last lap around the room',
    'sleep.countdown.caption.15': 'The sea is going dark',
    'sleep.countdown.caption.14': 'One light at a time goes out',
    'sleep.countdown.caption.13': 'The room has gone quiet',
    'sleep.countdown.caption.12': 'A little bit left',
    'sleep.countdown.caption.11': 'One last look at the screen',
    'sleep.countdown.caption.10': 'The whale counts the last seconds',
    'sleep.countdown.caption.9': 'Half the lights are out',
    'sleep.countdown.caption.8': 'The voices get quieter',
    'sleep.countdown.caption.7': 'The goodbyes are close',
    'sleep.countdown.caption.6': 'One last sip of the sea',
    'sleep.countdown.caption.5': 'The night wind gets lighter',
    'sleep.countdown.caption.4': 'Say good night',
    'sleep.countdown.caption.3': 'Three seconds, really',
    'sleep.countdown.caption.2': 'Time for one last goodbye',
    'sleep.countdown.caption.1': 'Good night 🌙',
    'sleep.countdown.caption.default': 'Good night 🌙',
    'sleep.countdown.remaining': '{n} seconds left',
    'sleep.countdown.cancel': 'Never mind, keep it on',
    'sleep.countdown.goodNight': 'Good night 🌙',
    'sleep.countdown.hint': 'Powering off in {n} seconds — pick "Never mind, keep it on" to stay.',
    'sleep.waiting.title': 'Waiting for everyone to finish',
    'sleep.waiting.body': 'Once these sessions are done, the machine powers off:',
    'sleep.waiting.count': '{n} task(s) still working',
    'sleep.waiting.subagents': '{k} of them are subagents',
    'sleep.waiting.blocker': '· {title}',
    'sleep.waiting.none': '(checking who is still busy)',
    'sleep.waiting.cancel': 'Keep it on',
    'sleep.shuttingDown.title': 'Good night 🌙',
    'sleep.shuttingDown.body': 'Powering off — the whale turned off the lights.',
    'sleep.shuttingDown.dryRun': 'Dry run: nothing will really be powered off (it would have run {command})',
    'sleep.shuttingDown.dismiss': 'Close this notice',
    'sleep.choice.title': 'Keep the graceful shutdown button?',
    'sleep.choice.body': 'It lives at the very bottom of the left sidebar, next to the Settings button: one click waits for every session to finish, counts down and powers the machine off.',
    'sleep.choice.keep': 'Keep it (recommended)',
    'sleep.choice.keepCta': 'Keep it',
    'sleep.choice.keepHint': 'One moon button at the bottom of the left sidebar: one click to shut down gracefully.',
    'sleep.choice.hide': 'No button, thanks',
    'sleep.choice.hideCta': 'No button',
    'sleep.choice.hideHint': 'The interface stays as it is; turn it on again in the settings whenever you want it.',
    'sleep.choice.footnote': 'You can change this later in Settings → Auto-restart & shut down',
    'sleep.choice.diagramLabel': 'The button sits at the bottom of the left sidebar, next to Settings',
    'sleep.choice.error': 'Could not save the choice: {message}',
    // The one-time announcement of a new feature. An installation that already
    // existed never sees the install prompt again, so this card is the only way
    // a new feature reaches it.
    'announcement.title': 'New feature: graceful shutdown',
    'announcement.line1': 'There is a new 🌙 "Shut down" button at the very bottom of the left sidebar.',
    'announcement.line2': 'Click it → once every conversation is done it counts down {n} seconds and powers the machine off.',
    'announcement.line2.generic': 'Click it → once every conversation is done it counts down a few seconds and powers the machine off.',
    'announcement.line3': 'To change that, go to "Settings → Auto-restart & shut down".',
    'announcement.disabled': 'The button is currently switched off; you can turn it on in the settings.',
    'announcement.button': 'Got it',
    'announcement.error': 'Could not record it: {message}',
    // THE LEFTOVERS OF AN OLDER BUILD (2026-11-06): asked ONCE, and gone for
    // good after the answer. There is deliberately no settings entry and no
    // permanent banner for this - the problem must disappear with the answer.
    'shellBackups.title': 'Backup leftovers from an older build',
    'shellBackups.line1': '{count} leftover directories, {size} in total.',
    'shellBackups.line2': 'They are half-finished copies without a manifest: nothing can restore them and nothing reads them any more.',
    'shellBackups.clean': 'Delete them',
    'shellBackups.self': 'I will handle them',
    'shellBackups.cleaned': '{count} directories removed, {size} freed.',
    'shellBackups.cleanedNothing': 'There was nothing left to clean.',
    'shellBackups.failed': '{count} directories could not be removed: {reason}',
    'shellBackups.selfDone': 'All right, it will not come back.',
    'shellBackups.error': 'Could not record it: {message}',
    'shellBackups.line1.noSize': '{count} leftover directories (their size was not measured).',
    'shellBackups.working': 'Cleaning, please wait',
    'shellBackups.refused': 'The host refused the answer.',
    'shellBackups.maybeLater': 'The cleanup may still be running — refresh the page to see the result.',
    // THE CLICK MUST BE SEEN (2026-11-07): a click that fails is a SENTENCE,
    // and the sentence is in the language of the user - never a silence and
    // never an English sentence from the browser.
    'shellBackups.error.cleanup': 'Could not finish the cleanup: {message}',
    'shellBackups.error.failed': 'Please try again.',
    'shellBackups.error.broken': 'Something went wrong on this page. Please refresh it and try again.',
    'shellBackups.workingSelf': 'Recording, please wait',
    // THE PLUGIN THAT DID NOT LOAD (user decision 2026-11-01): the host came up,
    // one plugin simply did not activate this time. Say so, and offer exactly
    // one action: put THIS one plugin back.
    'pluginFailure.title': "Something did not come up after the start",
        'pluginFailure.hint': "These are on record - you can restore them later from the Plugins page.",
        'settings.description': "Restarts DSH and snapshots it before every restart; there is an archive to look at, and nothing is restored automatically.",
        'settings.restore': "Restore",
    'settings.thirdParty': "You did not write this plugin yourself, so it cannot be restored from the backup - it has to be reinstalled.",
        'settings.version': "version {version}",
    'pluginFailure.dismiss': "Got it",
    'pluginFailure.dismissLabel': "Hide this for now (it comes back on the next start)",
    'pluginFailure.certainTitle': "These features did not come up this time",
    'pluginFailure.certainIntro': "They were there on the previous start and are not here now. That is something that happened, not a guess.",
    'pluginFailure.clueTitle': "These plugins differ from the backup",
    'pluginFailure.clueIntro': "The files of these plugins are not what the latest backup holds. They may simply have been upgraded - this block lists a difference, not a conclusion.",
    'pluginFailure.uiBlindSpot': "Also {count} interface module(s) did not appear this time (they do not map to a plugin you installed, so they are not listed here).",
    'pluginFailure.restoreAll': "Restore all ({count})",
    'pluginFailure.restoreAllDone': "Done: {done} restored, {failed} not restored.",
    'pluginFailure.close': "Dismiss this notice",
    'pluginFailure.linkedHint': "You wrote this plugin yourself and installed it as a link, so it can be put back from the backup directly.",
    'pluginFailure.thirdPartyHint': "This plugin was installed from elsewhere and the backup does not hold its files. To put it back, use the command below: it reinstalls the same version (not the latest one):",
    'pluginFailure.commandLabel': "Copy this command",
    // The way out for the people who do not like commands (user report,
    // 2026-11-05). It says WHAT the reinstall gives: the LATEST version, not
    // the one in the backup — the command above installs the backup version,
    // reinstalling from the interface does not.
    'pluginFailure.reinstallHint': "Not fond of commands? You can reinstall it from the Plugins page - but a reinstall from the interface gets you the latest version, not the one in the backup.",
    'pluginFailure.noCommandHint': "This plugin was installed from elsewhere. The backup holds neither its files nor its exact version, so there is no restore command to hand over this time.",
    'pluginFailure.restore': "Restore {plugin} only",
    'pluginFailure.restoring': "Restoring {plugin}…",
    'pluginFailure.restored': "{plugin} was put back to the backup version (backup taken {at}).",
    'pluginFailure.failed': "{plugin} was not restored: {reason}",
    'pluginFailure.noBackup': "There is no usable backup on this machine; it has to be handled by hand.",
    // THE COPY OF THE COMPOSER ROW (see the Chinese block): one short line,
    // never a sentence.
    'restart.stage.snapshotting': 'Backing up…',
    'restart.stage.restarting': 'Restarting…',
    'restart.stage.back': 'Back',
    // The centred overlay of a running restart.
    'restart.overlay.snapshotting': 'Backing up before DSH restart',
    'restart.overlay.size': '{done} / {total}',
    'restart.overlay.sizeDone': '{done}',
    'restart.overlay.restarting': 'Restarting…',
    'restart.overlay.deferred': 'A conversation just started — restart postponed',
    'restart.overlay.deferredNote': 'It will retry automatically when idle · {count} waiting',
    'restart.overlay.deferredNoteZero': 'It will retry automatically when idle',
    'restart.overlay.back': 'Back again',
  }

  /**
   * THE LOCALE SERVICE of the Host (null until the plugin is applied).
   *
   * It knows the active language: the user picked one in the settings, or
   * the browser's language decided. It is read at CALL time, so a language
   * switch is followed at once.
   */
  let localeService = null

  /**
   * The active language of this interface: 'zh' or 'en'.
   *
   * The Host's locale service decides; when it is not there (a slot rendered
   * without the locale seat, an old host), the browser's language does.
   * `zh*` is Chinese, everything else is English — the same rule the DSH
   * locale service uses.
   *
   * @returns {'zh'|'en'}
   */
  function currentLanguage() {
    let raw = ''
    try {
      if (localeService && typeof localeService.getLocale === 'function') {
        const snapshot = localeService.getLocale()
        if (snapshot && typeof snapshot.locale === 'string') raw = snapshot.locale
      }
    } catch {
      raw = ''
    }
    if (raw === '' && typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string') {
      raw = navigator.language
    }
    return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }

  /**
   * One text out of the built-in dictionaries.
   *
   * The dictionary of the current language wins; the Chinese original is the
   * second choice (a human-readable text beats a key name); the last resort
   * is the "missing" line — NEVER the key itself.
   *
   * @param {string} key
   * @param {'zh'|'en'} [language]
   * @returns {string}
   */
  function dictionaryText(key, language) {
    const lang = language === 'en' ? 'en' : 'zh'
    const table = lang === 'en' ? EN : ZH
    const value = table[key]
    if (typeof value === 'string' && value !== '') return value
    const chinese = ZH[key]
    if (typeof chinese === 'string' && chinese !== '') return chinese
    const missing = table['text.missing'] || ZH['text.missing'] || ''
    return typeof missing === 'string' ? missing : ''
  }

  /**
   * THE TRANSLATOR of this plugin.
   *
   * The Host's translator is used whenever it answers with a text. When it
   * does NOT know a key it answers with THE KEY (that is what the DSH locale
   * service does), and then the built-in dictionary takes over — so no user
   * ever sees a key name, in any language.
   *
   * @param {Function|null|undefined} t the Host's translator (may be missing)
   * @returns {(key: string, params?: object) => string}
   */
  function makeTranslate(t) {
    /**
     * `{name}` ANSWERED FROM `params` (user report, 2026-11-02).
     *
     * THE BUG THIS FIXES: this translator took ONE argument, so every call that
     * passed replacement values had them silently dropped and the page printed
     * the placeholder itself ("看门狗的触发方式：{tier}"). Three call sites did
     * exactly that; the ones that substitute by hand were never affected.
     *
     * THE RULES, each one a decision:
     *   - a placeholder with NO value stays as it is: blanking it would delete
     *     information the sentence was written to carry;
     *   - the value is inserted as literal text, so `$&` / `$1` are characters
     *     and not replace patterns (hence split + join, never `replace`);
     *   - every occurrence is replaced, not only the first;
     *   - a `null` / `undefined` value counts as "no value", never as the word
     *     `null` printed on screen.
     */
    const fillPlaceholders = (text, params) => {
      if (typeof text !== 'string' || text === '') return text
      if (params === null || params === undefined || typeof params !== 'object') return text
      let out = text
      for (const [name, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue
        const placeholder = '{' + name + '}'
        if (out.includes(placeholder) !== true) continue
        out = out.split(placeholder).join(String(value))
      }
      return out
    }
    return (key, params) => {
      const name = typeof key === 'string' ? key : String(key ?? '')
      if (typeof t === 'function') {
        try {
          const value = t(name)
          if (typeof value === 'string' && value !== '' && value !== name) return fillPlaceholders(value, params)
        } catch {
          // A broken translator must not break the surface.
        }
      }
      return fillPlaceholders(dictionaryText(name, currentLanguage()), params)
    }
  }

  /**
   * Read one translated string out of whatever the caller handed over.
   *
   * The caller may pass a translator function (the DSH locale binding), a
   * dictionary table (flat or nested) or a language code ('zh' / 'en'). A
   * translator that answers with the key itself has no entry: the built-in
   * dictionary is the fallback, so the copy is never hard-coded in a
   * component.
   *
   * @param {Function|object|string} locale
   * @param {string} key
   * @returns {string}
   */
  function lookupSleepText(locale, key) {
    if (typeof locale === 'function') {
      try {
        const value = locale(key)
        if (typeof value === 'string' && value !== '' && value !== key) return value
      } catch {
        // A broken translator must not break the surface.
      }
    }
    if (locale && typeof locale === 'object') {
      const direct = locale[key]
      if (typeof direct === 'string' && direct !== '') return direct
      const path = key.split('.')
      let node = locale
      for (const part of path) {
        if (!node || typeof node !== 'object') {
          node = undefined
          break
        }
        node = node[part]
      }
      if (typeof node === 'string' && node !== '') return node
    }
    if (typeof locale === 'string' && locale.toLowerCase().startsWith('en')) {
      const english = EN[key]
      if (typeof english === 'string' && english !== '') return english
    }
    const chinese = ZH[key]
    if (typeof chinese === 'string' && chinese !== '') return chinese
    // NEVER the key itself: a key name in the interface is a bug report.
    return dictionaryText(key, currentLanguage())
  }

  /**
   * The countdown caption of one second.
   *
   * The first twenty seconds have their own line each, so the caption rotates
   * while the number counts down. A LONGER countdown (30 or 60 seconds, both
   * offered in the settings) falls back to one generic line that carries the
   * remaining seconds, so every second of every offered length has a text.
   * Seconds outside the countdown (0, or more than the longest offered
   * countdown) use the "good night" line.
   *
   * @param {number} remainingSeconds
   * @param {Function|object|string} [locale] a translator, a dictionary or a language code
   * @returns {string}
   */
  function pickSleepCaption(remainingSeconds, locale) {
    const raw = Number(remainingSeconds)
    const seconds = Number.isFinite(raw) ? Math.ceil(raw) : 0
    if (seconds >= 1 && seconds <= 20) {
      return lookupSleepText(locale, 'sleep.countdown.caption.' + seconds)
    }
    if (seconds > 20 && seconds <= SLEEP_MAX_COUNTDOWN_SECONDS) {
      return lookupSleepText(locale, 'sleep.countdown.remaining').replace(/\{n\}/g, String(seconds))
    }
    return lookupSleepText(locale, 'sleep.countdown.caption.default')
  }

  /**
   * Whether the graceful-shutdown button may be shown.
   *
   * The Host's truth wins: an explicit `showSleepButton: false` or an
   * unsupported host hides the button (no placeholder, no space). An unknown
   * status does not forbid it — the caller decides with the local record
   * then.
   *
   * @param {object|null|undefined} status the Host's sleep status
   * @returns {boolean}
   */
  function shouldShowSleepButton(status) {
    if (!status || typeof status !== 'object') return true
    if (status.showSleepButton === false) return false
    if (status.phase === 'unsupported') return false
    const host = status.host
    if (host && typeof host === 'object' && host.kind === 'unsupported') return false
    return true
  }

  /**
   * The body of the `POST {prefix}/choice` request.
   *
   * Only the answers that were really given are sent, so the two questions
   * can also be answered one at a time.
   *
   * @param {{ includePlugins?: boolean, showSleepButton?: boolean }} [options]
   * @returns {{ includePlugins?: boolean, showSleepButton?: boolean }}
   */
  function buildChoiceBody(options) {
    const source = options && typeof options === 'object' ? options : {}
    const body = {}
    if (typeof source.includePlugins === 'boolean') body.includePlugins = source.includePlugins
    if (typeof source.showSleepButton === 'boolean') body.showSleepButton = source.showSleepButton
    return body
  }

  /**
   * The whole seconds a countdown still has to run.
   *
   * Rounded UP, so a countdown that has 400 ms left still shows "1" and the
   * number never skips a second.
   *
   * @param {number} ms
   * @returns {number}
   */
  function formatRemainingMs(ms) {
    const raw = Number(ms)
    if (!Number.isFinite(raw) || raw <= 0) return 0
    return Math.ceil(raw / 1000)
  }

  /**
   * Fill `{name}` placeholders in a locale template.
   *
   * The locale API is not assumed to interpolate, so the helpers below do it
   * themselves. This is the module-level twin of the panel's own `fill`.
   *
   * @param {string} template
   * @param {Record<string, unknown>} vars
   * @returns {string}
   */
  function fillTemplate(template, vars) {
    if (typeof template !== 'string') return ''
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    ))
  }

  /**
   * A duration as a locale string: "45 秒" / "3 分 12 秒" / "2 小时 5 分".
   *
   * @param {number} ms
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function formatDurationMs(ms, t) {
    const translate = makeTranslate(t)
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    if (totalSeconds < 60) return fillTemplate(translate('durationSeconds'), { n: totalSeconds })
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return fillTemplate(translate('durationMinutes'), { n: minutes, m: totalSeconds % 60 })
    const hours = Math.floor(minutes / 60)
    return fillTemplate(translate('durationHours'), { n: hours, m: minutes % 60 })
  }

  /**
   * A duration as a COMPACT locale string: "45 秒" / "3 分钟" / "2 小时 5 分".
   *
   * The capsule of the pending restart is ONE clipped line of 22px: it can
   * afford "16 分钟", not "16 分 37 秒". The precise duration belongs into the
   * tooltip, where there is room for it.
   *
   * @param {number} ms
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function formatCompactDurationMs(ms, t) {
    const translate = makeTranslate(t)
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    if (totalSeconds < 60) return fillTemplate(translate('durationSeconds'), { n: totalSeconds })
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return fillTemplate(translate('durationMinutesShort'), { n: minutes })
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0
      ? fillTemplate(translate('durationHoursShort'), { n: hours })
      : fillTemplate(translate('durationHoursMinutesShort'), { n: hours, m: rest })
  }

   /**
    * A WAIT, SAID THE WAY A PERSON SAYS IT (user report, 2026-11-03).
    *
    * Precision is not the point, recognition is: "约 2 小时 21 分" is what makes a
    * user believe the page looked at THEIR request. Seconds are rounded to words on
    * purpose — "47 秒" invites a precision nobody needs.
    */
   function humanWait(ms, translate) {
     const t = makeTranslate(translate)
     const value = Number(ms)
     if (Number.isFinite(value) !== true || value < 0) return ''
     if (value < 60_000) return t('restart.waitedSeconds')
     const totalMinutes = Math.floor(value / 60_000)
     if (totalMinutes < 60) return fillTemplate(t('restart.waitedMinutes'), { n: totalMinutes })
     const hours = Math.floor(totalMinutes / 60)
     const rest = totalMinutes % 60
     return rest === 0
       ? fillTemplate(t('restart.waitedHoursExact'), { n: hours })
       : fillTemplate(t('restart.waitedHours'), { n: hours, m: rest })
   }

   /** `2026-11-02T23:04:38+08:00` -> `2026-11-02 23:04:38` (the offset is the host's; no Date parsing). */
   function humanRequestedAt(raw) {
     const text = typeof raw === 'string' ? raw.trim() : ''
     if (text.length < 19) return ''
     return text.slice(0, 10) + ' ' + text.slice(11, 19)
   }

   /**
    * THE ONE SENTENCE ABOUT A REQUEST THAT DIED (user decision, 2026-11-03).
    *
    * ONLY the newest request is looked at, and only the outcome "the host came back
    * and settled it" is spoken about. A stale record must not follow the user around,
    * and a request that simply completed is not news.
    *
    * @returns {{ text: string, at: string, waited: string }|null}
    */
   function cancelledRestartNote(info, translate) {
     const request = info && typeof info === 'object' && info.restartRequest && typeof info.restartRequest === 'object'
       ? info.restartRequest
       : null
     if (request === null) return null
     if (request.state !== 'cancelled' || request.by !== 'boot-recovery') return null
     const at = humanRequestedAt(request.requestedAtLocal)
     const waited = humanWait(request.waitedMs, translate)
     if (at === '' || waited === '') return null
     const t = makeTranslate(translate)
     return { text: fillTemplate(t('settings.restart.cancelledNote'), { at, waited }), at, waited }
   }

  /* ------------------------------------------------------------------ *

   * The blocker lists: ONE rule for every surface that names them.
   *
   * The defect the real machine showed: the pending-restart bubble grew a
   * line that named EVERY blocker — and every AgentTeams member is a
   * subagent, so the names of one team turned into a string of a dozen
   * "…的子智能体" phrases that did not fit into a 22px pill any more and
   * were clipped away.
   *
   * The rule, in one place:
   *
   *   1. the subagents of ONE session are ONE item ("<that session>
   *      (N subagents)"); a plain session is an item of its own;
   *   2. a list names at most `BLOCKER_SUMMARY_LIMIT` items and says
   *      "… and N more" about the rest — never an endless list;
   *   3. the SHORT list shortens a name that is too long;
   *   4. the COMPLETE list goes into the tooltip (`title`).
   *
   * WHERE THE NAMES LIVE. The capsule of the pending restart is 22px high
   * and ONE line wide: a name in it is a name that gets clipped away. So
   * the capsule says NUMBERS ONLY ("已等 16 分钟 · 3 项任务在跑") and every
   * name goes into the tooltip (`title`) — where the COMPLETE list lives.
   * The shutdown card has room, so it keeps the readable list.
   *
   * THE TWO REAL SHAPES. The Host does not report the blockers in one shape,
   * so the rule has to read every field the Host actually sends:
   *
   *   A. the gate / the long wait / the state route (`index.js`,
   *      `describeBlocker` + `busyAgents`):
   *
   *        { sessionId, reason, busyReason?, kind, label, name,
   *          parentTitle, parentSessionId }
   *
   *      `label` is the title of the session — for a SUBAGENT it is the title
   *      of the session that created it, and `name` is the composed phrase
   *      ("<that session>'s subagent"). `parentSessionId` says which session
   *      it belongs to.
   *
   *   B. the shutdown card (`lib/sleep.js`, `blockerEntry`):
   *
   *        { sessionId, kind, label, name, parentTitle, title }
   *
   *      The SAME information, but WITHOUT `parentSessionId` — so the
   *      grouping falls back to the parent's title (`parentTitle`).
   *
   * A rule that only knows `parentSessionId` therefore groups the card
   * wrongly: every member of a team becomes an item of its own, which is
   * exactly the endless list the rule is there to prevent.
   * ------------------------------------------------------------------ */

  /**
   * How many blockers a bubble names at once.
   *
   * The bubble is a 22px high pill: a long list is clipped away, so the list
   * is capped and the complete list goes into the tooltip.
   */
  const BLOCKER_SUMMARY_LIMIT = 2

  /**
   * How many characters one name may have in the bubble.
   *
   * The bubble is small, so a long session title is shortened instead of
   * pushing the rest of the line out of the pill. The "…" is part of the
   * budget: the bubble never shows MORE than this many characters of one
   * name.
   */
  const BLOCKER_NAME_MAX_LENGTH = 12

  /** The character a shortened name ends with. */
  const BLOCKER_ELLIPSIS = '…'

  /**
   * A name that is at most `maxLength` characters long.
   *
   * The characters are counted, not the code units, so a name of Chinese
   * characters is cut after the requested number of characters. The ellipsis
   * counts towards the limit: a name of 12 characters is shown as 11
   * characters plus "…", never as 13.
   *
   * @param {string} name
   * @param {number} [maxLength]
   * @returns {string}
   */
  function truncateBlockerName(name, maxLength) {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') return ''
    const limit = Number.isFinite(maxLength) && maxLength > 0
      ? Math.floor(maxLength)
      : BLOCKER_NAME_MAX_LENGTH
    const characters = Array.from(text)
    if (characters.length <= limit) return text
    if (limit === 1) return BLOCKER_ELLIPSIS
    return characters.slice(0, limit - 1).join('') + BLOCKER_ELLIPSIS
  }

  /**
   * One trimmed string field of a blocker, or '' when the field is missing.
   *
   * @param {any} entry
   * @param {string} key
   * @returns {string}
   */
  function blockerField(entry, key) {
    if (!entry || typeof entry !== 'object') return ''
    const value = entry[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * WHAT a blocker is: a session, a subagent or a pending restart.
   *
   * The Host says it (`kind`), but the kind is NOT the only evidence: an
   * entry that names a parent session (`parentSessionId` / `parentTitle`) IS
   * a subagent, whatever the Host called it. A Host that does not label the
   * kind must not turn a team of subagents into a list of single items.
   *
   * @param {any} entry
   * @returns {'session'|'subagent'|'restart-pending'}
   */
  function blockerEntryKind(entry) {
    if (!entry || typeof entry !== 'object') return 'session'
    if (entry.kind === 'restart-pending') return 'restart-pending'
    if (entry.kind === 'subagent') return 'subagent'
    if (entry.kind === 'session') return 'session'
    if (blockerField(entry, 'parentSessionId') !== '' || blockerField(entry, 'parentTitle') !== '') {
      return 'subagent'
    }
    return 'session'
  }

  /**
   * The title of the session a subagent belongs to.
   *
   * For a subagent the Host's `label` IS the title of the session that
   * created it (that is what the "…的子智能体" name is built from);
   * `parentTitle` is the same title under its own name, and `title` is the
   * old alias of `label`.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerParentTitle(entry) {
    return blockerField(entry, 'label')
      || blockerField(entry, 'parentTitle')
      || blockerField(entry, 'title')
  }

  /**
   * The identity of the session that created a subagent — the key its
   * subagents are grouped by.
   *
   * The parent session id is the exact identity. The parent's title is the
   * fallback for the surfaces that do not carry the id: the shutdown card
   * reports `parentTitle` but NO `parentSessionId`, so without this
   * fallback every member of a team would become an item of its own.
   *
   * @param {any} entry
   * @returns {string|null}
   */
  function blockerParentKey(entry) {
    const id = blockerField(entry, 'parentSessionId')
    if (id !== '') return 'id:' + id
    const title = blockerField(entry, 'parentTitle')
    if (title !== '') return 'title:' + title
    const label = blockerField(entry, 'label')
    if (label !== '') return 'label:' + label
    return null
  }

  /* ------------------------------------------------------------------ *
   * THE TASK COUNT: one rule, four surfaces.
   *
   * A TASK is one conversation of the left sidebar: the session itself. A
   * subagent belongs to the session that spawned it, so a session and its
   * subagents are ONE task — the sidebar counts them once, and so does the
   * bubble.
   *
   * The defect this fixes: the bubble counted every BLOCKER, so a session
   * with two subagents was three tasks. The sidebar showed two busy
   * conversations and the bubble said "waiting for 3 tasks to finish".
   *
   * The rule:
   *
   *   - a session is a task of its own (its key is its own session id);
   *   - a subagent belongs to the session that created it (its key is the
   *     PARENT's session id), so a parent and its subagents are ONE task;
   *   - a subagent whose parent is only known by its TITLE joins the session
   *     with that title (the shutdown card reports the title but no id);
   *   - a subagent with no known parent is a task of its own;
   *   - a pending restart is not a task.
   *
   * MIRRORED: `lib/blockers.js` (the host half) carries the same rule — the
   * client is a CLASSIC script and cannot import that module. The two
   * implementations MUST agree, and `test/task-count.test.mjs` runs the same
   * cases through both.
   * ------------------------------------------------------------------ */

  /** The prefix of the key of a family that is known by its session id. */
  const TASK_KEY_SESSION = 'session:'

  /** The prefix of the key of a family that is only known by its title. */
  const TASK_KEY_TITLE = 'title:'

  /**
   * The session id of a blocker.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerSessionId(entry) {
    if (!entry || typeof entry !== 'object') return ''
    const value = entry.sessionId
    return value == null ? '' : String(value).trim()
  }

  /**
   * The title of the session a subagent belongs to.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerTaskParentTitle(entry) {
    return blockerField(entry, 'parentTitle') || blockerField(entry, 'label')
  }

  /**
   * The title of a blocker (for a session: its own title).
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerTaskTitle(entry) {
    return blockerField(entry, 'label') || blockerField(entry, 'title')
  }

  /**
   * The map "title of a session" → "session id" of the sessions in the list.
   *
   * @param {any[]} entries
   * @returns {Map<string, string>}
   */
  function blockerTaskTitles(entries) {
    const map = new Map()
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      if (blockerEntryKind(entry) === 'subagent') continue
      const title = blockerTaskTitle(entry)
      if (title === '') continue
      const id = blockerSessionId(entry)
      if (id === '') continue
      if (!map.has(title)) map.set(title, id)
    }
    return map
  }

  /**
   * The key of the family every entry belongs to.
   *
   * One key per entry, in the order of the list ('' for an entry that is not a
   * task at all).
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {string[]}
   */
  function blockerTaskKeys(entries) {
    const list = Array.isArray(entries) ? entries : []
    const titles = blockerTaskTitles(list)
    const keys = []
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index]
      if (!entry || typeof entry !== 'object') {
        keys.push('')
        continue
      }
      const kind = blockerEntryKind(entry)
      if (kind === 'restart-pending') {
        // A pending restart is not a task: it is what the shutdown waits for.
        keys.push('')
        continue
      }
      if (kind === 'subagent') {
        const parentId = blockerField(entry, 'parentSessionId')
        if (parentId !== '') {
          keys.push(TASK_KEY_SESSION + parentId)
          continue
        }
        const parentTitle = blockerTaskParentTitle(entry)
        if (parentTitle !== '') {
          const known = titles.get(parentTitle)
          keys.push(known ? TASK_KEY_SESSION + known : TASK_KEY_TITLE + parentTitle)
          continue
        }
        const own = blockerSessionId(entry)
        keys.push(own !== '' ? TASK_KEY_SESSION + own : 'entry:' + index)
        continue
      }
      const own = blockerSessionId(entry)
      keys.push(own !== '' ? TASK_KEY_SESSION + own : 'entry:' + index)
    }
    return keys
  }

  /**
   * How many TASKS the blockers are.
   *
   * A parent session and its own subagents are ONE task: the same number the
   * left sidebar shows.
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {number}
   */
  function countBlockerTasks(entries) {
    const keys = blockerTaskKeys(entries)
    const families = new Set()
    for (const key of keys) {
      if (key !== '') families.add(key)
    }
    return families.size
  }

  /**
   * THE number of tasks the pending restart waits for — ONE source for every
   * surface of the interface.
   *
   * THE DEFECT THIS FIXES (user report, 2026-10-29)
   *
   * The capsule said "还有 1 个会话在忙" while the panel it opens said
   * "这次重启还在等 0 个会话". Two numbers, ONE fact: the capsule counted
   * the blockers itself, the panel re-counted a FILTERED copy of them (the own
   * session dropped out, the goal blockers dropped out) — so the same pending
   * restart was "1" on one line and "0" on the next.
   *
   * THE RULE
   *
   * The Host counts the TASKS that hold the gate and publishes the number as
   * `busyCount` on its state route. Everything reads THAT number — the
   * capsule, its panel and the long-wait line — so the two can never disagree
   * again. Only a payload without the number (an older Host, a test fixture)
   * falls back to counting the blockers, and then both surfaces count the SAME
   * list.
   *
   * A blocker WITHOUT a readable name is still a task: the count never drops
   * to 0 just because the name is missing.
   *
   * @param {any} info the state payload of the Host
   * @param {any[]} [entries] the list to count when the Host sent no number
   * @returns {number}
   */
  function waitingTaskCount(info, entries) {
    const host = info && typeof info === 'object' ? info.busyCount : undefined
    if (typeof host === 'number' && Number.isFinite(host) && host >= 0) return Math.floor(host)
    return countBlockerTasks(Array.isArray(entries) ? entries : [])
  }

  /**
   * How many of those tasks are carried by SUBAGENTS ONLY.
   *
   * A task whose session is idle and whose subagent works is a task of the
   * subagent — that is what the card tells the user ("2 of them are
   * subagents"). A task whose session works itself is not one of them, even
   * when it has subagents of its own.
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {number}
   */
  function countSubagentTasks(entries) {
    const list = Array.isArray(entries) ? entries : []
    const keys = blockerTaskKeys(list)
    const families = new Map()
    list.forEach((entry, index) => {
      const key = keys[index]
      if (key === '') return
      const family = families.get(key) || { session: false, subagent: false }
      if (blockerEntryKind(entry) === 'subagent') family.subagent = true
      else family.session = true
      families.set(key, family)
    })
    let count = 0
    for (const family of families.values()) {
      if (family.subagent && !family.session) count += 1
    }
    return count
  }

  /**
   * The readable name of one blocker.
   *
   * The Host names a session by its title (`label`, also carried as `name`)
   * and a subagent by the whole phrase ("<that session>'s subagent"). A
   * surface that carries the title under the old name (`title`) still gets a
   * name; an entry without any of them has nothing to show.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerEntryName(entry) {
    if (!entry || typeof entry !== 'object') return ''
    return blockerField(entry, 'name')
      || blockerField(entry, 'label')
      || blockerField(entry, 'title')
      || blockerField(entry, 'parentTitle')
  }

  /**
   * The blockers of one list, grouped by the session that created them.
   *
   * A subagent belongs to the session that spawned it, so N subagents of one
   * session are ONE item. A plain session is an item of its own: it is a
   * conversation in its own right, even when its own subagents are busy too.
   *
   * The group key is the parent session id when the surface reports it, and
   * the parent's TITLE when it does not (the shutdown card reports
   * `parentTitle` but no id).
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {Array<{ key: string, kind: string, label: string, name: string, count: number, entry: any, sessionIds: string[] }>}
   */
  function groupBlockers(entries) {
    const list = Array.isArray(entries) ? entries : []
    const groups = []
    const byKey = new Map()
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const kind = blockerEntryKind(entry)
      // A subagent of a KNOWN session joins that session's group. A subagent
      // whose parent is unknown joins the one generic group of parentless
      // subagents — they are counted ("N subagents"), not listed one by one.
      const parent = kind === 'subagent' ? (blockerParentKey(entry) || 'unknown') : null
      const sessionId = entry.sessionId == null ? '' : String(entry.sessionId)
      const key = parent !== null ? 'parent:' + parent : 'own:' + kind + ':' + sessionId
      let group = byKey.get(key)
      if (!group) {
        group = {
          key,
          kind,
          parentSessionId: blockerField(entry, 'parentSessionId') || null,
          // The label of a subagent group is the title of the session that
          // created it; the label of a session is its own title.
          label: kind === 'subagent'
            ? blockerParentTitle(entry)
            : (blockerField(entry, 'label') || blockerField(entry, 'title')),
          name: blockerEntryName(entry),
          count: 0,
          entry,
          sessionIds: [],
        }
        byKey.set(key, group)
        groups.push(group)
      }
      group.count += 1
      group.sessionIds.push(sessionId)
      if (group.label === '') {
        group.label = kind === 'subagent'
          ? blockerParentTitle(entry)
          : (blockerField(entry, 'label') || blockerField(entry, 'title'))
      }
      if (group.name === '') group.name = blockerEntryName(entry)
    }
    return groups
  }

  /**
   * The name of one group, as it is shown.
   *
   * A group of more than one subagent is named after the session that
   * created them ("<that session> (N subagents)"); a lone subagent keeps its
   * own name ("<that session>'s subagent").
   *
   * @param {any} group one group of `groupBlockers`
   * @param {(name: string) => string} t the translator
   * @param {number} maxLength how many characters the name may have
   * @param {boolean} shorten whether the name may be shortened
   * @returns {string}
   */
  function blockerGroupName(group, t, maxLength, shorten) {
    if (!group) return ''
    const translate = makeTranslate(t)
    if (group.kind === 'subagent') {
      // A group of MORE THAN ONE subagent is named after the session that
      // created them ("<that session> (N subagents)"); a lone subagent keeps
      // its own name ("<that session>'s subagent").
      if (group.count > 1) {
        const label = shorten ? truncateBlockerName(group.label, maxLength) : group.label
        return label === ''
          ? fillTemplate(translate('blockerGroupSubagentsGeneric'), { n: group.count })
          : fillTemplate(translate('blockerGroupSubagents'), { label, n: group.count })
      }
      const own = group.name || group.label
      if (own !== '') return shorten ? truncateBlockerName(own, maxLength) : own
      // A lone subagent without any name at all: the generic line still says
      // something — an empty name never reaches the interface.
      return fillTemplate(translate('blockerGroupSubagentsGeneric'), { n: group.count })
    }
    const name = group.name || group.label
    return shorten ? truncateBlockerName(name, maxLength) : name
  }

  /**
   * The names of the blockers: a SHORT summary for the bubble and the
   * COMPLETE list for the tooltip.
   *
   * The summary never grows without a bound: at most `limit` items, every
   * name shortened to `maxNameLength` characters, and a "… and N more" for
   * the rest. The complete list names every group with its full name — it is
   * only ever shown in a tooltip, where there is room for it.
   *
   * @param {any[]} entries the blockers the Host reported
   * @param {{ t?: Function, limit?: number, maxNameLength?: number, joiner?: string }} [options]
   * @returns {{ groups: any[], summary: string, full: string, total: number }}
   */
  function summarizeBlockers(entries, options) {
    const opts = options && typeof options === 'object' ? options : {}
    const translate = makeTranslate(opts.t)
    const limit = Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : BLOCKER_SUMMARY_LIMIT
    const maxNameLength = Number.isFinite(opts.maxNameLength) && opts.maxNameLength > 0
      ? Math.floor(opts.maxNameLength)
      : BLOCKER_NAME_MAX_LENGTH
    const joiner = typeof opts.joiner === 'string' ? opts.joiner : translate('blockerJoin')
    const groups = groupBlockers(entries)

    const full = groups
      .map((group) => blockerGroupName(group, translate, maxNameLength, false))
      .filter((name) => name !== '')
      .join(joiner)

    const shown = groups.slice(0, limit)
    const names = shown
      .map((group) => blockerGroupName(group, translate, maxNameLength, true))
      .filter((name) => name !== '')
    const rest = groups.length - shown.length
    const more = rest > 0 ? fillTemplate(translate('blockerMore'), { n: rest }) : ''

    return {
      groups,
      total: groups.length,
      // How many of the groups carry a name at all: a list of unnamed blockers
      // has nothing to show, so a caller can leave its clause out.
      named: groups.filter((group) => blockerGroupName(group, translate, maxNameLength, false) !== '').length,
      summary: names.length === 0 ? translate('blockerGeneric') : (names.join(joiner) + more),
      full: full === '' ? translate('blockerGeneric') : full,
    }
  }

  /**
   * The note of a LONG wait.
   *
   * The Host says that the pending restart is still waiting while a conversation
   * runs on (there is no deadline). That is not "a little longer", so
   * the bubble says it out loud: how long the restart has been waiting and who
   * holds it. The note is empty when there is no long wait.
   *
   * @param {any} info the state payload of the Host
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function formatLongWaitNote(info, t) {
    return formatLongWaitNoteParts(info, t).note
  }

  /**
   * The note of a LONG wait, in both shapes: the CAPSULE shows the numbers
   * only, the tooltip the COMPLETE list.
   *
   * The capsule of the pending restart is 22px high and ONE line wide: a name
   * in it is a name that gets clipped away. So the capsule says HOW LONG the
   * restart has been waiting and HOW MANY tasks are running — never WHO they
   * are — and every name goes into the tooltip.
   *
   * @param {any} info the state payload of the Host
   * @param {(name: string) => string} [t] the translator
   * @returns {{ note: string, full: string, pill: string, summary: string, count: number, hasLongWait: boolean }}
   */
  function formatLongWaitNoteParts(info, t) {
    const translate = makeTranslate(t)
    const longWait = info && typeof info === 'object' ? info.longWait : null
    if (!longWait || typeof longWait !== 'object') {
      return { note: '', full: '', pill: '', summary: '', count: 0, hasLongWait: false }
    }
    const blockedBy = Array.isArray(longWait.blockedBy) ? longWait.blockedBy : []
    const summary = summarizeBlockers(blockedBy, { t: translate })
    // The precise duration belongs into the tooltip, the COMPACT one into the
    // capsule: the capsule cannot afford "16 分 37 秒".
    const duration = formatDurationMs(longWait.waitedMs, translate)
    const compact = formatCompactDurationMs(longWait.waitedMs, translate)
    // THE same number the capsule and its panel show (the Host's `busyCount`
    // when it sends one): a session and its own subagents are ONE task.
    const count = waitingTaskCount(info, blockedBy)
    // The tooltip: the whole story, every name, nothing cut.
    const sentence = fillTemplate(translate('longWaitTooltip'), { duration, blockers: summary.full })
    return {
      // The CAPSULE: numbers only, no name at all.
      pill: fillTemplate(translate('longWaitPill'), { duration: compact, n: count }),
      note: sentence,
      full: sentence,
      summary: summary.summary,
      count,
      hasLongWait: true,
    }
  }

  /**
   * The readable reason why a manual cancel did not work.
   *
   * The Host answers with a machine reason (`not-a-requester`,
   * `session-id-required`, …); the panel of the capsule shows something a
   * person can act on.
   *
   * @param {any} body the answer of the Host
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function cancelFailureText(body, t) {
    const translate = makeTranslate(t)
    if (body && typeof body.error === 'string' && body.error.trim() !== '') return body.error.trim()
    if (body && typeof body.reason === 'string') {
      if (body.reason === 'not-a-requester') return translate('cancelNotRequester')
      if (body.reason === 'no-restart-pending') return translate('cancelNothingPending')
      if (body.reason === 'session-id-required' || body.reason === 'no-session-id') {
        return translate('cancelUnknownSession')
      }
    }
    return translate('cancelFailed')
  }

  /**
   * The URL the browser has to move to after a restart, or null.
   *
   * THE LOCKOUT. The boot token of `dsh web` is created PER PROCESS, so the
   * link the browser holds answers 401 after a restart: the user sits in front
   * of a page that cannot talk to its own host. The Host publishes the access
   * link of the instance that is really running, so the browser can follow it —
   * that is the way back in.
   *
   * The rules (ALL of them must hold, or nothing happens at all):
   *   - the access link carries a token;
   *   - the current URL carries a token too — a URL without one is an ordinary
   *     session, and following the link would reload the page for nothing;
   *   - the two tokens differ (otherwise there is nothing to follow);
   *   - the origin and the path are the same: the plugin never sends the
   *     browser to another host or to another page.
   *
   * @param {string} currentUrl the URL the browser is on
   * @param {string} accessUrl the access link the Host published
   * @returns {string|null} the URL to move to, or null
   */
  function resolveAccessRedirect(currentUrl, accessUrl) {
    const from = typeof currentUrl === 'string' ? currentUrl : ''
    const to = typeof accessUrl === 'string' ? accessUrl : ''
    if (from === '' || to === '') return null
    let current
    let next
    try {
      current = new URL(from)
      next = new URL(to, from)
    } catch {
      return null
    }
    if (next.origin !== current.origin) return null
    if (next.pathname !== current.pathname) return null
    const currentToken = current.searchParams.get('token')
    const nextToken = next.searchParams.get('token')
    if (!currentToken || !nextToken || currentToken === nextToken) return null
    return next.toString()
  }

  /**
   * The label of "who starts this host".
   *
   * The Host reports the mode; this only turns it into a word the user can
   * read: the supervisor of this plugin, the user's own way, nobody, or off.
   *
   * @param {Function} t the translator
   * @param {any} status the supervisor status of the Host
   * @returns {string}
   */
  /** Strip the little markdown the host-side advice may carry (bold, code). */
  function stripMarkdown(value) {
    if (typeof value !== 'string') return ''
    return value.replace(/\*\*/g, '').replace(/`/g, '').trim()
  }

  /** A human label for an autostart kind — the raw code never reaches the user. */
  function humanKind(translate, kind) {
    const raw = typeof kind === 'string' ? kind.trim() : ''
    if (raw !== '') {
      const key = 'settings.autostartKind.' + raw
      const text = translate(key)
      if (typeof text === 'string' && text !== '' && text !== key) return text
    }
    return translate('settings.autostartKind.other')
  }

  /** One localised sentence saying WHY this startup mode was detected. */
  function startupWhy(translate, startup) {
    if (!startup || typeof startup !== 'object') return ''
    const mode = typeof startup.mode === 'string' ? startup.mode.trim() : ''
    if (mode !== '') {
      const key = 'settings.startupWhy.' + mode
      const text = translate(key)
      if (typeof text === 'string' && text !== '' && text !== key) return text
    }
    return stripMarkdown(typeof startup.evidence === 'string' ? startup.evidence : '')
  }

  function supervisorModeLabel(t, status) {
    const translate = makeTranslate(t)
    const mode = status && typeof status === 'object' ? status.mode : ''
    if (mode === 'installed') return translate('settings.supervisor.installed')
    if (mode === 'external') return translate('settings.supervisor.external')
    if (mode === 'off') return translate('settings.supervisor.off')
    // The desktop app relaunches itself: it is not "nobody knows".
    if (mode === 'app') return translate('settings.supervisor.app')
    return translate('settings.supervisor.unknown')
  }

  /**
   * The label of "how this host was started" (the startup matrix).
   *
   * @param {Function} t the translator
   * @param {any} startup the startup classification of the Host
   * @returns {string}
   */
  function startupModeLabel(t, startup) {
    const translate = makeTranslate(t)
    const mode = startup && typeof startup === 'object' ? startup.mode : ''
    if (mode === 'bare') return translate('settings.supervisor.startup.bare')
    if (mode === 'external') return translate('settings.supervisor.startup.external')
    if (mode === 'container') return translate('settings.supervisor.startup.container')
    if (mode === 'desktop') return translate('settings.supervisor.startup.desktop')
    if (mode === 'self-supervised') return translate('settings.supervisor.startup.selfSupervised')
    return translate('settings.supervisor.startup.unknown')
  }

  /**
   * May the panel offer to install the supervisor of this plugin?
   *
   * The browser side serves the desktop app AND the hosted web host, so it may
   * not assume one of them:
   *
   *   - the desktop app brings itself back up (there is nothing to install);
   *   - a host that somebody ELSE supervises must not get a SECOND supervisor:
   *     both would start the host and they would fight over the port;
   *   - the automatic restart may be switched off;
   *   - a host whose starter could not be established gets NOTHING: the
   *     plugin would rather say "I cannot tell" than start a second host.
   *
   * When the Host says nothing, the answer is "no": an unknown host is no
   * reason to touch the machine. The UNINSTALL button always stays available
   * when a supervisor of this plugin is installed — removing it is always
   * allowed.
   *
   * @param {any} status the supervisor status of the Host
   * @param {any} host the host block of the Host (which end this is)
   * @returns {boolean}
   */
  function canOfferSupervisorInstall(status, host) {
    if (!status || typeof status !== 'object') return false
    if (status.installed === true) return true
    const isDesktop = host && typeof host === 'object' && host.isDesktopApp === true
    if (isDesktop) return false
    // The startup matrix has the final word: only a bare host (nobody manages
    // it) may get a supervisor of this plugin.
    const startup = status.startup && typeof status.startup === 'object' ? status.startup : null
    if (startup !== null && startup.canInstallSupervisor !== true) return false
    const mode = typeof status.mode === 'string' ? status.mode : ''
    if (mode === 'external' || mode === 'off') return false
    // The Host says the desktop app manages itself: a supervisor there would
    // start a SECOND client at every login.
    if (mode === 'app') return false
    return true
  }

  /**
   * The body of a pre-filled issue must stay short: URLs have a length limit.
   * The full diagnostics travel by clipboard, not by URL.
   */
  const REPORT_BODY_LIMIT = 800;

  /**
   * Cut a text to a length limit.
   *
   * @param {string} text
   * @param {number} [limit]
   * @returns {string}
   */
  function truncateReportText(text, limit) {
    const source = typeof text === 'string' ? text : '';
    const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : REPORT_BODY_LIMIT;
    if (source.length <= max) return source;
    return source.slice(0, Math.max(0, max - 1)) + '…';
  }

  /**
   * The pre-filled "new issue" URL.
   *
   * The title and the body are encoded, so Chinese text and spaces survive.
   *
   * @param {string} base the "new issue" page
   * @param {string} title
   * @param {string} body
   * @returns {string}
   */
  function buildIssueUrl(base, title, body) {
    const root = typeof base === 'string' && base.trim() !== '' ? base.trim() : '';
    const safeTitle = truncateReportText(title, 200);
    const safeBody = truncateReportText(body, REPORT_BODY_LIMIT);
    return root + '?title=' + encodeURIComponent(safeTitle) + '&body=' + encodeURIComponent(safeBody);
  }



  /**
   * Copy a text to the clipboard — with a FALLBACK.
   *
   * `navigator.clipboard` is refused in an insecure context and when the
   * permission was not given. Then the text is returned, so the caller can
   * show it in a box the user can select and copy by hand.
   *
   * @param {string} text
   * @param {object} [options]
   * @returns {Promise<{ ok: boolean, fallback: boolean, text: string }>}
   */
  async function copyReportText(text, options) {
    const source = typeof text === 'string' ? text : '';
    const clipboard = options && typeof options.clipboard === 'object'
      ? options.clipboard
      : (typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null);
    try {
      if (clipboard && typeof clipboard.writeText === 'function') {
        await clipboard.writeText(source);
        return { ok: true, fallback: false, text: source };
      }
    } catch {
      // The clipboard refused it: the text goes back to the caller.
    }
    return { ok: false, fallback: true, text: source };
  }


  /**
   * Whether the "how was this host started" block may be shown at all.
   *
   * The desktop client brings ITSELF back up: it has no restart command to
   * derive and it must never write one, so the whole block stays away there.
   * When the Host does not say which kind of host this is, the block stays
   * away too — "not shown" is better than "shown and misleading".
   *
   * @param {object|null|undefined} info the Host's state payload
   * @returns {boolean}
   */
  function shouldShowStartupBlock(info) {
    if (!info || typeof info !== 'object') return false
    const instance = info.instance && typeof info.instance === 'object' ? info.instance : null
    const supervisor = info.supervisor && typeof info.supervisor === 'object' ? info.supervisor : null
    const mode = supervisor && typeof supervisor.mode === 'string' ? supervisor.mode : ''
    // The desktop app: it manages itself.
    if (instance && instance.isDesktopApp === true) return false
    if (mode === 'app') return false
    // A hosted host the Host confirms.
    if (instance && instance.isDesktopApp === false) return true
    if (mode === 'installed' || mode === 'external' || mode === 'auto' || mode === 'off') return true
    // Unknown: nothing is shown.
    return false
  }

  /**
   * The one line that tells the user what this plugin remembers about the
   * way their host is started — in plain words.
   *
   * @param {Function} t the translator
   * @param {object|null|undefined} info the Host's state payload
   * @returns {{ key: string, canDerive: boolean }}
   */
  function startupStatusLine(t, info) {
    const supervisor = info && typeof info.supervisor === 'object' && info.supervisor !== null ? info.supervisor : {}
    const startup = supervisor.startup && typeof supervisor.startup === 'object' ? supervisor.startup : {}
    const restart = info && typeof info.restart === 'object' && info.restart !== null ? info.restart : {}
    const mode = typeof startup.mode === 'string' ? startup.mode : ''
    const written = restart.written === true
    if (mode === 'external') return { key: 'settings.supervisor.status.external', canDerive: false }
    if (mode === 'self-supervised') return { key: 'settings.supervisor.status.selfSupervised', canDerive: false }
    if (mode === 'container') return { key: 'settings.supervisor.status.container', canDerive: false }
    if (mode === 'bare') {
      return written
        ? { key: 'settings.supervisor.status.bareWritten', canDerive: false }
        : { key: 'settings.supervisor.status.bareUnknown', canDerive: true }
    }
    return { key: 'settings.supervisor.status.unknown', canDerive: false }
  }

  /**
   * The size of one backup, with the unit that fits it (the manifest carries
   * the byte count).
   *
   * 92 KB stays 92 KB and 156 MB stays 156 MB: the tenth is kept only when it
   * says something ("117.7 MB"), never as a pointless "156.0 MB".
   *
   * @param {number|null|undefined} bytes
   * @returns {string}
   */
  function formatBackupSize(bytes) {
    const value = Number(bytes)
    if (!Number.isFinite(value) || value < 0) return ''
    const units = [
      { size: 1024 * 1024 * 1024, suffix: 'GB' },
      { size: 1024 * 1024, suffix: 'MB' },
      { size: 1024, suffix: 'KB' },
    ]
    for (const unit of units) {
      if (value < unit.size) continue
      const scaled = Math.round((value / unit.size) * 10) / 10
      // 156.0 → 156, 117.7 → 117.7: the tenth only when it says something.
      return (Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1)) + ' ' + unit.suffix
    }
    return Math.round(value) + ' B'
  }

  /**
   * THE GRADING OF COPIES IS GONE (user decision, 2026-11-02).
   *
   * The page used to sort every copy into an identity and let only one of them
   * carry a verdict — a source plus a criterion ("full-checks" AND
   * "fingerprint-match") had to agree before a row was allowed to look better
   * than the others. Two things were wrong with that and the user ruled both
   * out: the verdict was read as "the plugins in it are fine", which a boot
   * cannot establish (a plugin that fails to load is dropped and the host comes
   * up anyway), and on a hosted instance nothing ever qualified, so the good tier
   * stayed empty while every real copy sat in the demoted row.
   *
   * So there is no `isSafeBackup`, no identity key and no per-copy label any
   * more: a row is a time and a button. What replaces the question is one fact
   * the page can state honestly — WHICH COPY IS THE STATE THE HOST LAST STARTED
   * FROM — and that is `startupCopyName` below.
   */

  /**
   * The moment a copy says it was taken, read from the copy's OWN record.
   *
   * `takenAt` is the take time under the name the Host records it with; `at` is
   * the number the same manifest has carried for longer. Either may arrive as a
   * number of milliseconds or as an ISO string. A copy that says neither cannot
   * answer the question, and gets no sentence at all — silence beats a guess.
   *
   * @param {object|null|undefined} item one backup of the state payload
   * @returns {number|null}
   */
  function copyTakeTime(item) {
    if (!item) return null
    for (const value of [item.takenAt, item.at]) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
    }
    return null
  }

  /**
   * WHICH COPY WAS TAKEN AT THE MOST RECENT STARTUP? (user decision, 2026-11-02)
   *
   * The answer is the copy whose own record carries the latest take time: that is
   * the state the host was started from the last time it came up. It is
   * deliberately NOT "the first row of the list" — the row order is a rendering
   * detail, and a page that read its fact from the row order would move the one
   * sentence onto a different copy the day the order changes (or silently onto
   * the wrong copy when the list is not sorted).
   *
   * Nothing here judges the copy: the sentence this name selects says what the
   * copy IS, never that it is healthy.
   *
   * @param {Array<object>|null|undefined} items the copies as the Host reports them
   * @returns {string|null} the name of that copy, or null when no copy can say
   */
  function startupCopyName(items) {
    if (!Array.isArray(items)) return null
    let best = null
    for (const item of items) {
      if (!item || typeof item.name !== 'string' || item.name === '') continue
      const at = copyTakeTime(item)
      if (at === null) continue
      if (best === null || at > best.at) best = { name: item.name, at }
    }
    return best === null ? null : best.name
  }

  /**
   * THE TWO KEY MAPPERS OF THE CERTIFICATE VOCABULARY ARE GONE (user decision,
   * 2026-11-02). One named the source that "signed" a copy, the other the
   * criterion that backed it; both existed only to pick a per-copy sentence out
   * of the dictionary. No row grades a copy any more, so once the list stopped
   * rendering identities they had no caller left — deleted rather than kept as a
   * hook a later change could quietly revive. Their dictionary entries went with
   * them: the whole "who certified it" family is not in this file any more.
   */

  /** Which dictionary entry describes what a copy holds. */
  function backupScopeKey(contentScope) {
    if (contentScope === 'config-only') return 'config-only'
    if (contentScope === 'config+plugins') return 'config+plugins'
    if (contentScope === 'config+links') return 'config+links'
    if (contentScope === 'slim') return 'slim'
    return ''
  }

  /**
   * Whether this boot was restored by the system, in three answers.
   *
   * `null` is NOT "no": the Host says `null` when nobody recorded anything, and
   * the two must not be merged — "it did not happen" and "we do not know" lead a
   * reader to different conclusions.
   */
  function backupInterventionKey(intervention) {
    if (intervention === true) return 'true'
    if (intervention === false) return 'false'
    return 'unknown'
  }

  /**
   * The version a copy was proven with, or an empty string when it carries none.
   *
   * @param {object|null|undefined} item one backup of the state payload
   * @returns {string}
   */
  function backupVersionOf(item) {
    return item && typeof item.version === 'string' && item.version !== '' ? item.version : ''
  }

  /**
   * The local time of one backup, to the minute.
   *
   * The directory name is UTC on purpose, so the panel shows the LOCAL time
   * the manifest carries: a fresh snapshot can never look like an old one.
   *
   * The OFFSET is dropped on purpose (user report, 2026-10-29): the string is
   * already the local time of the machine that took the copy, so "+08:00" is
   * noise to whoever reads it — and the seconds never say anything either.
   *
   * @param {string|null|undefined} atLocal
   * @returns {string}
   */
  function formatBackupTime(atLocal) {
    if (typeof atLocal !== 'string' || atLocal.trim() === '') return ''
    const text = atLocal.trim().replace('T', ' ')
    // "2026-10-29 22:08:46+08:00" → "2026-10-29 22:08" (date and minute only).
    const matched = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(text)
    if (matched) return matched[0]
    // Anything else: at least never show an offset.
    return text.replace(/ ?([+-]\d{2}:?\d{2}|Z)$/, '')
  }

  /**
   * THE COPY OF THE COMPOSER ROW: one SHORT line, never a sentence.
   *
   * WHY (user report, 2026-10-29): the pill sits in the composer tool row — a
   * single clipped line inside a 22px toolbar. The long stage sentence
   * ("正在等待所有会话空闲…（还有 1 个会话在忙）") was cut off on a narrow
   * window and the ellipsis ate exactly the part that mattered.
   *
   * SO the pill now shows ONE of these, and nothing else:
   *
   *   while the gate waits      待重启 · 空闲后自动重启   (the composed line of
   *                             the pill itself — it already carries the short
   *                             count of the tasks that hold the gate)
   *   while the snapshot runs   重启前备份中
   *   while the host goes down  正在重启…
   *   after the new host is up  已回来           (1.5s, then the pill is plain)
   *
   * The detail — the number of busy conversations, the megabytes of the copy,
   * the progress bar — lives in the CENTRED OVERLAY (`restart.overlay.*`),
   * where there is room for it. The words come from the same dictionaries as
   * everything else, so no surface has a second source of truth.
   */
  const RESTART_PILL_STAGE_KEYS = Object.freeze({
    // `waiting` is deliberately MISSING: while the gate waits the pill already
    // says "待重启 · 等待 N 个…" / "待重启 · 空闲后自动重启", and saying
    // the stage as well would put two lines into a one-line row.
    snapshotting: 'restart.stage.snapshotting',
    restarting: 'restart.stage.restarting',
    back: 'restart.stage.back',
  })

  /**
   * The locale keys of the centred overlay.
   *
   * `waiting` is deliberately MISSING: while the gate waits for the other
   * conversations there is NOTHING in progress yet, so no card is drawn at all
   * (user report, 2026-10-29: "不是应该触发备份才触发吗？备份完就消失" — a card
   * that said "等待会话空闲" hung on screen for ten minutes while the request
   * merely queued). The waiting count belongs to the pill, which is where it
   * always was: "待重启 · 等待 N 个会话".
   */
  const RESTART_OVERLAY_KEYS = Object.freeze({
    snapshotting: 'restart.overlay.snapshotting',
    restarting: 'restart.overlay.restarting',
    back: 'restart.overlay.back',
  })

  /**
   * Is this a stage the centred overlay draws at all?
   *
   * @param {unknown} phase
   * @returns {boolean}
   */
  function isRestartOverlayPhase(phase) {
    return typeof phase === 'string' && Object.prototype.hasOwnProperty.call(RESTART_OVERLAY_KEYS, phase)
  }

  /**
   * THE COPY OF THE COMPOSER ROW for a stage ('' = the pill keeps its own
   * composed line, "待重启 · …").
   *
   * @param {{ phase?: string }|null|undefined} stage the `restartPhase` payload
   * @param {Function} [translator] the translator (the built-in one otherwise)
   * @returns {string}
   */
  function restartPillStageText(stage, translator) {
    const phase = stage && typeof stage === 'object' && typeof stage.phase === 'string' ? stage.phase : ''
    if (!Object.prototype.hasOwnProperty.call(RESTART_PILL_STAGE_KEYS, phase)) return ''
    const t = typeof translator === 'function' ? translator : makeTranslate(null)
    return t(RESTART_PILL_STAGE_KEYS[phase])
  }

  /**
   * The short line of the centred overlay for a stage ('' when there is none).
   *
   * @param {{ phase?: string }|null|undefined} stage
   * @param {Function} [translator]
   * @returns {string}
   */
  /**
   * HOW LONG THE "RESTART POSTPONED" CARD STAYS ON SCREEN (milliseconds).
   *
   * THE REPORT (user, 2026-10-30): "after the interruption I still have a lot of
   * work to do — a card hovering for ever is in the way". The postponed card is an
   * ANNOUNCEMENT, not a progress bar: it says what happened for four seconds and
   * then folds away, while the capsule keeps saying "pending restart · waiting for
   * N sessions". A NEW postponement (a new stage timestamp) announces itself again.
   *
   * The stages that really are running ('snapshotting', 'restarting') are not
   * affected: they stay while the work lasts.
   */
  const RESTART_DEFERRED_CARD_MS = 4000

  /**
   * HOW LONG A STAGE MAY GO UNMENTIONED BEFORE THE CARD STOPS TRUSTING IT.
   *
   * WHY (user report, 2026-10-29): a restart was postponed (a conversation
   * became active again) right after the copy, and the card kept saying
   * "DSH 重启前备份中" for ever — the stage on disk had not been brought back to
   * 'waiting'. The Host is fixed, but the interface must not be able to hang on
   * a stale stage either: a stage is evidence only while it keeps being
   * refreshed.
   */
  const RESTART_STAGE_STALE_MS = 15000
  // While files are being copied the Host refreshes the stage on every progress
  // tick, so ten silent seconds mean the copy is no longer reporting — either it
  // is over or nobody is copying any more. A 'restarting' stage has no progress
  // of its own and only has to stay inside the stale window above.
  const RESTART_SNAPSHOT_FRESH_MS = 10000

  /**
   * THE TWO CADENCES OF THE SHARED POLL (milliseconds).
   *
   * 2 s is right for a page that merely shows whether a restart is pending: a
   * pending restart sits there for minutes. While a restart is MOVING, though,
   * the stage can flip at any moment (a conversation starts, the host postpones
   * the restart, the card has to change its words) — and 2 s of the wrong word is
   * exactly what the owner complained about. So the cadence follows the state.
   */
  const POLL_MS = 2000
  const POLL_FAST_MS = 500

  /**
   * IS A RESTART MOVING RIGHT NOW?
   *
   * 'waiting' counts as well: the restart is requested and the gate may open (or
   * a conversation may appear) at any moment — that is exactly when the card must
   * change its words within a second.
   *
   * @param {object|null} info the state payload of the Host
   * @returns {boolean}
   */
  function isRestartMoving(info) {
    if (!info || typeof info !== 'object') return false
    if (info.pendingRestart !== true) return false
    const stage = info.restartPhase
    const phase = stage && typeof stage.phase === 'string' ? stage.phase : ''
    return phase === 'waiting' || phase === 'snapshotting' || phase === 'restarting'
  }

  /**
   * The cadence the CURRENT state asks for.
   *
   * @param {object|null} info the state payload of the Host
   * @returns {number} milliseconds
   */
  function pollIntervalFor(info) {
    return isRestartMoving(info) ? POLL_FAST_MS : POLL_MS
  }

  /**
   * Is the page on screen? A hidden tab has nobody to tell, so it must not spin
   * (and it asks once more as soon as it is visible again).
   *
   * @returns {boolean}
   */
  function isPageVisible() {
    if (typeof document === 'undefined' || !document) return true
    if (document.hidden === true) return false
    if (typeof document.visibilityState === 'string') return document.visibilityState !== 'hidden'
    return true
  }

  /**
   * IS THE RESTART POSTPONED BY A CONVERSATION? (the Host says so in `reason`)
   *
   * A postponed restart is a stage of 'waiting' with a reason that starts with
   * "deferred:" (see the Host's deferRestartStage). That state is NOT an activity,
   * so it is drawn differently: the card names the interruption and promises the
   * retry, and the word "正在重启" never appears for it.
   *
   * @param {object|null} stage the `restartPhase` of the state route
   * @returns {boolean}
   */
  function isRestartStageDeferred(stage) {
    if (!stage || typeof stage !== 'object') return false
    if (stage.phase !== 'waiting') return false
    return typeof stage.reason === 'string' && stage.reason.indexOf('deferred:') === 0
  }

  /**
   * Is the reported stage still something the card may draw?
   *
   * The card is an ALARM about something happening right now: 'snapshotting'
   * (files are being copied) or 'restarting' (the host is going down). A stage
   * that nobody refreshed for 15 s (10 s for a copy, which refreshes on every
   * file) describes something that is not happening any more, and drawing it
   * would leave a card hanging — exactly the bug to avoid. The pill keeps
   * telling the user the restart is still pending; the card simply stops
   * claiming progress.
   *
   * @param {object|null} stage the `restartPhase` of the state route
   * @param {number} now
   * @returns {boolean}
   */
  function isRestartStageLive(stage, now) {
    const phase = stage && typeof stage.phase === 'string' ? stage.phase : ''
    if (phase !== 'snapshotting' && phase !== 'restarting') return false
    const at = stage && Number.isFinite(Number(stage.at)) ? Number(stage.at) : null
    // No timestamp at all: the stage cannot be trusted to describe "now".
    if (at === null || at <= 0) return false
    const age = Math.max(0, now - at)
    if (age > RESTART_STAGE_STALE_MS) return false
    if (phase === 'restarting') return true
    return age <= RESTART_SNAPSHOT_FRESH_MS
  }

  function restartOverlayTitle(stage, translator) {
    const phase = stage && typeof stage === 'object' && typeof stage.phase === 'string' ? stage.phase : ''
    if (!isRestartOverlayPhase(phase)) return ''
    const t = typeof translator === 'function' ? translator : makeTranslate(null)
    return t(RESTART_OVERLAY_KEYS[phase])
  }

  /**
   * A SIZE, WITH THE UNIT THAT FITS IT: "92 KB", "156 MB", "12.3 MB", "0 B".
   *
   * WHY the unit is chosen here (user report, 2026-10-29): a hosted profile is
   * only 92 KB. Printed in megabytes that is "0.1 MB" at best and "0 MB" after
   * rounding — the size of a real backup would have looked like nothing at all.
   * So: below 1 MB the number is KB, below 1 KB it is B, and a whole number of
   * megabytes keeps no ".0".
   *
   * @param {number|null|undefined} bytes
   * @returns {string} '' when the Host did not measure anything
   */
  function formatOverlaySize(bytes) {
    // No measurement is NOT a measurement of zero: a missing byte count must
    // never be printed as "0" (Number(null) is 0, which is exactly the trap).
    if (bytes === null || bytes === undefined || bytes === '') return ''
    const value = Number(bytes)
    if (!Number.isFinite(value) || value < 0) return ''
    if (value < 1024) return Math.round(value) + ' B'
    if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB'
    return String(Math.round((value / (1024 * 1024)) * 10) / 10) + ' MB'
  }

  /**
   * A SIZE, WITH THE UNIT THAT FITS IT — and GIGABYTES, because the leftovers
   * of an old build are measured in gigabytes (the real machine: 23 966 MB).
   *
   * The rest is the rule of `formatOverlaySize`: the unit travels with the
   * number, a whole number of megabytes keeps no ".0", and a missing
   * measurement is never printed as "0".
   *
   * @param {number|null|undefined} bytes
   * @returns {string} '' when there is no measurement
   */
  function formatShellSize(bytes) {
    if (bytes === null || bytes === undefined || bytes === '') return ''
    const value = Number(bytes)
    if (!Number.isFinite(value) || value < 0) return ''
    if (value < 1024) return Math.round(value) + ' B'
    if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB'
    if (value < 1024 * 1024 * 1024) return String(Math.round((value / (1024 * 1024)) * 10) / 10) + ' MB'
    return String(Math.round((value / (1024 * 1024 * 1024)) * 10) / 10) + ' GB'
  }

  /**
   * The named exports of this module.
   *
   * The client module system materializes `factory(require) -> exports`, so
   * these helpers ARE the module's exports; they are mirrored on
   * `globalThis.__dshAutorestartClient` for the tests that evaluate the file
   * without a loader.
   */
  const SLEEP_EXPORTS = {
    pickSleepCaption,
    shouldShowSleepButton,
    buildChoiceBody,
    formatRemainingMs,
    formatLongWaitNote,
    formatLongWaitNoteParts,
    formatCompactDurationMs,
    cancelFailureText,
    groupBlockers,
    summarizeBlockers,
    truncateBlockerName,
    // The task count: one rule, four surfaces (mirrored from lib/blockers.js).
    // `waitingTaskCount` is THE number the capsule and its panel both show.
    blockerTaskKeys,
    countBlockerTasks,
    waitingTaskCount,
    countSubagentTasks,
    resolveAccessRedirect,
    supervisorModeLabel,
    stripMarkdown,
    humanKind,
    startupWhy,
    startupModeLabel,
    canOfferSupervisorInstall,
    // "Report a problem": the URL builders and the clipboard with its fallback.
    buildIssueUrl,
    copyReportText,
    // The startup block: whether it may be shown, the one line that says what
    // the plugin remembers, and the formatters of the backup list.
    shouldShowStartupBlock,
    startupStatusLine,
    formatBackupSize,
    formatBackupTime,
    // The stage of a restart on the two surfaces that have room for it: the
    // composer row (one short line) and the centred overlay (the detail).
    isRestartOverlayPhase,
    // Is the reported stage still worth a card? (a stale stage cannot hang it)
    isRestartStageLive,
    isRestartStageDeferred,
    RESTART_DEFERRED_CARD_MS,
    // The cadence of the shared poll: fast while a restart is moving, and no
    // polling at all in a hidden tab.
    isRestartMoving,
    pollIntervalFor,
    isPageVisible,
    POLL_MS,
    POLL_FAST_MS,
    RESTART_STAGE_STALE_MS,
    RESTART_SNAPSHOT_FRESH_MS,
    restartPillStageText,
    restartOverlayTitle,
    // The size with the unit that fits it ("92 KB", "156 MB"): a hosted profile
    // is small enough that megabytes would round it to "0 MB".
    formatOverlaySize,
    // The TRANSLATOR: the Host's one when it answers, the built-in dictionary
    // when it does not (a key name is never shown).
    makeTranslate,
    currentLanguage,
    dictionaryText,
    // The two dictionaries, so a test can build a translator without a Host.
    dictionaries: { zh: ZH, en: EN },
  }

  if (typeof globalThis !== 'undefined' && globalThis !== null) {
    try {
      globalThis.__dshAutorestartClient = Object.assign(globalThis.__dshAutorestartClient || {}, SLEEP_EXPORTS)
    } catch {
      // A frozen global must not break the plugin.
    }
  }

  // The loader call is guarded so this file can also be evaluated outside a
  // browser (the tests read the exports above without a loader).
  const moduleLoader = typeof window !== 'undefined' && window.__ModuleLoader__ ? window.__ModuleLoader__ : null
  if (moduleLoader) moduleLoader.load({
    id: 'dsh-autorestart',
    factory: function (require) {
      const React = require('react')
      const h = React.createElement
      const { useState, useEffect, useRef } = React

      const NS = 'dshAutorestart'
      const HEALTH_URL = '/__dsh_autorestart/health?state=1'
      // The route prefix is derived from the health URL, so the park route is
      // never spelled out twice: the health path without its last segment.
      // The Host sends the authoritative `parkUrl` in the state payload; this
      // is only the fallback for an older Host.
      const ROUTE_PREFIX = HEALTH_URL.split('?')[0].replace(/\/[^/]*$/, '')
      const DEFAULT_PARK_URL = ROUTE_PREFIX + '/park'
      const DEFAULT_CANCEL_URL = ROUTE_PREFIX + '/cancel'
      // The route of the MANUAL ROLLBACK (restore ONE copy the user picked).
      const DEFAULT_ROLLBACK_URL = ROUTE_PREFIX + '/rollback-to'
      // The route that writes the copy limit (how many backups to keep). It has a
      // default for the same reason the rollback does: this page must not depend
      // on an optional field of the state payload to be able to send a write.
      const DEFAULT_BACKUP_LIMIT_URL = ROUTE_PREFIX + '/backup-limit'
      // The route that persists the one-time install choice.
      const DEFAULT_CHOICE_URL = ROUTE_PREFIX + '/choice'
      // The browser-side record of the one-time install choice. The prompt is
      // shown only while this key is missing, so it is asked exactly once.
      const BACKUP_CHOICE_KEY = 'dsh-autorestart:backup-choice-v1'

      /**
       * The route that installs, uninstalls and reports the supervisor.
       *
       * The Host sends the authoritative one with the state payload; this is
       * the fallback for a Host that is older than the supervisor.
       */
      const DEFAULT_SUPERVISOR_URL = '/__dsh_autorestart/supervisor'
      // The cadence lives with the state it follows (see POLL_MS/POLL_FAST_MS
      // above): the shared poll speeds up while a restart is moving.
      // The brand accent (blue-purple). The pending-restart marker is a brand
      // signal, not a warning: no warning/yellow token is used here.
      const BRAND = 'var(--dsw-alias-brand-primary, #5b8def)'

      // The shared "imminent restart" pulse. The keyframes live in ONE <style>
      // element so the two surfaces (pill dot + sidebar dot) never animate with
      // two different rules.
      const PULSE_STYLE_ID = 'dsh-autorestart-pulse'
      const PULSE_ANIMATION_NAME = 'dsh-autorestart-pulse'
      const PULSE_ANIMATION = PULSE_ANIMATION_NAME + ' 1.8s ease-in-out infinite'
      // Only `transform` and `opacity` are animated: the dot must not resize and
      // must never push the composer row around.
      const PULSE_CSS = [
        '@keyframes ' + PULSE_ANIMATION_NAME + ' {',
        '  0%, 100% { transform: scale(1); opacity: 1; }',
        '  50% { transform: scale(1.5); opacity: 0.55; }',
        '}',
      ].join('\n')

      // Bound during `apply`. The slots are registered without a locale
      // namespace, so the components read the translator through this
      // factory-scoped handle instead of a standard `t` prop.
      let translate = null

      /**
       * THE STAGE LINE of a running restart, in the reader's language.
       *
       * The Host sends BOTH languages (`text: { zh, en }`) with every stage, so
       * the pill and the settings page need no locale key that an older Host
       * might not ship — and there is exactly ONE sentence per stage instead of
       * two that could drift apart.
       *
       * @param {object|null} stage the `restartPhase` of the state payload
       * @returns {string} the sentence, or '' when there is no restart
       */
      function restartStageText(stage) {
        if (!stage || typeof stage !== 'object') return ''
        const text = stage.text && typeof stage.text === 'object' ? stage.text : null
        if (!text) return ''
        const lang = typeof document !== 'undefined' && document.documentElement && document.documentElement.lang
          ? String(document.documentElement.lang)
          : (typeof navigator !== 'undefined' && navigator.language ? String(navigator.language) : 'en')
        const zh = lang.toLowerCase().indexOf('zh') === 0
        const picked = zh ? (text.zh || text.en) : (text.en || text.zh)
        return typeof picked === 'string' ? picked : ''
      }

      /**
       * May this restart still be called off?
       *
       * It is the HOST that decides (`cancellable`): once the host is on its
       * way out, a cancel button would be a promise the plugin cannot keep, so
       * it is shown disabled together with the reason.
       *
       * @param {object|null} stage
       * @returns {boolean}
       */
      function restartStageLocked(stage) {
        if (!stage || typeof stage !== 'object') return false
        return stage.cancellable === false
      }

      /**
       * ONE shared poller, shared by every surface that shows the pending
       * restart state (the composer pill and the sidebar session-row dot).
       *
       * The store lives at factory scope, so the first subscriber starts ONE
       * 2s interval plus an immediate fetch, and the last one to leave clears
       * the interval and aborts the in-flight request. A failed fetch keeps the
       * last known value, so a transient error never blanks a live marker.
       */
      const stateStore = {
        info: null,
        listeners: new Set(),
        timer: null,
        // The cadence the current timer was armed with (0 = not armed).
        interval: 0,
        inFlight: false,
        controller: null,
        // When the pending state was FIRST observed, so the details panel can
        // say how long this session has been waiting.
        pendingSince: null,
        // The visibility listener is bound once, on the first subscriber.
        visibilityBound: false,
      }

      function notifyListeners() {
        stateStore.listeners.forEach((listener) => {
          try {
            listener(stateStore.info)
          } catch {
            // One broken listener must not stop the others.
          }
        })
      }

      /**
       * Follow the access link the Host published, when the one the browser
       * holds is stale.
       *
       * After a restart the boot token of the old link is dead, so the browser
       * would sit on a page that cannot talk to its host. The Host reports the
       * access link of the instance that is really running; when it differs,
       * the browser moves there.
       */
      function followAccessUrl(body) {
        if (typeof window === 'undefined' || !window.location) return
        const target = resolveAccessRedirect(window.location.href, body && body.accessUrl)
        if (!target) return
        try {
          window.location.replace(target)
        } catch {
          // A browser that refuses the navigation must not break the poll.
        }
      }

      /**
       * (Re-)arm the shared timer with the cadence the state asks for.
       *
       * THE CADENCE IS RE-DECIDED AFTER EVERY ANSWER: a restart that starts makes
       * the next tick 500 ms away, a restart that ends puts it back to 2 s, and a
       * hidden page is not polled at all (an interval in a background tab only
       * spends battery — it asks once as soon as it is visible again).
       *
       * Re-arming only happens when the cadence really changed, so the ticks stay
       * evenly spaced and never pile up.
       */
      function armPoll() {
        if (stateStore.listeners.size === 0) return
        const wanted = isPageVisible() ? pollIntervalFor(stateStore.info) : 0
        if (wanted === 0) {
          if (stateStore.timer !== null) {
            clearInterval(stateStore.timer)
            stateStore.timer = null
          }
          stateStore.interval = 0
          return
        }
        if (stateStore.timer !== null && stateStore.interval === wanted) return
        if (stateStore.timer !== null) clearInterval(stateStore.timer)
        stateStore.interval = wanted
        stateStore.timer = setInterval(() => {
          pollOnce().then(armPoll)
        }, wanted)
      }

      /**
       * Ask once more as soon as the page is back on screen.
       *
       * A hidden tab stops polling; coming back must not wait for the next tick of
       * a timer that was stopped, so the visibility event polls immediately and
       * then re-arms the cadence.
       */
      function bindVisibility() {
        if (stateStore.visibilityBound) return
        if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return
        stateStore.visibilityBound = true
        document.addEventListener('visibilitychange', () => {
          if (stateStore.listeners.size === 0) return
          if (!isPageVisible()) {
            armPoll()
            return
          }
          pollOnce().then(armPoll)
          armPoll()
        })
      }

      async function pollOnce() {
        // ONE REQUEST AT A TIME: a slow answer must never stack up a queue.
        if (stateStore.inFlight) return
        // Nobody is looking at a hidden tab; the next visible moment asks.
        if (!isPageVisible()) return
        stateStore.inFlight = true
        try {
          const response = await fetch(HEALTH_URL, {
            cache: 'no-store',
            signal: stateStore.controller ? stateStore.controller.signal : undefined,
          })
          if (!response.ok) return
          const body = await response.json()
          if (!body || typeof body !== 'object') return
          stateStore.info = body
          // The boot token is created per process: after a restart the link the
          // browser holds answers 401. The Host publishes the access link of
          // the instance that is really running — following it is the way back
          // into the interface.
          followAccessUrl(body)
          if (body.pendingRestart === true) {
            if (stateStore.pendingSince === null) stateStore.pendingSince = Date.now()
          } else {
            stateStore.pendingSince = null
          }
          notifyListeners()
        } catch {
          // Ignored on purpose: the marker must never break the composer or the
          // sidebar. The last known value is kept.
        } finally {
          stateStore.inFlight = false
        }
      }

      /**
       * Adds a listener and starts the shared poll when it is the first one.
       * Returns the unsubscribe callback, which stops the shared poll when the
       * last listener leaves.
       */
      function subscribe(listener) {
        stateStore.listeners.add(listener)
        if (stateStore.listeners.size === 1) {
          stateStore.controller = new AbortController()
          bindVisibility()
          pollOnce().then(armPoll)
          armPoll()
        }
        return () => {
          stateStore.listeners.delete(listener)
          if (stateStore.listeners.size === 0) {
            if (stateStore.timer !== null) {
              clearInterval(stateStore.timer)
              stateStore.timer = null
            }
            stateStore.interval = 0
            if (stateStore.controller) {
              stateStore.controller.abort()
              stateStore.controller = null
            }
            // The last subscriber left: the shared keyframes rule goes away too.
            removePulseStyle()
          }
        }
      }

      /**
       * Hook-like reader for the shared state: returns the current info and
       * re-renders the caller whenever the shared poll lands a new value.
       */
      function useSharedInfo(enabled) {
        const active = enabled !== false
        const [info, setInfo] = useState(stateStore.info)
        useEffect(() => {
          if (!active) return undefined
          setInfo(stateStore.info)
          return subscribe(setInfo)
        }, [active])
        return info
      }

      /**
       * Inject the shared pulse keyframes exactly once. The id keeps a second
       * injection from duplicating the rule, and the element is removed again
       * when the last subscriber leaves.
       */
      function ensurePulseStyle() {
        if (typeof document === 'undefined' || !document.head) return
        try {
          if (document.getElementById(PULSE_STYLE_ID)) return
          const style = document.createElement('style')
          style.id = PULSE_STYLE_ID
          style.textContent = PULSE_CSS
          document.head.appendChild(style)
        } catch {
          // Without the rule the dot simply does not pulse; nothing else breaks.
        }
      }

      /** Remove the shared pulse keyframes (the last subscriber left). */
      function removePulseStyle() {
        if (typeof document === 'undefined') return
        try {
          const node = document.getElementById(PULSE_STYLE_ID)
          if (node && node.parentNode) node.parentNode.removeChild(node)
        } catch {
          // Nothing to clean up.
        }
      }

      /** True when the user asked the OS to reduce motion. */
      function prefersReducedMotion() {
        try {
          if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
          return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
        } catch {
          return false
        }
      }

      /** The dot style, with the pulse applied when the restart is imminent. */
      function dotStyle(base, pulsing) {
        if (!pulsing) return base
        return {
          ...base,
          animation: PULSE_ANIMATION,
          transformOrigin: 'center',
        }
      }

      /**
       * Fill `{name}` placeholders in a locale template. The locale API is not
       * assumed to interpolate, so the panel does it itself.
       */
      function fill(template, vars) {
        if (typeof template !== 'string') return ''
        return template.replace(/\{(\w+)\}/g, (match, name) => (
          vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
        ))
      }

      /**
       * The line of one blocker: a session and a subagent are told apart, and
       * neither of them is ever shown as a raw session id.
       *
       * The Host says WHAT the blocker is (`kind`) and HOW it is called: a
       * session by its own title (`label`), a subagent by the whole phrase
       * (`name`: "写代码的会话的子智能体"). The phrase is used as it is — it
       * reads as a sentence, while a bracketed label would read like an
       * annotation. A subagent whose parent title is unknown has no name of its
       * own, so it gets the generic line instead of an empty bracket.
       *
       * @param {any} entry the blocker the Host reported
       * @returns {string}
       */
      function blockerLine(entry) {
        const t = makeTranslate(translate)
        // The SAME rule as the grouping: an entry that names a parent is a
        // subagent, whatever the Host called it.
        const kind = blockerEntryKind(entry)
        const label = kind === 'subagent'
          ? blockerParentTitle(entry)
          : (blockerField(entry, 'label') || blockerField(entry, 'title'))
        if (kind === 'restart-pending') {
          // A pending restart goes first: the shutdown waits for it.
          return t('panelBlockedRestartPending')
        }
        if (kind === 'subagent') {
          const name = blockerField(entry, 'name')
          if (name === '' || label === '') return t('panelBlockedSubagentGeneric')
          return fill(t('panelBlockedSubagent'), { name })
        }
        return label === ''
          ? t('panelBlockedGeneric')
          : fill(t('panelBlockedSession'), { label })
      }

      /**
       * Whether a blocker is a pending RESTART (and not a task that is running).
       *
       * The restart is not a task: it is the thing the shutdown waits for, so it
       * is never counted as one.
       *
       * @param {any} entry
       * @returns {boolean}
       */
      function isRestartPending(entry) {
        return Boolean(entry) && entry.kind === 'restart-pending'
      }

      /**
       * The line of one GROUP of blockers.
       *
       * The N subagents of ONE session are one line: the session is named once
       * and the number of its subagents says how many there are. A group of one
       * keeps the ordinary line (a session, or a lone subagent).
       *
       * @param {any} group one group of `groupBlockers`
       * @returns {string}
       */
      function blockerGroupLine(group) {
        const t = makeTranslate(translate)
        if (!group) return ''
        if (group.kind === 'subagent' && group.count > 1) {
          return group.label === ''
            ? fill(t('panelBlockedSubagentGroupGeneric'), { n: group.count })
            : fill(t('panelBlockedSubagentGroup'), { label: group.label, n: group.count })
        }
        return blockerLine(group.entry)
      }

      /** How long the pending restart has been waiting, as a locale string. */
      function formatWaiting(ms, t) {
        const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000))
        if (totalSeconds < 60) return fill(t('durationSeconds'), { n: totalSeconds })
        const minutes = Math.floor(totalSeconds / 60)
        if (minutes < 60) return fill(t('durationMinutes'), { n: minutes, m: totalSeconds % 60 })
        const hours = Math.floor(minutes / 60)
        return fill(t('durationHours'), { n: hours, m: minutes % 60 })
      }

      /**
       * The park route to POST to: the one the Host sent with the state payload,
       * or the one derived from the health path when the Host is older.
       */
      function parkUrlFor(info) {
        const sent = info && typeof info.parkUrl === 'string' ? info.parkUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return DEFAULT_PARK_URL
      }

      /**
       * The route that persists the one-time install choice: the one the Host
       * sent with the state payload, or the one derived from the health path.
       */
      function choiceUrlFor(info) {
        const sent = info && typeof info.choiceUrl === 'string' ? info.choiceUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return DEFAULT_CHOICE_URL
      }

      /**
       * The route that withdraws ONE session's own restart request: the one the
       * Host sent with the state payload, or the one derived from the health
       * path.
       */
      function cancelUrlFor(info) {
        const sent = info && typeof info.cancelUrl === 'string' ? info.cancelUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return DEFAULT_CANCEL_URL
      }

      /**
       * The route that restores ONE backup the user picked (the manual
       * rollback): the one the Host sent with the state payload, or the derived
       * default. It never carries a path — only a backup NAME goes in the body.
       */
      function rollbackUrlFor(info) {
        const sent = info && typeof info.rollbackUrl === 'string' ? info.rollbackUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return DEFAULT_ROLLBACK_URL
      }

      /**
       * The route that writes the backup copy limit (user decision, 2026-11-02).
       *
       * THE BUG THIS FIXES (user report, 2026-11-02: "2 份改 3 份不生效"): the
       * Host sends `healthUrl` as a FULL URL (`http://127.0.0.1:<port>/…/health`),
       * and this function only accepted a value starting with `/` — so it fell
       * through to `''`, and `submitBackupLimit` returned before it ever called
       * `fetch`. Nothing was sent, nothing was said, and the number did not move.
       * The sibling of health is the same path with its last segment replaced,
       * whether the Host spelled it as a path or as an absolute URL; when it
       * sends neither, the derived default is used — exactly like the rollback
       * route, which never had this problem.
       */
      function backupLimitUrlFor(info) {
        const sent = info && typeof info.backupLimitUrl === 'string' ? info.backupLimitUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        const health = info && typeof info.healthUrl === 'string' ? info.healthUrl.trim() : ''
        const asSibling = health.replace(/\/[^/?]+(\?.*)?$/, '/backup-limit')
        // An absolute URL keeps only its path: every write in this client is a
        // same-origin path, and the page's own origin is the instance it talks to.
        if (/^https?:\/\//i.test(health)) return asSibling.replace(/^https?:\/\/[^/]+/i, '')
        if (health.startsWith('/')) return asSibling
        return DEFAULT_BACKUP_LIMIT_URL
      }

      /**
       * The two READ-ONLY sources the failure panel merges (2026-11-01):
       * what the loaded plugins stopped providing, and how each plugin compares
       * with the newest backup. Both are plain GET routes.
       */
      function pluginWatchUrlFor(info) {
        const sent = info && typeof info.pluginWatchUrl === 'string' ? info.pluginWatchUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return '/__dsh_autorestart/plugin-watch'
      }

      function pluginInventoryUrlFor(info) {
        const sent = info && typeof info.pluginInventoryUrl === 'string' ? info.pluginInventoryUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return '/__dsh_autorestart/plugin-inventory'
      }

      /**
       * Whether the one-time install prompt may be shown.
       *
       * It may be shown only while the browser has no record of a choice yet,
       * i.e. while `localStorage['dsh-autorestart:backup-choice-v1']` is
       * missing. A browser without a usable localStorage answers "no": the
       * prompt must not come back on every reload there.
       */
      function backupChoicePending() {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return false
          return window.localStorage.getItem(BACKUP_CHOICE_KEY) === null
        } catch {
          return false
        }
      }

      /**
       * Record the one-time choice in the browser.
       *
       * The key is written as soon as the user picks an option (or closes the
       * prompt), so the question is asked exactly once.
       */
      function writeBackupChoice(value) {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return false
          window.localStorage.setItem(BACKUP_CHOICE_KEY, String(value))
          return true
        } catch {
          return false
        }
      }

      /** A short, human readable description of a failed request. */
      function describeError(error) {
        if (!error) return 'unknown error'
        if (typeof error === 'string') return error
        if (typeof error.message === 'string' && error.message !== '') return error.message
        return String(error)
      }

      // The pill sits in the composer tool row, so it must fit the toolbar
      // height (~22px) and never push that row around: `flex: 'none'` plus a
      // fixed height, and the text is clipped with an ellipsis instead of
      // wrapping. No absolute/fixed positioning, no negative margins. The
      // border stays neutral; only the dot carries the brand accent.
      const PILL_STYLE = {
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        gap: 6,
        height: 22,
        boxSizing: 'border-box',
        maxWidth: '100%',
        padding: '0 8px',
        borderRadius: 999,
        fontSize: 12,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
        cursor: 'pointer',
      }

      // The wrapper is the pill's anchor: it is the only element that may
      // position absolutely (the details panel), so it stays `relative` while
      // the pill itself keeps its inline layout.
      const WRAPPER_STYLE = {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        maxWidth: '100%',
      }

      const DOT_STYLE = {
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        flexShrink: 0,
        background: BRAND,
      }

      // The 8px brand dot that occupies the leading 16px state cell of a
      // sidebar session row. `margin: 0 auto` centers it in that cell; it is
      // icon-only, so the full text lives in the `title` tooltip.
      const SIDEBAR_DOT_STYLE = {
        display: 'block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: BRAND,
        margin: '0 auto',
        flex: 'none',
        boxSizing: 'border-box',
      }

      // The label + status text is one clipped line inside the pill.
      const TEXT_STYLE = {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }

      // The extra line of a LONG wait: how long the restart has been waiting and
      // who holds it. It is a separate element (not more text in the same span)
      // so the bubble can tell "the ordinary status" from "the long wait", and
      // it stays inside the clipped pill — the composer row never grows.
      const LONG_WAIT_STYLE = {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        opacity: 0.85,
      }

      // HOW LONG THE "已回来" CARD STAYS after the new host is up (ms).
      const RESTART_OVERLAY_BACK_MS = 1500
      // The id of the injected stylesheet, so a second mount never duplicates it.
      const RESTART_OVERLAY_STYLE_ID = 'dsh-autorestart-restart-overlay'

      // THE CENTRED OVERLAY of a running restart.
      //
      // WHY IT EXISTS (user report, 2026-10-29): the stage line lived in the
      // composer row, a single clipped line inside a 22px toolbar — on a narrow
      // window "正在等待所有会话空闲…（还有 1 个会话在忙）" was cut off, and an
      // ellipsis ate exactly the part that mattered. The detail therefore moved
      // OUT of the composer row onto the middle of the interface: a fixed 320px
      // card, one short line per stage, a real progress bar for the backup.
      //
      // TWO RULES:
      //   1. IT NEVER COVERS THE INPUT. `pointer-events: none` and a translation
      //      only — every click goes through to the interface below, and the
      //      card sits in the middle of the conversation, not over the composer;
      //   2. NO TEXT IS EVER CUT. The card keeps its line unwrapped, has no
      //      `text-overflow` at all, and shrinks its font on a narrow window
      //      (`clamp`), so the number of the backup is never replaced by "…".
      const RESTART_OVERLAY_CSS = [
        '.dsh-autorestart-restart-overlay{',
        '  position:fixed;',
        '  top:44%;',
        '  left:50%;',
        '  transform:translate(-50%,-50%);',
        '  z-index:9997;',
        '  box-sizing:border-box;',
        '  width:min(320px,calc(100vw - 32px));',
        '  padding:14px 16px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:14px;',
        '  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent);',
        '  box-shadow:0 10px 30px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 20%, transparent);',
        '  color:var(--dsw-alias-label-primary);',
        '  text-align:center;',
        '  pointer-events:none;',
        '}',
        '.dsh-autorestart-restart-overlay__title{',
        '  margin:0;',
        '  font-size:clamp(11px,2.6vw,14px);',
        '  font-weight:600;',
        '  line-height:1.4;',
        '  white-space:nowrap;',
        '  overflow:visible;',
        '}',
        '.dsh-autorestart-restart-overlay__detail{',
        '  margin:4px 0 0;',
        '  font-size:clamp(10px,2.2vw,12.5px);',
        '  line-height:1.5;',
        '  color:var(--dsw-alias-label-secondary);',
        '  white-space:nowrap;',
        '  overflow:visible;',
        '}',
        '.dsh-autorestart-restart-overlay__bar{',
        '  margin:9px 0 0;',
        '  height:6px;',
        '  border-radius:999px;',
        '  background:color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);',
        '  overflow:hidden;',
        '}',
        '.dsh-autorestart-restart-overlay__bar-fill{',
        '  height:100%;',
        '  border-radius:999px;',
        '  background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#5b8def));',
        '  transition:width .3s ease-out;',
        '}',
        '.dsh-autorestart-restart-overlay__size{',
        '  display:flex;',
        '  align-items:baseline;',
        '  justify-content:space-between;',
        '  gap:8px;',
        '  margin:6px 0 0;',
        '  font-size:clamp(10px,2.2vw,12px);',
        '  line-height:1.5;',
        '  color:var(--dsw-alias-label-secondary);',
        '  white-space:nowrap;',
        '}',
      ].join('\n')

      // The details panel: anchored to the wrapper, above the pill, left
      // aligned. It uses the host theme tokens (background / border / label
      // color) so it follows the app theme.
      const PANEL_STYLE = {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        zIndex: 30,
        minWidth: 260,
        maxWidth: 320,
        marginBottom: 6,
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: '18px',
        textAlign: 'left',
        whiteSpace: 'normal',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #fff))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
        boxShadow: '0 6px 16px rgba(0, 0, 0, 0.16)',
        cursor: 'default',
      }

      const PANEL_HEADING_STYLE = {
        fontWeight: 600,
        marginBottom: 4,
      }

      const PANEL_LINE_STYLE = {
        margin: '1px 0',
      }

      const PANEL_MUTED_STYLE = {
        margin: '4px 0 0',
        opacity: 0.75,
      }

      // The confirmation box INSIDE the panel: it is the second step of the
      // manual cancel (the button opens it, only the confirmation cancels).
      // It has NO timeout: it stays until the user decides.
      const CONFIRM_STYLE = {
        marginTop: 8,
        paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
      }

      // The buttons of the panel: they look like the pill's own buttons, only
      // smaller, and they are real buttons (focusable, Enter/Space work).
      const PANEL_BUTTON_STYLE = {
        marginTop: 8,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '16px',
        cursor: 'pointer',
      }

      // The same button, greyed out: used while the host is already restarting,
      // when a cancel can no longer be honoured.
      const PANEL_BUTTON_DISABLED_STYLE = {
        ...PANEL_BUTTON_STYLE,
        cursor: 'not-allowed',
        opacity: 0.55,
      }

      const PARK_BUTTON_STYLE = {
        ...PILL_STYLE,
        height: 18,
        padding: '0 6px',
        fontSize: 11,
        lineHeight: '16px',
        gap: 4,
      }

      // The park button while its request is in flight.
      const PARK_BUTTON_BUSY_STYLE = {
        ...PARK_BUTTON_STYLE,
        cursor: 'default',
        opacity: 0.6,
      }

      // The short "N goals parked" line inside the pill.
      const PARKED_LINE_STYLE = {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        opacity: 0.75,
      }

      // The inline error line of the details panel.
      const PANEL_ERROR_STYLE = {
        margin: '2px 0',
        fontWeight: 600,
        color: 'var(--dsw-alias-danger, #d14343)',
      }

      // The one-time install prompt. It is NOT a modal: it is an ordinary block
      // in the composer dock, so the input box stays usable and nothing is
      // blocked. It never disappears on its own.
      //
      // The look follows the established DSH plugin styling: one 14px/600
      // heading, a muted subtitle, two selectable rows (a name + a note on the
      // left, the action on the right) and a muted footnote. The primary option
      // carries a "recommended" pill and a solid button; the secondary one is
      // outlined. Only theme tokens are used, so light and dark themes both
      // work.
      const CHOICE_STYLE_ID = 'dsh-autorestart-choice'
      const CHOICE_CSS = [
        '.dsh-autorestart-choice{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:8px;',
        '  width:min(560px,94vw);',
        '  max-width:100%;',
        '  box-sizing:border-box;',
        '  margin:0 0 6px;',
        '  padding:16px 18px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:12px;',
        '  background:var(--dsw-alias-bg-layer-1);',
        '  box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 20%, transparent);',
        '  color:var(--dsw-alias-label-secondary);',
        '  font-size:13px;',
        '  line-height:18px;',
        '}',
        '.dsh-autorestart-choice h3{',
        '  margin:0;',
        '  font-size:14px;',
        '  font-weight:600;',
        '  line-height:20px;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-choice p{margin:0;}',
        '.dsh-autorestart-choice__head{',
        '  display:flex;',
        '  align-items:flex-start;',
        '  justify-content:space-between;',
        '  gap:10px;',
        '}',
        '.dsh-autorestart-choice__subtitle{',
        '  font-size:12.5px;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-autorestart-choice__options{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:10px;',
        '}',
        '.dsh-autorestart-choice__row{',
        '  display:flex;',
        '  align-items:center;',
        '  justify-content:space-between;',
        '  gap:10px;',
        '  padding:10px 12px;',
        '  border:1px solid transparent;',
        '  border-radius:10px;',
        '  cursor:pointer;',
        '  transition:background-color .14s,border-color .14s;',
        '}',
        '.dsh-autorestart-choice__row:hover,',
        '.dsh-autorestart-choice__row:focus-within{',
        '  border-color:var(--dsw-alias-border-l1);',
        '  background:var(--dsw-alias-bg-layer-2, color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent));',
        '}',
        '.dsh-autorestart-choice__row:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
        '.dsh-autorestart-choice__text{flex:1 1 auto;min-width:0;}',
        '.dsh-autorestart-choice__title{',
        '  display:flex;',
        '  align-items:center;',
        '  gap:6px;',
        '  min-width:0;',
        '}',
        '.dsh-autorestart-choice__name{',
        '  font-size:13px;',
        '  font-weight:600;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-choice__hint{',
        '  display:block;',
        '  margin-top:2px;',
        '  font-size:12px;',
        '  line-height:17px;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-autorestart-choice__badge{',
        '  flex:none;',
        '  display:inline-block;',
        '  padding:1px 7px;',
        '  border-radius:999px;',
        '  font-size:11px;',
        '  font-weight:600;',
        '  line-height:16px;',
        '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  background:color-mix(in srgb, var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 12%, transparent);',
        '}',
        '.dsh-autorestart-choice__cta{',
        '  flex:none;',
        '  min-width:28px;',
        '  min-height:28px;',
        '  padding:4px 12px;',
        '  border-radius:8px;',
        '  font:inherit;',
        '  font-size:12.5px;',
        '  font-weight:600;',
        '  line-height:18px;',
        '  cursor:pointer;',
        '  transition:background-color .14s,border-color .14s,color .14s;',
        '}',
        '.dsh-autorestart-choice__cta:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
        '.dsh-autorestart-choice__cta--primary{',
        '  border:1px solid transparent;',
        '  background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  color:var(--dsw-alias-bg-layer-1,#fff);',
        '}',
        '.dsh-autorestart-choice__cta--secondary{',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  background:transparent;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-choice__cta--secondary:hover{',
        '  border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '}',
        '.dsh-autorestart-choice__close{',
        '  flex:none;',
        '  width:28px;',
        '  height:28px;',
        '  padding:0;',
        '  border:1px solid transparent;',
        '  border-radius:8px;',
        '  background:transparent;',
        '  color:var(--dsw-alias-label-secondary);',
        '  font:inherit;',
        '  font-size:16px;',
        '  line-height:1;',
        '  cursor:pointer;',
        '  transition:background-color .14s;',
        '}',
        '.dsh-autorestart-choice__close:hover{',
        '  background:var(--dsw-alias-bg-layer-2, color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
        '}',
        '.dsh-autorestart-choice__close:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
        '.dsh-autorestart-choice__footnote{',
        '  margin-top:10px;',
        '  padding-top:10px;',
        '  border-top:1px solid var(--dsw-alias-border-l1);',
        '  font-size:11px;',
        '  line-height:16px;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-autorestart-choice__diagram{margin:2px 0 10px;}',
        '.dsh-autorestart-choice__diagram__art{',
        '  width:100%;',
        '  max-width:260px;',
        '  height:auto;',
        '  display:block;',
        '}',
        '@media (max-width:1023px){',
        '  .dsh-autorestart-choice{width:calc(100vw - 32px);}',
        '}',
        '@media (max-width:640px){',
        '  .dsh-autorestart-choice__row{flex-direction:column;align-items:stretch;}',
        '  .dsh-autorestart-choice__cta{width:100%;}',
        '}',
      ].join('\n')

      /**
       * One compact pill in the composer tool row, visible only while THIS
       * session is waiting for a pending restart. Clicking it (or pressing
       * Enter / Space) opens the details panel. Single root element.
       */
      function RestartPill(props) {
        const sessionId = props && props.sessionId !== undefined ? props.sessionId : null
        const hasSession = sessionId !== null && sessionId !== ''
        const info = useSharedInfo(hasSession)
        // The session id of the goal that is currently being parked, or null.
        const [parking, setParking] = useState(null)
        // The message of the last failed park request (the Host's own message).
        // It is shown in the pill's tooltip: the pill has no details panel.
        const [parkError, setParkError] = useState('')
        // The manual cancel: the panel, the confirmation and its outcome.
        const [panelOpen, setPanelOpen] = useState(false)
        const [confirmOpen, setConfirmOpen] = useState(false)
        const [cancelling, setCancelling] = useState(false)
        const [cancelError, setCancelError] = useState('')
        // How many OTHER sessions still wait for the restart, as the Host
        // reported it after the cancellation (null = use the polled value).
        const [sessionsLeft, setSessionsLeft] = useState(null)
        // True after this session withdrew its own request: the capsule stays
        // until the restart is really over.
        const [withdrawn, setWithdrawn] = useState(false)
        // True when the restart this session was waiting for is GONE (nobody
        // waits for it any more): the capsule has nothing left to say.
        const [gone, setGone] = useState(false)
        const t = makeTranslate(translate)

        const pending = Boolean(info && info.pendingRestart === true)
        // The restart is imminent: the Host's idle gate is open, so the restart
        // happens as soon as this poll cycle ends.
        const pulsing = pending && Boolean(info.allowRestart === true) && !prefersReducedMotion()

        // A park error never outlives the pending state.
        useEffect(() => {
          if (!pending) {
            setParkError('')
            setParking(null)
          }
        }, [pending])

        // The panel and the confirmation never outlive the pending state.
        useEffect(() => {
          if (!pending) {
            setPanelOpen(false)
            setConfirmOpen(false)
            setCancelError('')
            setSessionsLeft(null)
            setWithdrawn(false)
            setGone(false)
          }
        }, [pending])

        // A click OUTSIDE the panel closes it (Esc does the same inside the
        // capsule). The listener only exists while the panel is open.
        useEffect(() => {
          if (!panelOpen) return undefined
          const onOutside = () => {
            setPanelOpen(false)
            setConfirmOpen(false)
          }
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          document.addEventListener('click', onOutside)
          return () => {
            if (typeof document.removeEventListener === 'function') {
              document.removeEventListener('click', onOutside)
            }
          }
        }, [panelOpen])

        if (!info || info.pendingRestart !== true) return null
        // The restart this session waited for is gone (nobody waits for it any
        // more): the capsule has nothing left to say.
        if (gone) return null

        const waiters = Array.isArray(info.waiters) ? info.waiters : []
        const key = String(sessionId)
        const waiting = waiters.some((waiter) => String(waiter) === key)
        // After this session withdrew its own request it is no longer a waiter,
        // but the restart may still be pending for the others: the capsule stays
        // until the restart is really over.
        if (!waiting && !withdrawn) return null

        const blockedBy = Array.isArray(info.blockedBy) ? info.blockedBy : []
        // WHICH STAGE THE RESTART IS IN (waiting / backing up / restarting) and
        // whether a cancel is still honest. Both come from the Host: the pill
        // never guesses the stage and never invents progress.
        const stage = info && info.restartPhase && typeof info.restartPhase === 'object' ? info.restartPhase : null
        // THE COPY OF THE COMPOSER ROW: ONE short line, never a sentence.
        //   waiting (or no stage at all): the pill keeps its own composed line —
        //     "待重启 · 空闲后自动重启" / "待重启 · 等待 N 个…"
        //     (the noun of that count belongs to the capsule's own copy);
        //   snapshotting / restarting / back: the stage REPLACES that line —
        //     "重启前备份中" / "正在重启…" / "已回来", and nothing else.
        // The sentence that used to sit here ("正在等待所有会话空闲…（还有 1 个
        // 会话在忙）") was clipped away by the composer row (user report,
        // 2026-10-29). The detail — the count of busy conversations, the
        // megabytes, the progress bar — is the CENTRED OVERLAY.
        const pillStageText = restartPillStageText(stage, t)
        const cancelLocked = restartStageLocked(stage)
        // The TASK of every blocker: a session and its own subagents are ONE
        // task (the sidebar counts them once). The keys are aligned with the
        // list, so the filter below can ask "is this MY task?".
        const taskKeys = blockerTaskKeys(blockedBy)
        const ownTaskKey = TASK_KEY_SESSION + key
        // The own session blocks itself — but only when it is a top-level
        // session. A subagent mounted capsule belongs to its parent's task, and
        // the parent's other work still blocks the restart.
        const ownIsTask = !blockedBy.some((entry) => (
          entry && String(entry.sessionId) === key && blockerEntryKind(entry) === 'subagent'
        ))
        // One entry per SESSION: a conversation that is running *and* still has
        // queued work is one conversation, so the pill never counts it twice.
        const seenSessions = new Set()
        const others = blockedBy.filter((entry, index) => {
          if (!entry) return false
          const id = String(entry.sessionId)
          if (id === key || seenSessions.has(id)) return false
          seenSessions.add(id)
          // The own task is not a blocker of the own capsule.
          if (ownIsTask && taskKeys[index] === ownTaskKey) return false
          return true
        })
        // A goal-driven blocker: an armed goal that keeps driving rounds by
        // itself (`goal-active`, parkable) or a goal whose round budget is used
        // up (`goal-exhausted`, not parkable at all).
        const goalActive = others.filter((entry) => String(entry.reason) === 'goal-active')
        const goalExhausted = others.filter((entry) => String(entry.reason) === 'goal-exhausted')
        // The tasks that are NOT a goal: the count and the names of the waiting
        // sentence talk about the same set.
        const busyBlockers = others.filter(
          (entry) => String(entry.reason) !== 'goal-active' && String(entry.reason) !== 'goal-exhausted',
        )

        // WHY the gate is closed: the Host reports the reason next to the
        // blockers. With no blocker but the reason "settling" the restart is
        // waiting for the quiet window — not for a conversation.
        const gateReason = info && typeof info.reason === 'string' ? info.reason : ''

        // The long wait: the Host says that the restart is still waiting while a
        // conversation runs on. The capsule shows one
        // more line about it — how long it has been waiting and how many tasks
        // are running.
        const longWait = formatLongWaitNoteParts(info, t)
        // THE ONE NUMBER both surfaces show (user report, 2026-10-29: the
        // capsule said "还有 1 个会话在忙" while the panel it opens said
        // "这次重启还在等 0 个会话"). The Host counts the tasks that hold
        // the gate and publishes `busyCount`; the capsule AND its panel read
        // that very value, so the two can never disagree again. A blocker
        // WITHOUT a readable name is still counted.
        const longWaitBlockers = info && info.longWait && Array.isArray(info.longWait.blockedBy)
          ? info.longWait.blockedBy
          : []
        const countingBlockers = others.length > 0 || !longWait.hasLongWait ? others : longWaitBlockers
        const waitingCount = waitingTaskCount(info, countingBlockers)
        const otherBusy = waitingCount
        // The blockers of the ordinary list: the SAME rule as the long wait
        // (grouped by the session that created them).
        const blockers = summarizeBlockers(busyBlockers, { t })

        // The capsule is ONE clipped line of 22px: it holds a NUMBER and a
        // duration, never a NAME. Every name goes into the tooltip, where
        // there is room for all of them.
        //
        // A long wait says it ONCE: its own line carries the duration and the
        // count, so the ordinary "waiting for N tasks" sentence is left out —
        // it would say the same thing twice and take twice the width.
        const status = longWait.hasLongWait
          ? ''
          : goalActive.length > 0
            ? t('goalActive')
            : goalExhausted.length > 0
              ? t('goalExhausted')
              : otherBusy > 0
                ? `${t('busyPrefix')}${otherBusy}${t('busySuffix')}`
                : (gateReason === 'settling' ? t('settling') : t('idle'))

        const tooltipText = otherBusy > 0 ? t('tooltipBusy') : t('tooltip')
        // The tooltip carries the COMPLETE list of the blockers: the capsule
        // shows numbers only, the tooltip every name.
        const detail = longWait.hasLongWait
          ? longWait.full
          : (blockers.total === 0 ? '' : fill(t('blockersTitleLine'), { blockers: blockers.full }))
        const titleText = parkError
          ? fill(t('tooltipWithError'), { message: parkError })
          : (detail === '' ? tooltipText : `${tooltipText} ${detail}`)

        // The panel: how many tasks the restart waits for, and how many OTHER
        // sessions wait for the same restart. The count is about TASKS (a
        // session and its own subagents are one), like everywhere else.
        // The SAME variable the capsule used: the panel can never claim a
        // different count than the line it was opened from.
        const taskCount = waitingCount
        const otherWaiters = waiters.filter((waiter) => String(waiter) !== key).length
        const sessionsWaiting = sessionsLeft === null ? otherWaiters : sessionsLeft
        // The session that asks for the cancel: without it the own request
        // cannot be identified, so nothing is sent.
        const ownSessionId = sessionId === null || sessionId === undefined ? '' : String(sessionId)

        if (pulsing) ensurePulseStyle()

        /**
         * Open the panel. A double click is only an ALIAS for it: it never
         * cancels anything.
         */
        const openPanel = (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          setPanelOpen(true)
          setCancelError('')
        }

        /** Close the panel (and the confirmation) without cancelling. */
        const closePanel = () => {
          setPanelOpen(false)
          setConfirmOpen(false)
        }

        /** The keyboard of the capsule: Enter/Space opens the panel, Esc closes it. */
        const onPillKeyDown = (event) => {
          if (!event) return
          const pressed = event.key
          if (pressed === 'Enter' || pressed === ' ' || pressed === 'Spacebar') {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            openPanel(event)
            return
          }
          if (pressed === 'Escape') {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            closePanel()
          }
        }

        /**
         * Withdraw THIS session's own restart request.
         *
         * The Host answers what happened: whether the restart is gone, how many
         * sessions still wait for it, and — when it did not work — WHY.
         */
        const cancelOwnRestartRequest = async () => {
          if (ownSessionId === '') {
            setCancelError(t('cancelUnknownSession'))
            return
          }
          const url = cancelUrlFor(info)
          if (url === '') {
            setCancelError(t('cancelNoRoute'))
            return
          }
          setCancelling(true)
          setCancelError('')
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: ownSessionId, scope: 'mine' }),
            })
            let body = null
            try {
              body = await response.json()
            } catch {
              body = null
            }
            if (!response.ok || !body || body.ok !== true) {
              // It did not work: the confirmation closes and the panel says
              // WHY (a silent failure would leave the user guessing).
              setConfirmOpen(false)
              setCancelError(cancelFailureText(body, t))
              return
            }
            setConfirmOpen(false)
            setWithdrawn(true)
            if (typeof body.remainingRequesters === 'number') setSessionsLeft(body.remainingRequesters)
            // The restart is gone: the capsule has nothing left to say.
            if (body.cancelled === true) {
              setGone(true)
              setPanelOpen(false)
            }
          } catch (error) {
            setCancelError(fill(t('cancelFailedWith'), { message: describeError(error) }))
          } finally {
            setCancelling(false)
          }
        }

        /** The body of the confirmation: what cancelling means, right now. */
        const confirmBody = ownSessionId === ''
          ? t('cancelConfirmUnknown')
          : sessionsWaiting > 0
            ? fill(t('cancelConfirmOthers'), { n: sessionsWaiting })
            : t('cancelConfirmOnlyMe')

        /**
         * Park the goal of one blocking session and ask for the restart now.
         *
         * The Host parks that goal (so the session stops driving rounds) and
         * makes this session a requester of the pending restart. The shared
         * poll picks the new state up on its next tick.
         *
         * Never throws: a refused request (403) or a conflict (409) shows the
         * Host's own message as an inline error line instead.
         */
        const parkAndRestart = async (targetSessionId) => {
          if (parking) return
          setParking(targetSessionId)
          setParkError('')
          try {
            const response = await fetch(parkUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: targetSessionId, restart: true }),
            })
            let body = null
            try {
              body = await response.json()
            } catch {
              body = null
            }
            if (!response.ok) {
              const message = body && typeof body === 'object'
                ? (body.error || body.message || '')
                : ''
              setParkError(fill(t('parkError'), { message: message || String(response.status) }))
              return
            }
            if (body && Array.isArray(body.reported)) {
              const reported = body.reported.find(
                (entry) => entry && String(entry.sessionId) === String(targetSessionId),
              )
              if (reported) {
                setParkError(fill(t('parkError'), { message: String(reported.reason || 'not-parked') }))
              }
            }
          } catch (error) {
            setParkError(fill(t('parkError'), { message: describeError(error) }))
          } finally {
            setParking(null)
          }
        }

        /**
         * The panel of the capsule: the status of the pending restart and the
         * manual way out of it. It FLOATS above the capsule (the wrapper is
         * the positioning anchor), so the composer row never grows.
         */
        const panel = panelOpen
          ? h(
            'div',
            {
              className: 'dsh-autorestart-pill-panel',
              'data-dsh-autorestart-panel': 'true',
              role: 'dialog',
              'aria-label': t('cancelPanelAria'),
              style: PANEL_STYLE,
              // A click inside the panel is not a click outside it.
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              },
            },
            // THE SAME number the capsule shows (one variable, one number).
            // A restart that waits for nobody says so in words — "还在等 0 个
            // 会话" is not a sentence anybody writes.
            h(
              'p',
              { style: { margin: 0 } },
              taskCount > 0 ? fill(t('cancelPanelTasks'), { n: taskCount }) : t('panelStateIdle'),
            ),
            sessionsWaiting > 0
              ? h(
                'p',
                { style: { margin: '4px 0 0' } },
                fill(sessionsLeft === null ? t('cancelPanelOthers') : t('cancelPanelOthersAfter'), { n: sessionsWaiting }),
              )
              : null,
            ownSessionId === ''
              ? h('p', { style: { margin: '4px 0 0' } }, t('cancelUnknownSession'))
              : null,
            cancelError !== ''
              ? h(
                'p',
                { style: { margin: '4px 0 0', color: 'var(--dsw-alias-state-error, #d33)' } },
                cancelError,
              )
              : null,
            confirmOpen
              ? h(
                'div',
                {
                  className: 'dsh-autorestart-pill-confirm',
                  'data-dsh-autorestart-confirm': 'true',
                  role: 'dialog',
                  'aria-label': t('cancelConfirmTitle'),
                  style: CONFIRM_STYLE,
                },
                h('p', { style: { margin: 0, fontWeight: 600 } }, t('cancelConfirmTitle')),
                h('p', { style: { margin: '4px 0 0' } }, confirmBody),
                ownSessionId === ''
                  ? null
                  : h(
                    'div',
                    { style: { display: 'flex', gap: 8, marginTop: 8 } },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: PANEL_BUTTON_STYLE,
                        title: t('cancelConfirmButtonAria'),
                        'aria-label': t('cancelConfirmButtonAria'),
                        disabled: cancelling,
                        onClick: (event) => {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          void cancelOwnRestartRequest()
                        },
                      },
                      t('cancelConfirmButton'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: PANEL_BUTTON_STYLE,
                        title: t('cancelDismissButtonAria'),
                        'aria-label': t('cancelDismissButtonAria'),
                        onClick: (event) => {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          setConfirmOpen(false)
                        },
                      },
                      t('cancelDismissButton'),
                    ),
                  ),
              )
              : h(
                'button',
                {
                  type: 'button',
                  style: cancelLocked ? PANEL_BUTTON_DISABLED_STYLE : PANEL_BUTTON_STYLE,
                  // A cancel once the host is restarting would be a promise the
                  // plugin cannot keep: the button is greyed out and the reason
                  // is in its tooltip.
                  title: cancelLocked
                    ? t('cancelLocked') + (stage && stage.cancelReason ? ' · ' + stage.cancelReason : '')
                    : t('cancelButtonAria'),
                  'aria-label': cancelLocked ? t('cancelLocked') : t('cancelButtonAria'),
                  'aria-disabled': cancelLocked ? 'true' : 'false',
                  disabled: cancelling || cancelLocked,
                  onClick: (event) => {
                    if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                    setConfirmOpen(true)
                  },
                },
                cancelLocked ? t('cancelLocked') : t('cancelButton'),
              ),
          )
          : null

        return h(
          'div',
          {
            style: WRAPPER_STYLE,
            role: 'status',
            'aria-live': 'polite',
          },
          h(
            'div',
            {
              style: PILL_STYLE,
              title: titleText,
              // The capsule opens the panel. A DOUBLE click is only an alias
              // for it — it never cancels anything.
              role: 'button',
              tabIndex: 0,
              'aria-haspopup': 'dialog',
              'aria-expanded': panelOpen,
              onClick: openPanel,
              onDoubleClick: openPanel,
              onKeyDown: onPillKeyDown,
            },
            h('span', { style: dotStyle(DOT_STYLE, pulsing), 'aria-hidden': 'true' }),
            // THE ONE VISIBLE LINE OF THE COMPOSER ROW — short, never a
            // sentence:
            //   waiting (or no stage at all): the composed line of the pill —
            //     "待重启 · 空闲后自动重启" / "待重启 · 等待 N 个…";
            //   snapshotting / restarting / back: the stage REPLACES it —
            //     "重启前备份中" / "正在重启…" / "已回来".
            // The long sentence that used to live here was clipped away by the
            // composer row (user report, 2026-10-29): the detail is the CENTRED
            // OVERLAY, and the pill is one clipped line again.
            h(
              'span',
              {
                style: TEXT_STYLE,
                'data-dsh-autorestart-copy': 'true',
                'data-dsh-autorestart-stage': String(stage && stage.phase ? stage.phase : ''),
              },
              pillStageText === ''
                ? h('b', { key: 'label' }, t('label'))
                : h('b', { key: 'stage' }, pillStageText),
              pillStageText === '' ? status : null,
            ),
            // One more line for the long wait: how long the restart has been
            // waiting and how many tasks are running. It is only there when the
            // Host says so. The line carries NO name at all — it is one
            // clipped line — and its own tooltip carries the COMPLETE list.
            longWait.pill === ''
              ? null
              : h(
                'span',
                {
                  style: LONG_WAIT_STYLE,
                  'data-dsh-autorestart-long-wait': 'true',
                  title: longWait.full,
                },
                longWait.pill,
              ),
            // One park button per goal-driven blocker that can be parked. It
            // lives inside the pill, so the slot still has a single root.
            goalActive.map((entry, index) => {
              const target = String(entry.sessionId)
              const busy = parking === target
              const onParkClick = (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                void parkAndRestart(target)
              }
              const onParkKeyDown = (event) => {
                if (!event) return
                const pressed = event.key
                if (pressed === 'Enter' || pressed === ' ' || pressed === 'Spacebar') {
                  if (typeof event.stopPropagation === 'function') event.stopPropagation()
                }
              }
              return h(
                'button',
                {
                  key: 'park-' + index,
                  type: 'button',
                  style: busy ? PARK_BUTTON_BUSY_STYLE : PARK_BUTTON_STYLE,
                  title: t('parkButtonAria'),
                  'aria-label': t('parkButtonAria'),
                  disabled: parking !== null,
                  onClick: onParkClick,
                  onKeyDown: onParkKeyDown,
                },
                busy ? t('parkBusy') : t('parkButton'),
              )
            }),
          ),
          panel,
        )
      }

      /**
       * The brand dot in the leading 16px state cell of a left-sidebar session
       * row, visible only while THAT session is waiting for a pending restart.
       * Icon-only: the full explanation is the `title` tooltip. Single root
       * element.
       */
      function RestartDot(props) {
        const sessionId = props && props.sessionId !== undefined ? props.sessionId : null
        const hasSession = sessionId !== null && sessionId !== ''
        const info = useSharedInfo(hasSession)

        if (!info || info.pendingRestart !== true) return null

        const waiters = Array.isArray(info.waiters) ? info.waiters : []
        const key = String(sessionId)
        const waiting = waiters.some((waiter) => String(waiter) === key)
        if (!waiting) return null

        const t = makeTranslate(translate)
        const pulsing = info.allowRestart === true && !prefersReducedMotion()
        if (pulsing) ensurePulseStyle()

        // The long wait is worth a word in the tooltip too: the dot is
        // icon-only, so the text is the only place where it can be read.
        // The tooltip carries the COMPLETE list of the blockers.
        const longWait = formatLongWaitNoteParts(info, t)

        return h('span', {
          style: dotStyle(SIDEBAR_DOT_STYLE, pulsing),
          title: longWait.hasLongWait ? `${t('tooltip')} ${longWait.full}` : t('tooltip'),
          role: 'status',
          'aria-live': 'polite',
          'aria-label': t('dotAria'),
        })
      }

      /**
       * Inject the overlay stylesheet exactly once. The id keeps a second
       * injection from duplicating the rule.
       */
      function ensureRestartOverlayStyle() {
        if (typeof document === 'undefined' || !document.head) return
        try {
          if (document.getElementById(RESTART_OVERLAY_STYLE_ID)) return
          const style = document.createElement('style')
          style.id = RESTART_OVERLAY_STYLE_ID
          style.textContent = RESTART_OVERLAY_CSS
          document.head.appendChild(style)
        } catch {
          // Without the stylesheet the card is still readable, just plainer.
        }
      }

      /**
       * THE CENTRED OVERLAY OF A RESTART — the stage, on the interface itself.
       *
       * WHY (first report): the stage lived in the composer row, one clipped line
       * inside a 22px toolbar, where the sentence was cut off by an ellipsis. The
       * detail therefore moved onto the middle of the conversation.
       *
       * WHAT IS DRAWN, AND WHEN — the card follows the Host EXACTLY, with no time
       * floor of its own (the owner's decision, 2026-10-29: "浮层不用保底时间,
       * 短就算了,不用硬加长"): a 92 KB backup is copied in ~5 ms and the card is
       * gone just as fast; a slow backup keeps it on screen for as long as it
       * takes. Nothing here invents a duration.
       *   snapshotting  "DSH 重启前备份中" + the real bar + "12.3 MB / 40 MB" + %
       *   restarting    "正在重启…" (the host is on its way out)
       *   back          "已回来", for 1.5s, and only for a restart THIS page saw
       *   waiting/idle  NOTHING: the gate merely waits, nothing is in progress
       *
       * A running stage counts only while the restart is really PENDING
       * (pendingRestart): the stage a previous restart left in the state file is
       * not an action, and a card for it would be a lie.
       *
       * IT LIVES ON THIS PAGE ONLY (no localStorage, no global marker), it never
       * covers the input (pointer-events: none), and it never cuts a word.
       */
      function RestartOverlay() {
        const info = useSharedInfo(true)
        const t = makeTranslate(translate)
        // The stage said goodbye: the card folds away once, and only once.
        const [backGone, setBackGone] = useState(false)
        // DID THIS PAGE WATCH A RESTART IN PROGRESS? A page opened afterwards
        // reads a LEFTOVER stage from the state file and must draw nothing.
        const [sawRunning, setSawRunning] = useState(false)

        const stage = info && info.restartPhase && typeof info.restartPhase === 'object' ? info.restartPhase : null
        const phase = stage && typeof stage.phase === 'string' ? stage.phase : ''
        // A RESTART THAT IS REALLY PENDING: the request says "something is going
        // on right now", the state file alone does not.
        const pending = Boolean(info && info.pendingRestart === true)
        // THE ONLY TWO STAGES THAT ARE "SOMETHING IS REALLY HAPPENING": the
        // snapshot is being written, or the host is on its way out — AND the
        // stage must still be fresh. A stage nobody refreshed (the restart was
        // postponed and the Host did not say so) cannot leave a card on screen
        // for ever; the pill still says the restart is pending.
        const running = pending && isRestartStageLive(stage, Date.now())

        useEffect(() => {
          if (running) setSawRunning(true)
        }, [running])

        // THE POSTPONED CARD IS AN ANNOUNCEMENT, NOT A PROGRESS BAR (user report,
        // 2026-10-30): "after the interruption I still have a lot of work to do — a
        // card hovering for ever is in the way". It says what happened for four
        // seconds and then folds away; the capsule keeps saying the restart is
        // pending. A NEW postponement (a new stage timestamp) announces itself
        // again. Hooks live up here, with the others, because they must run on
        // every render — including the renders that draw nothing.
        const deferredKey = pending && isRestartStageDeferred(stage)
          ? (Number.isFinite(Number(stage.at)) ? Number(stage.at) : 0)
          : null
        const [announcedKey, setAnnouncedKey] = useState(null)
        const [folded, setFolded] = useState(false)

        useEffect(() => {
          if (deferredKey === null) {
            if (announcedKey !== null) {
              setAnnouncedKey(null)
              setFolded(false)
            }
            return undefined
          }
          if (announcedKey === deferredKey) return undefined
          setAnnouncedKey(deferredKey)
          setFolded(false)
          return undefined
        }, [deferredKey, announcedKey])

        // The four seconds of THIS announcement.
        useEffect(() => {
          if (announcedKey === null || folded) return undefined
          const timer = setTimeout(() => setFolded(true), RESTART_DEFERRED_CARD_MS)
          return () => clearTimeout(timer)
        }, [announcedKey, folded])

        // A POSTPONED RESTART IS NOT A RUNNING ONE (user report, 2026-10-30): when
        // the Host says the restart went back to waiting because a conversation
        // started, the card says exactly that. It is drawn AT ONCE (a fresh
        // postponement must not wait for a second render) and the hook above
        // records which postponement has been announced, so its four seconds can
        // run out; every new stage timestamp resets the clock.
        const postponed = deferredKey !== null && !folded

        // "已回来" is a MOMENT, not a state: 1.5s and then the card is gone.
        useEffect(() => {
          if (phase !== 'back') {
            setBackGone(false)
            return undefined
          }
          const timer = setTimeout(() => setBackGone(true), RESTART_OVERLAY_BACK_MS)
          return () => clearTimeout(timer)
        }, [phase])

        // THE CARD IS ONLY DRAWN WHILE SOMETHING IS REALLY IN PROGRESS — or while
        // the restart is honestly postponed.
        const visible = running || postponed || (phase === 'back' && sawRunning && !backGone)
        if (!visible) return null

        const progress = stage.progress && typeof stage.progress === 'object' ? stage.progress : null
        const bytes = progress !== null && Number.isFinite(Number(progress.bytes)) ? Number(progress.bytes) : null
        const total = progress !== null && Number.isFinite(Number(progress.total)) ? Number(progress.total) : null
        const percent = progress !== null && Number.isFinite(Number(progress.percent))
          ? Math.max(0, Math.min(100, Math.round(Number(progress.percent))))
          : null

        // The postponed card wins over everything else: even a stage that still
        // says 'restarting' in the same render is downgraded here, so the old word
        // can never survive a single frame once the Host said "deferred".
        const deferredCount = postponed ? waitingTaskCount(info, info && Array.isArray(info.blockedBy) ? info.blockedBy : []) : 0
        const title = postponed
          ? t('restart.overlay.deferred')
          : restartOverlayTitle(stage, t)

        let bar = null
        let detail = null
        if (postponed) {
          // A second, smaller line: what happens next, and how many conversations
          // are in the way (the same number the capsule shows).
          detail = h(
            'p',
            { className: 'dsh-autorestart-restart-overlay__size' },
            h(
              'span',
              { 'data-dsh-autorestart-restart-overlay-deferred': 'true' },
              deferredCount > 0
                ? fill(t('restart.overlay.deferredNote'), { count: deferredCount })
                : t('restart.overlay.deferredNoteZero'),
            ),
          )
        }
        if (!postponed && phase === 'snapshotting') {
          // The numbers are the ones the copy loop really measured; when there is
          // no measurement yet, the card shows no number at all (an invented
          // progress bar is worse than none). The unit fits the size, so a 92 KB
          // profile is "92 KB" and never "0 MB".
          const done = bytes === null ? '' : formatOverlaySize(bytes)
          const all = total === null ? '' : formatOverlaySize(total)
          const sizeText = done === ''
            ? ''
            : (all === '' ? fill(t('restart.overlay.sizeDone'), { done }) : fill(t('restart.overlay.size'), { done, total: all }))
          bar = h(
            'div',
            {
              className: 'dsh-autorestart-restart-overlay__bar',
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': percent === null ? 0 : percent,
            },
            h('div', {
              className: 'dsh-autorestart-restart-overlay__bar-fill',
              'data-dsh-autorestart-restart-overlay-bar': 'true',
              style: { width: (percent === null ? 0 : percent) + '%' },
            }),
          )
          detail = sizeText === ''
            ? null
            : h(
              'p',
              { className: 'dsh-autorestart-restart-overlay__size' },
              h('span', { 'data-dsh-autorestart-restart-overlay-size': 'true' }, sizeText),
              h('span', { 'data-dsh-autorestart-restart-overlay-percent': 'true' }, percent === null ? '' : percent + '%'),
            )
        }

        ensureRestartOverlayStyle()

        return h(
          'div',
          {
            className: 'dsh-autorestart-restart-overlay',
            role: 'status',
            'aria-live': 'polite',
            'data-dsh-autorestart-restart-overlay': 'true',
            'data-dsh-autorestart-restart-overlay-phase': phase,
            // WHAT THE CARD SAYS, independent of the Host phase: a postponed
            // restart is drawn from 'waiting'.
            'data-dsh-autorestart-restart-overlay-card': postponed ? 'deferred' : phase,
          },
          h(
            'p',
            { className: 'dsh-autorestart-restart-overlay__title', 'data-dsh-autorestart-restart-overlay-title': 'true' },
            title,
          ),
          bar,
          detail,
        )
      }

      /**
       * Inject the prompt styles exactly once. The id keeps a second injection
       * from duplicating the rule.
       */
      function ensureChoiceStyle() {
        if (typeof document === 'undefined' || !document.head) return
        try {
          if (document.getElementById(CHOICE_STYLE_ID)) return
          const style = document.createElement('style')
          style.id = CHOICE_STYLE_ID
          style.textContent = CHOICE_CSS
          document.head.appendChild(style)
        } catch {
          // Without the stylesheet the prompt is still readable, just plainer.
        }
      }

      /**
       * The one-time install prompt.
       *
       * It asks TWO questions, one after the other:
       *
       *   1. should the pre-restart backup also snapshot the installed plugin
       *      tree? (the first question — its behaviour is unchanged);
       *   2. should the graceful-shutdown button stay at the foot of the left
       *      sidebar?
       *
       * The first answer is persisted BEFORE the second question appears: the
       * two questions are never stacked on top of each other, and the second
       * one only shows up after the first one really reached the Host.
       *
       * "Backup" is the verb and BOTH options share the "configuration" base:
       * the plugins are an addition to the configuration, never a rival of it.
       *
       * It is deliberately NOT a modal: it is an ordinary block in the composer
       * dock (`role="status"`), so the input box stays usable, nothing is
       * blocked, and it never disappears on its own — it stays until the user
       * picks an option or closes it. It is keyboard reachable (focusable, Esc
       * closes it) and adapts to a narrow window.
       *
       * The answer goes to the Host, which writes it into the profile
       * configuration (the same key the settings page edits).
       */
      function BackupChoicePanel() {
        const info = useSharedInfo(true)
        // 'backup' is the first question, 'sleep' the second one, 'persisting'
        // the short moment in between (the first answer is on its way to the
        // Host) and 'done' when there is nothing left to ask.
        //
        // The two questions are judged SEPARATELY: an installation that already
        // answered the backup question still has to be asked about the shutdown
        // button (that is how the arrow sketch ever reaches a user who
        // installed the plugin before this question existed).
        const [step, setStep] = useState(
          backupChoicePending()
            ? 'backup'
            : (sleepChoicePending() ? 'sleep' : (supervisorChoicePending(info) ? 'supervisor' : 'done')),
        )
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const t = makeTranslate(translate)

        /**
         * Hand the FIRST answer to the Host.
         *
         * The browser records the choice FIRST (so the question is never asked
         * twice) and then posts it to the Host, which persists it in the
         * profile configuration. The SECOND question only appears once that
         * answer really left the browser.
         */
        const choose = (includePlugins) => {
          if (busy) return
          setBusy(true)
          setError('')
          writeBackupChoice(includePlugins ? 'plugins' : 'config-only')
          setStep('persisting')
          void (async () => {
            let failed = false
            try {
              const response = await fetch(choiceUrlFor(info), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(buildChoiceBody({ includePlugins })),
              })
              if (!response.ok) {
                failed = true
                setError(fill(t('backupChoiceError'), { message: String(response.status) }))
              }
            } catch (failure) {
              failed = true
              setError(fill(t('backupChoiceError'), { message: describeError(failure) }))
            } finally {
              setBusy(false)
              if (failed) {
                // The answer did not reach the Host: the first question stays
                // on screen with the reason, so it can be answered again.
                setStep('backup')
                return
              }
              // The first answer is persisted: the second question may follow.
              setStep(sleepChoicePending() ? 'sleep' : 'done')
            }
          })()
        }

        /**
         * Hand the THIRD answer to the Host: what should happen with the
         * self-starting supervisor?
         *
         * `choice` is 'install' (the card IS the confirmation: the user just
         * read what would change), 'external' (keep the way you start it) or
         * 'dismissed' (later).
         */
        const chooseSupervisor = (choice) => {
          if (busy) return
          setBusy(true)
          setError('')
          void (async () => {
            try {
              const response = await fetch(supervisorUrlFor(info), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  action: choice === 'install' ? 'install' : 'external',
                  confirmed: true,
                  choice: choice === 'install' ? 'install' : 'external',
                }),
              })
              const body = await response.json().catch(() => null)
              if (!response.ok) {
                const message = body && typeof body === 'object' ? (body.error || String(response.status)) : String(response.status)
                setError(fill(t('supervisor.error'), { message }))
                return
              }
            } catch (failure) {
              setError(fill(t('supervisor.error'), { message: describeError(failure) }))
              return
            } finally {
              setBusy(false)
            }
            setStep('done')
          })()
        }

        /**
         * Hand the SECOND answer to the Host: should the shutdown button stay?
         */
        const chooseSleep = (showSleepButton) => {
          if (busy) return
          setBusy(true)
          setError('')
          writeSleepChoice(showSleepButton ? 'keep' : 'hide')
          void (async () => {
            try {
              const response = await fetch(choiceUrlFor(info), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(buildChoiceBody({ showSleepButton })),
              })
              if (!response.ok) {
                setError(fill(t('sleep.choice.error'), { message: String(response.status) }))
                setStep('sleep')
                return
              }
            } catch (failure) {
              setError(fill(t('sleep.choice.error'), { message: describeError(failure) }))
              setStep('sleep')
              return
            } finally {
              setBusy(false)
            }
            // The shutdown button is settled: the supervisor question may follow.
            setStep(supervisorChoicePending(info) ? 'supervisor' : 'done')
          })()
        }

        /**
         * Close the FIRST question without answering: the default (the
         * configuration AND the installed plugins) stays in place, the question
         * is not asked again — and the second one is not asked either, because
         * closing the prompt means "do not ask me again".
         */
        const dismissBackup = () => {
          if (busy) return
          writeBackupChoice('dismissed')
          writeSleepChoice('dismissed')
          // "Do not ask me again" also covers the new-feature announcement: the
          // install prompt is where the features of a fresh installation are
          // explained, so no announcement may follow it.
          void acknowledgeAnnouncement(ANNOUNCED_FEATURE).catch(() => {})
          setStep('done')
        }

        /**
         * Close the SECOND question without answering: the button stays (the
         * default) and the question is not asked again.
         */
        const dismissSleep = () => {
          if (busy) return
          writeSleepChoice('dismissed')
          void acknowledgeAnnouncement(ANNOUNCED_FEATURE).catch(() => {})
          setStep('done')
        }

        /** Esc closes the prompt (the panel itself is focusable). */
        const onKeyDown = (event) => {
          if (!event) return
          if (event.key === 'Escape' || event.key === 'Esc') {
            if (step === 'supervisor') dismissSupervisor()
            else if (step === 'sleep') dismissSleep()
            else dismissBackup()
          }
        }

        /**
         * Close the supervisor question without answering: the card does not
         * come back, and the user can install the supervisor by hand later.
         */
        const dismissSupervisor = () => {
          if (busy) return
          // "Later" is recorded, so the question is never asked again.
          void (async () => {
            try {
              await fetch(supervisorUrlFor(info), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'external', confirmed: true, choice: 'dismissed' }),
              })
            } catch {
              // The card is gone either way; the Host asks again next time.
            }
          })()
          void acknowledgeAnnouncement(ANNOUNCED_FEATURE).catch(() => {})
          setStep('done')
        }

        if (step === 'done' || step === 'persisting') return null
        ensureChoiceStyle()

        /**
         * One option row.
         *
         * The WHOLE row is the click target (and it is focusable, with the
         * radio semantics of a one-of-two choice), while the right side carries
         * the concrete action. The primary row wears a "recommended" pill and a
         * solid button; the secondary one an outlined button.
         */
        const optionRow = (key, name, hint, cta, variant, recommended, pick, dataAttribute) => {
          const onRowClick = () => pick()
          const onRowKeyDown = (event) => {
            if (!event) return
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              pick()
            }
          }
          // The button inside the row must not trigger the row a second time.
          const onCtaClick = (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            pick()
          }
          return h(
            'div',
            {
              key,
              className: 'dsh-autorestart-choice__row',
              role: 'radio',
              'aria-checked': 'false',
              'aria-label': name,
              tabIndex: busy ? -1 : 0,
              [dataAttribute]: key,
              onClick: onRowClick,
              onKeyDown: onRowKeyDown,
            },
            h(
              'div',
              { className: 'dsh-autorestart-choice__text' },
              h(
                'span',
                { className: 'dsh-autorestart-choice__title' },
                recommended
                  ? h('span', { className: 'dsh-autorestart-choice__badge' }, t('backupChoiceRecommended'))
                  : null,
                h('span', { className: 'dsh-autorestart-choice__name' }, name),
              ),
              h('span', { className: 'dsh-autorestart-choice__hint' }, hint),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-choice__cta dsh-autorestart-choice__cta--' + variant,
                [dataAttribute]: key,
                'aria-label': cta,
                title: cta,
                disabled: busy,
                onClick: onCtaClick,
              },
              cta,
            ),
          )
        }

        // The FIRST question: the backup scope (its behaviour is unchanged).
        if (step === 'backup') {
          return h(
            'div',
            {
              className: 'dsh-autorestart-choice',
              role: 'status',
              'aria-live': 'polite',
              tabIndex: 0,
              onKeyDown,
              'data-dsh-autorestart-backup-choice': 'true',
              'data-dsh-autorestart-choice-step': 'backup',
            },
            h(
              'div',
              { className: 'dsh-autorestart-choice__head' },
              h('h3', null, t('backupChoiceTitle')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-autorestart-choice__close',
                  'aria-label': t('backupChoiceDismissAria'),
                  title: t('backupChoiceDismissAria'),
                  disabled: busy,
                  onClick: dismissBackup,
                },
                '×',
              ),
            ),
            h('p', { className: 'dsh-autorestart-choice__subtitle' }, t('backupChoiceBody')),
            h(
              'div',
              { className: 'dsh-autorestart-choice__options' },
              optionRow(
                'plugins',
                t('backupChoiceWithPlugins'),
                t('backupChoiceWithPluginsHint'),
                t('backupChoicePickPrimary'),
                'primary',
                true,
                () => choose(true),
                'data-backup-choice',
              ),
              optionRow(
                'config-only',
                t('backupChoiceConfigOnly'),
                t('backupChoiceConfigOnlyHint'),
                t('backupChoicePickSecondary'),
                'secondary',
                false,
                () => choose(false),
                'data-backup-choice',
              ),
            ),
            h('p', { className: 'dsh-autorestart-choice__footnote' }, t('backupChoiceFootnote')),
            error === '' ? null : h('p', { role: 'alert' }, error),
          )
        }

        // The THIRD question: shall the supervisor be installed?
        if (step === 'supervisor') {
          return h(
            'div',
            {
              className: 'dsh-autorestart-choice',
              role: 'status',
              'aria-live': 'polite',
              tabIndex: 0,
              onKeyDown,
              'data-dsh-autorestart-backup-choice': 'true',
              'data-dsh-autorestart-choice-step': 'supervisor',
            },
            h(
              'div',
              { className: 'dsh-autorestart-choice__head' },
              h('h3', null, t('supervisor.title')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-autorestart-choice__close',
                  'aria-label': t('backupChoiceDismissAria'),
                  title: t('backupChoiceDismissAria'),
                  disabled: busy,
                  onClick: dismissSupervisor,
                },
                '×',
              ),
            ),
            h('p', { className: 'dsh-autorestart-choice__subtitle' }, t('supervisor.body')),
            // The three things the card has to say: what it changes, which rights
            // it needs, and how to remove it again.
            h('p', { className: 'dsh-autorestart-choice__footnote' }, t('supervisor.changes')),
            h('p', { className: 'dsh-autorestart-choice__footnote' }, t('supervisor.rights')),
            h('p', { className: 'dsh-autorestart-choice__footnote' }, t('supervisor.uninstall')),
            h(
              'div',
              { className: 'dsh-autorestart-choice__options' },
              optionRow(
                'install',
                t('supervisor.install'),
                t('supervisor.installHint'),
                t('supervisor.install'),
                'primary',
                true,
                () => chooseSupervisor('install'),
                'data-supervisor-choice',
              ),
              optionRow(
                'external',
                t('supervisor.keep'),
                t('supervisor.keepHint'),
                t('supervisor.keep'),
                'secondary',
                false,
                () => chooseSupervisor('external'),
                'data-supervisor-choice',
              ),
              optionRow(
                'later',
                t('supervisor.later'),
                t('supervisor.laterHint'),
                t('supervisor.later'),
                'secondary',
                false,
                dismissSupervisor,
                'data-supervisor-choice',
              ),
            ),
            error === '' ? null : h('p', { role: 'alert' }, error),
          )
        }

        // The SECOND question: should the graceful-shutdown button stay?
        return h(
          'div',
          {
            className: 'dsh-autorestart-choice',
            role: 'status',
            'aria-live': 'polite',
            tabIndex: 0,
            onKeyDown,
            'data-dsh-autorestart-backup-choice': 'true',
            'data-dsh-autorestart-choice-step': 'sleep',
          },
          h(
            'div',
            { className: 'dsh-autorestart-choice__head' },
            h('h3', null, t('sleep.choice.title')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-choice__close',
                'aria-label': t('backupChoiceDismissAria'),
                title: t('backupChoiceDismissAria'),
                disabled: busy,
                onClick: dismissSleep,
              },
              '×',
            ),
          ),
          h(
            'div',
            {
              className: 'dsh-autorestart-choice__diagram',
              role: 'img',
              'aria-label': t('sleep.choice.diagramLabel'),
            },
            sleepDiagram(),
          ),
          h('p', { className: 'dsh-autorestart-choice__subtitle' }, t('sleep.choice.body')),
          h(
            'div',
            { className: 'dsh-autorestart-choice__options' },
            optionRow(
              'keep',
              t('sleep.choice.keep'),
              t('sleep.choice.keepHint'),
              t('sleep.choice.keepCta'),
              'primary',
              true,
              () => chooseSleep(true),
              'data-sleep-choice',
            ),
            optionRow(
              'hide',
              t('sleep.choice.hide'),
              t('sleep.choice.hideHint'),
              t('sleep.choice.hideCta'),
              'secondary',
              false,
              () => chooseSleep(false),
              'data-sleep-choice',
            ),
          ),
          h('p', { className: 'dsh-autorestart-choice__footnote' }, t('sleep.choice.footnote')),
          error === '' ? null : h('p', { role: 'alert' }, error),
        )
      }

      /* ------------------------------------------------------------------ *
       * The graceful-shutdown (sleep) half.
       * ------------------------------------------------------------------ */

      // The route that arms and cancels the shutdown. It is a sibling of the
      // health route and shares its prefix, so it is derived the very same way.
      const DEFAULT_SLEEP_URL = ROUTE_PREFIX + '/sleep'

      /**
       * ONE shared poller for the sleep status, shared by the sidebar button
       * and the overlay.
       *
       * It follows the pattern of the pending-restart store: the first
       * subscriber starts ONE interval (the same POLL_MS cadence) plus an
       * immediate fetch, and the last one to leave clears the interval and
       * aborts the in-flight request. A failed fetch keeps the last known
       * status, so a transient error never blanks a live countdown.
       */
      const sleepStore = {
        info: null,
        listeners: new Set(),
        timer: null,
        inFlight: false,
        controller: null,
        // When the current status was received: the countdown runs on this
        // clock, so the big number keeps moving between two polls.
        at: 0,
      }

      /**
       * Carry out one intent ('arm' or 'cancel').
       *
       * There is no ticket and no ceremony: the request carries nothing but the
       * action, so the desktop client and the hosted web client drive exactly
       * the same route.
       */
      async function driveSleep(intent) {
        return requestSleep(intent)
      }

      /** Publish a new sleep status to every surface. */
      function setSleepInfo(body) {
        sleepStore.info = body
        sleepStore.at = Date.now()
        sleepStore.listeners.forEach((listener) => {
          try {
            listener(body)
          } catch {
            // One broken listener must not stop the others.
          }
        })
      }

      async function pollSleepOnce() {
        if (sleepStore.inFlight) return
        sleepStore.inFlight = true
        try {
          const response = await fetch(DEFAULT_SLEEP_URL, {
            cache: 'no-store',
            signal: sleepStore.controller ? sleepStore.controller.signal : undefined,
          })
          if (!response.ok) return
          const body = await response.json()
          if (!body || typeof body !== 'object') return
          setSleepInfo(body)
        } catch {
          // Ignored on purpose: the last known status stays.
        } finally {
          sleepStore.inFlight = false
        }
      }

      /**
       * Adds a listener and starts the shared poll when it is the first one.
       * The returned callback stops the poll when the last listener leaves.
       */
      function subscribeSleep(listener) {
        sleepStore.listeners.add(listener)
        if (sleepStore.listeners.size === 1) {
          sleepStore.controller = new AbortController()
          pollSleepOnce()
          sleepStore.timer = setInterval(pollSleepOnce, POLL_MS)
        }
        return () => {
          sleepStore.listeners.delete(listener)
          if (sleepStore.listeners.size === 0) {
            if (sleepStore.timer !== null) {
              clearInterval(sleepStore.timer)
              sleepStore.timer = null
            }
            if (sleepStore.controller) {
              sleepStore.controller.abort()
              sleepStore.controller = null
            }
            // The last sleep surface left: its stylesheet goes away with it, so
            // the document does not keep the CSS of a plugin that is gone.
            removeSleepStyle()
          }
        }
      }

      /**
       * Ask the Host to arm or to cancel the shutdown.
       *
       * The answer carries the new status, so the surfaces do not have to wait
       * for the next poll. A refused request throws, and the caller shows the
       * reason.
       *
       * @param {'arm'|'cancel'} action
       * @returns {Promise<object>} the new sleep status
       */
      async function requestSleep(action) {
        const headers = { 'content-type': 'application/json' }
        const response = await fetch(DEFAULT_SLEEP_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action }),
        })
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok) {
          const message = body && typeof body === 'object'
            ? (body.message || body.error || '')
            : ''
          const failure = new Error(message || String(response.status))
          failure.sleepStatus = response.status
          if (body && typeof body === 'object' && typeof body.reason === 'string') {
            failure.reason = body.reason
          }
          throw failure
        }
        if (body && typeof body === 'object') setSleepInfo(body)
        return body
      }

      /**
       * The current sleep status, re-rendered whenever the shared poll lands. */
      function useSleepStatus() {
        const [status, setStatus] = useState(sleepStore.info)
        useEffect(() => {
          setStatus(sleepStore.info)
          return subscribeSleep(setStatus)
        }, [])
        return status
      }

      /**
       * Whether the browser has no record of the sleep-button answer yet.
       *
       * The question is asked exactly once, so the key is written as soon as
       * the user answers — or closes the prompt.
       */
      function sleepChoicePending() {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return false
          return window.localStorage.getItem(SLEEP_BUTTON_KEY) === null
        } catch {
          return false
        }
      }

      /** Record the sleep-button answer in the browser. */
      function writeSleepChoice(value) {
        try {
          if (typeof window === 'undefined' || !window.localStorage) return false
          window.localStorage.setItem(SLEEP_BUTTON_KEY, String(value))
          return true
        } catch {
          return false
        }
      }

      /**
       * Whether the question about the self-starting supervisor may be shown.
       *
       * The HOST decides: only a HOSTED host is asked (the desktop app brings
       * itself back up, so the question would be noise there), and only while
       * the question was never answered. The Host reports it as
       * `supervisorOffer` in the state payload.
       */
      function supervisorChoicePending(info) {
        if (!info || typeof info !== 'object') return false
        return info.supervisorOffer === true
      }

      /** The route that installs, uninstalls and reports the supervisor. */
      function supervisorUrlFor(info) {
        const sent = info && typeof info.supervisorUrl === 'string' ? info.supervisorUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return DEFAULT_SUPERVISOR_URL
      }

      // The styles of the sleep surfaces. They live in ONE <style> element so
      // the button and the overlay never disagree, and every colour comes from
      // a theme token: light and dark themes both work.
      const SLEEP_STYLE_ID = 'dsh-autorestart-sleep'
      const SLEEP_CSS = [
        // The button at the foot of the left sidebar, beside Settings.
        // It follows the host's own row language (same hover token, same
        // radius token, icon + label), but it stays compact: the sidebar foot
        // is a tight place, and the Settings row must keep its own space.
        '.dsh-autorestart-sleep-button{',
        '  box-sizing:border-box;',
        '  display:inline-flex;',
        '  align-items:center;',
        '  gap:8px;',
        '  height:32px;',
        '  max-width:100%;',
        '  padding:0 10px 0 8px;',
        '  border:none;',
        '  border-radius:var(--dsw-radius-md,8px);',
        '  background:transparent;',
        '  color:var(--dsw-alias-label-primary);',
        '  font:inherit;',
        '  font-size:13px;',
        '  line-height:20px;',
        '  white-space:nowrap;',
        '  overflow:hidden;',
        '  flex:none;',
        '  cursor:pointer;',
        '  transition:background-color .14s,color .14s;',
        '}',
        '.dsh-autorestart-sleep-button:hover{',
        '  background:var(--dsw-alias-interactive-bg-hover);',
        '}',
        '.dsh-autorestart-sleep-button:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
        '.dsh-autorestart-sleep-button:disabled{cursor:default;opacity:.65;}',
        '.dsh-autorestart-sleep-button--armed{',
        '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  background:var(--dsw-alias-bg-module-platform,color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
        '}',
        // The narrow rail (the collapsed sidebar): the icon only, so the rail
        // keeps its width and the row does not push the Settings row away.
        '.dsh-autorestart-sleep-button--rail{',
        '  width:36px;',
        '  height:36px;',
        '  padding:0;',
        '  gap:0;',
        '  justify-content:center;',
        '  border-radius:50%;',
        '}',
        '.dsh-autorestart-sleep-button__icon{width:16px;height:16px;flex:none;display:block;}',
        '.dsh-autorestart-sleep-button__label{',
        '  white-space:nowrap;',
        '  overflow:hidden;',
        '  text-overflow:ellipsis;',
        '}',
        // The button and the reason a request was refused.
        '.dsh-autorestart-sleep-button__wrap{',
        '  display:flex;',
        '  flex-direction:column;',
        '  align-items:flex-start;',
        '  gap:2px;',
        '  min-width:0;',
        '  max-width:100%;',
        '}',
        '.dsh-autorestart-sleep-button__error{',
        '  max-width:100%;',
        '  padding:0 2px;',
        '  color:var(--dsw-alias-danger,#d14343);',
        '  font-size:11.5px;',
        '  line-height:15px;',
        '  text-align:left;',
        '}',
        '.dsh-autorestart-sleep-button__spinner{',
        '  width:12px;',
        '  height:12px;',
        '  flex:none;',
        '  border-radius:50%;',
        '  border:2px solid var(--dsw-alias-border-l1);',
        '  border-top-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  animation:dsh-autorestart-sleep-spin .8s linear infinite;',
        '}',
        // The countdown CARD: a floating corner card, never a full-screen
        // cover. It lets every click through (only the cancel button takes
        // clicks), so the conversation below stays readable and usable.
        '.dsh-autorestart-sleep-overlay{',
        '  position:fixed;',
        '  top:calc(var(--dsh-frame-chrome-top,0px) + 12px);',
        '  right:16px;',
        '  z-index:9998;',
        '  display:flex;',
        '  flex-direction:column;',
        '  align-items:center;',
        '  justify-content:flex-start;',
        '  gap:4px;',
        '  box-sizing:border-box;',
        '  width:max-content;',
        '  max-width:min(320px,calc(100vw - 32px));',
        '  padding:14px 18px 16px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:16px;',
        '  background:var(--dsw-alias-bg-layer-1);',
        '  box-shadow:0 10px 30px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 22%, transparent);',
        '  color:var(--dsw-alias-label-primary);',
        '  text-align:center;',
        '  pointer-events:none;',
        '}',
        '.dsh-autorestart-sleep-overlay__number{',
        '  font-size:clamp(72px,9vmin,140px);',
        '  font-weight:700;',
        '  line-height:1;',
        '  letter-spacing:-.02em;',
        '  color:var(--dsw-alias-label-primary);',
        '  animation:dsh-autorestart-sleep-tick 1s ease-out;',
        '}',
        '.dsh-autorestart-sleep-overlay--urgent .dsh-autorestart-sleep-overlay__number{',
        '  color:var(--dsw-alias-danger,#d14343);',
        '  animation:dsh-autorestart-sleep-tick .7s ease-out;',
        '}',
        // The whale is a guest in the card now, not the star of a full screen.
        '.dsh-autorestart-sleep-overlay .dsh-autorestart-whale{width:min(30vmin,150px);}',
        '.dsh-autorestart-sleep-overlay__caption{',
        '  margin:4px 0 0;',
        '  font-size:14px;',
        '  font-weight:600;',
        '  line-height:1.4;',
        '  color:var(--dsw-alias-label-primary);',
        '  animation:dsh-autorestart-sleep-fade .5s ease-out;',
        '}',
        '.dsh-autorestart-sleep-overlay__hint{',
        '  margin:2px 0 0;',
        '  font-size:13px;',
        '  line-height:1.5;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-autorestart-sleep-overlay__error{',
        '  margin:10px 0 0;',
        '  font-size:12.5px;',
        '  line-height:1.5;',
        '  color:var(--dsw-alias-danger,#d14343);',
        '}',
        '.dsh-autorestart-sleep-overlay__cancel{',
        '  margin-top:10px;',
        '  min-height:32px;',
        '  padding:6px 16px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:9px;',
        '  background:transparent;',
        '  color:var(--dsw-alias-label-primary);',
        '  font:inherit;',
        '  font-size:13px;',
        '  font-weight:600;',
        '  line-height:20px;',
        '  cursor:pointer;',
        // The card itself lets every click through; the cancel button is the
        // one thing in it that takes a click.
        '  pointer-events:auto;',
        '  transition:background-color .14s,border-color .14s,color .14s;',
        '}',
        '.dsh-autorestart-sleep-overlay__cancel:hover{',
        '  border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  background:var(--dsw-alias-bg-layer-2,color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
        '}',
        '.dsh-autorestart-sleep-overlay__cancel:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
        '.dsh-autorestart-sleep-overlay__cancel:disabled{cursor:default;opacity:.65;}',
        // The waiting card: a soft corner card that never covers the reading.
        // Like the countdown card it lets every click through; only its
        // cancel button takes clicks.
        '.dsh-autorestart-sleep-waiting{',
        '  position:fixed;',
        '  right:16px;',
        '  bottom:16px;',
        '  z-index:9998;',
        '  box-sizing:border-box;',
        '  max-width:min(320px,calc(100vw - 32px));',
        '  padding:12px 14px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:12px;',
        '  background:var(--dsw-alias-bg-layer-1);',
        '  box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 18%, transparent);',
        '  color:var(--dsw-alias-label-secondary);',
        '  font-size:12.5px;',
        '  line-height:18px;',
        '  text-align:left;',
        '  pointer-events:none;',
        '}',
        '.dsh-autorestart-sleep-waiting__title{',
        '  margin:0 0 2px;',
        '  font-size:13.5px;',
        '  font-weight:600;',
        '  line-height:19px;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-sleep-waiting__body{margin:0 0 6px;}',
        '.dsh-autorestart-sleep-waiting__list{margin:0 0 6px;padding-left:2px;list-style:none;}',
        '.dsh-autorestart-sleep-waiting__list li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        // The line that says how many blockers are NOT shown: it is a note,
        // not a blocker of its own.
        '.dsh-autorestart-sleep-waiting__more{opacity:.7;}',
        '.dsh-autorestart-sleep-waiting__none{margin:0 0 6px;opacity:.8;}',
        // The command a rehearsal WOULD have run: it has to stay readable,
        // whatever the shell command looks like.
        '.dsh-autorestart-sleep-dryrun__command{',
        '  display:block;',
        '  margin:0 0 8px;',
        '  padding:6px 8px;',
        '  border-radius:8px;',
        '  background:var(--dsw-alias-bg-layer-2,color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
        '  color:var(--dsw-alias-label-primary);',
        '  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
        '  font-size:11.5px;',
        '  line-height:17px;',
        '  word-break:break-all;',
        '}',
        '.dsh-autorestart-sleep-waiting__count{margin:0 0 8px;opacity:.8;}',
        '.dsh-autorestart-sleep-waiting__cancel{',
        '  min-height:28px;',
        '  padding:4px 12px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:8px;',
        '  background:transparent;',
        '  color:var(--dsw-alias-label-primary);',
        '  font:inherit;',
        '  font-size:12.5px;',
        '  font-weight:600;',
        '  line-height:18px;',
        '  cursor:pointer;',
        '  pointer-events:auto;',
        '}',
        '.dsh-autorestart-sleep-waiting__cancel:hover{',
        '  border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '}',
        // The configuration page of the plugin row.
        '.dsh-autorestart-settings{display:flex;flex-direction:column;gap:14px;}',
        // The two titled groups (restart first, shutdown after it).
        '.dsh-autorestart-settings__group{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:12px;',
        '  padding:12px 14px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:10px;',
        '}',
        '.dsh-autorestart-settings__group-title{',
        '  font-size:12px;',
        '  font-weight:700;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-autorestart-settings__field{display:flex;flex-direction:column;gap:4px;}',
        '.dsh-autorestart-settings__label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
        '.dsh-autorestart-settings__select{',
        '  min-height:30px;',
        '  padding:4px 8px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:8px;',
        '  background:var(--dsw-alias-bg-layer-2,transparent);',
        '  color:var(--dsw-alias-label-primary);',
        '  font:inherit;',
        '  font-size:13px;',
        '}',
        '.dsh-autorestart-settings__hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);}',
        // THE BACKUP LIST (user report, 2026-10-29: the old one-liner
        // "2026-10-29 22:08:46+08:00 156.0 MB 含已装插件" was unreadable).
        // One GROUP per backup, a labelled row for the time and one for the
        // size, and enough air between two groups that two copies never read
        // as one block.
        '.dsh-autorestart-settings__backup{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:3px;',
        '  padding-top:8px;',
        '  border-top:1px solid var(--dsw-alias-border-l1);',
        '}',
        '.dsh-autorestart-settings__backup + .dsh-autorestart-settings__backup{margin-top:12px;}',
        '.dsh-autorestart-settings__backup-row{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;}',
        '.dsh-autorestart-settings__backup-label{',
        '  flex:none;',
        '  font-size:12.5px;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-autorestart-settings__backup-value{',
        '  font-size:13px;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-primary);',
        '  font-variant-numeric:tabular-nums;',
        '}',
        '.dsh-autorestart-settings__backup-note{',
        '  font-size:12px;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        // WHAT a copy is (user decision, 2026-10-30): the identity is the first
        // thing read on a row, so it sits on its own line and is not muted.
        '.dsh-autorestart-settings__backup-identity{',
        '  display:flex;',
        '  flex-wrap:wrap;',
        '  gap:8px;',
        '  align-items:baseline;',
        '}',
        '.dsh-autorestart-settings__backup-badge{',
        '  font-size:13px;',
        '  line-height:18px;',
        '  font-weight:600;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-settings__backup-actions{',
        '  display:flex;',
        '  flex-wrap:wrap;',
        '  gap:8px;',
        '  align-items:baseline;',
        '}',
        // EVERY COPY THAT IS NOT THE ONE (user decision, 2026-11-02): one small
        // line each, clearly quieter than the card above it, with no button.
        '.dsh-autorestart-settings__backup-other{',
        '  display:flex;',
        '  flex-wrap:wrap;',
        '  gap:6px;',
        '  margin-top:8px;',
        '  align-items:baseline;',
        '}',
        // THE PER-PLUGIN RECOVERY: a plain list of one row per plugin, the name
        // in monospace so a package name is recognisable at a glance.
        '.dsh-autorestart-settings__plugins{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:6px;',
        '  margin:0;',
        '  padding:0;',
        '  list-style:none;',
        '}',
        '.dsh-autorestart-settings__plugin-row{',
        '  display:grid;',
        '  grid-template-columns:1fr auto auto;',
        '  align-items:center;',
        '  gap:10px;',
        '  padding:6px 8px;',
        '  border-radius:8px;',
        '  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,0.04));',
        '}',
        '.dsh-autorestart-settings__plugin-name{',
        '  font-family:monospace;',
        '  font-size:12px;',
        '  word-break:break-all;',
        '}',
        '.dsh-autorestart-settings__plugin-status{',
        '  font-size:12px;',
        '  color:var(--dsw-alias-label-secondary);',
        '  white-space:nowrap;',
        '}',
        '.dsh-autorestart-settings__plugin-hint{',
        '  grid-column:1 / -1;',
        '  font-size:11px;',
        '  line-height:1.4;',
        '  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));',
        '}',
        // A HOST THAT CANNOT RESTART (user decision, 2026-11-02): a permanent
        // strip at the top of the page. It borrows the error colour of the host
        // theme, so it reads as a warning in both light and dark themes.
        '.dsh-autorestart-settings__banner{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:8px;',
        '  margin:0 0 12px;',
        '  padding:10px 12px;',
        '  border:1px solid var(--dsw-alias-state-error-border,var(--dsw-alias-border-l1));',
        '  border-left:3px solid var(--dsw-alias-state-error-fg,#c62828);',
        '  border-radius:8px;',
        '  background:var(--dsw-alias-bg-layer-1);',
        '}',
        '.dsh-autorestart-settings__banner-text{',
        '  color:var(--dsw-alias-label-primary);',
        '  font-size:13px;',
        '  line-height:19px;',
        '}',
        '.dsh-autorestart-settings__banner-actions{display:flex;flex-wrap:wrap;gap:8px;}',
        '.dsh-autorestart-settings__banner-note,.dsh-autorestart-settings__card-note{',
        '  color:var(--dsw-alias-state-error-fg,var(--dsw-alias-label-secondary));',
        '  font-size:12px;',
        '  line-height:18px;',
        '}',
        // THE ONE-TIME CARD: the same shape as the install prompt, so the user
        // recognises "a question, then it is gone".
        '.dsh-autorestart-settings__card{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:8px;',
        '  margin:0 0 12px;',
        '  padding:14px 16px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:12px;',
        '  background:var(--dsw-alias-bg-layer-1);',
        '  box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 20%, transparent);',
        '}',
        '.dsh-autorestart-settings__card-title{',
        '  margin:0;',
        '  font-size:14px;',
        '  font-weight:600;',
        '  line-height:20px;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-settings__card-actions{display:flex;flex-wrap:wrap;gap:8px;}',
        // THE LINE UNDER THE FOLD TITLE: small, secondary, never a substitute for
        // the title itself.
        '.dsh-autorestart-settings__summary-note{',
        '  display:block;',
        '  margin-top:2px;',
        '  font-size:12px;',
        '  line-height:16px;',
        '  font-weight:400;',
        '  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));',
        '}',
        // THE SECOND CONFIRMATION of a manual rollback: a block that stands
        // apart from the list, because it is a question, not a fact.
        '.dsh-autorestart-settings__confirm{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:6px;',
        '  padding:10px 12px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:8px;',
        '  background:var(--dsw-alias-bg-l1);',
        '}',
        // The folded "technical details": the command itself stays out of the
        // way until somebody asks for it.
        '.dsh-autorestart-settings__details{',
        '  margin-top:2px;',
        '}',
        '.dsh-autorestart-settings__summary{',
        '  font-size:12px;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-secondary);',
        '  cursor:pointer;',
        '}',
        '.dsh-autorestart-settings__details[open] .dsh-autorestart-settings__summary{',
        '  margin-bottom:4px;',
        '}',
        // The two backup switches.
        '.dsh-autorestart-settings__switch{',
        '  width:16px;',
        '  height:16px;',
        '  margin:0;',
        '  accent-color:var(--dsw-alias-brand-primary,#4d6bfe);',
        '  cursor:pointer;',
        '}',
        '.dsh-autorestart-settings__switch:disabled{cursor:not-allowed;opacity:.5;}',
        '.dsh-autorestart-settings__error{',
        '  margin:0;',
        '  color:var(--dsw-alias-danger,#d14343);',
        '  font-size:12.5px;',
        '  line-height:18px;',
        '}',
        // The whale.
        '.dsh-autorestart-whale{width:min(44vmin,240px);height:auto;display:block;overflow:visible;}',
        '.dsh-autorestart-whale__float{',
        '  animation:dsh-autorestart-whale-float 3.2s ease-in-out infinite;',
        '  transform-origin:90px 90px;',
        '}',
        '.dsh-autorestart-whale__eye{',
        '  animation:dsh-autorestart-whale-blink 4.6s ease-in-out infinite;',
        '  transform-origin:48px 74px;',
        '}',
        '.dsh-autorestart-whale__spout{animation:dsh-autorestart-whale-spout 3.6s ease-in-out infinite;}',
        '.dsh-autorestart-whale__z{',
        '  font-family:inherit;',
        '  font-size:15px;',
        '  font-weight:600;',
        '  fill:var(--dsw-alias-label-secondary);',
        '  animation:dsh-autorestart-whale-z 2.8s ease-out infinite;',
        '}',
        '.dsh-autorestart-whale__z--2{animation-delay:.9s;}',
        '.dsh-autorestart-whale__z--3{animation-delay:1.8s;}',
        '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__float{animation-duration:1.1s;}',
        '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__body,',
        '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__tail,',
        '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__fin{fill:var(--dsw-alias-danger,#d14343);}',
        // The keyframes.
        '@keyframes dsh-autorestart-sleep-spin{to{transform:rotate(360deg);}}',
        '@keyframes dsh-autorestart-sleep-tick{',
        '  0%{transform:scale(.86);opacity:.55;}',
        '  40%{transform:scale(1.04);opacity:1;}',
        '  100%{transform:scale(1);opacity:1;}',
        '}',
        '@keyframes dsh-autorestart-sleep-fade{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
        '@keyframes dsh-autorestart-whale-float{',
        '  0%,100%{transform:translateY(0) rotate(0deg);}',
        '  50%{transform:translateY(-10px) rotate(-1.5deg);}',
        '}',
        '@keyframes dsh-autorestart-whale-blink{',
        '  0%,88%,100%{transform:scaleY(1);}',
        '  93%{transform:scaleY(.08);}',
        '  97%{transform:scaleY(1);}',
        '}',
        '@keyframes dsh-autorestart-whale-spout{',
        '  0%,70%,100%{opacity:.35;}',
        '  35%{opacity:1;}',
        '}',
        '@keyframes dsh-autorestart-whale-z{',
        '  0%{opacity:0;transform:translate(0,0) scale(.7);}',
        '  25%{opacity:.9;}',
        '  100%{opacity:0;transform:translate(12px,-26px) scale(1.15);}',
        '}',
        // A user who asked for less motion gets a still whale.
        '@media (prefers-reduced-motion: reduce){',
        '  .dsh-autorestart-whale__float,',
        '  .dsh-autorestart-whale__eye,',
        '  .dsh-autorestart-whale__spout,',
        '  .dsh-autorestart-whale__z,',
        '  .dsh-autorestart-sleep-overlay__number,',
        '  .dsh-autorestart-sleep-overlay__caption,',
        '  .dsh-autorestart-sleep-button__spinner{animation:none !important;}',
        '}',
      ].join('\n')

      /** Inject the sleep styles exactly once. */
      function ensureSleepStyle() {
        if (typeof document === 'undefined' || !document.head) return
        try {
          if (document.getElementById(SLEEP_STYLE_ID)) return
          const style = document.createElement('style')
          style.id = SLEEP_STYLE_ID
          style.textContent = SLEEP_CSS
          document.head.appendChild(style)
        } catch {
          // Without the stylesheet the surfaces are still readable.
        }
      }

      /**
       * Remove the sleep styles again.
       *
       * The stylesheet belongs to the sleep surfaces: when the last one leaves
       * (the plugin is unloaded, the conversation is closed), the CSS goes with
       * it instead of staying in the document forever.
       */
      function removeSleepStyle() {
        if (typeof document === 'undefined') return
        try {
          const node = document.getElementById(SLEEP_STYLE_ID)
          if (node && node.parentNode) node.parentNode.removeChild(node)
        } catch {
          // Nothing to clean up.
        }
      }

      /** The moon of the sidebar button: an inline SVG, no external image. */
      function moonIcon() {
        return h(
          'svg',
          {
            className: 'dsh-autorestart-sleep-button__icon',
            viewBox: '0 0 24 24',
            width: '16',
            height: '16',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', {
            d: 'M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z',
            fill: 'currentColor',
          }),
          h('circle', { cx: '16.5', cy: '6.5', r: '1.3', fill: 'var(--dsw-alias-brand-primary,#4d6bfe)' }),
        )
      }

      /**
       * The graceful-shutdown button, at the foot of the left sidebar.
       *
       * It renders NOTHING at all when the Host says the button must not be
       * shown: no placeholder, no empty space.
       *
       * The sidebar hands the column state to the slot: `wide` is false while
       * the sidebar is collapsed into its narrow rail, and there the button
       * shows its icon only, so the rail keeps its width.
       *
       * @param {{ wide?: boolean }} [props] the sidebar's column state
       */
      /**
       * The settings section of the plugin (the "Auto-restart & shut down" entry
       * in the settings sidebar).
       *
       * The Host renders this section for the slot `settings.section` with the
       * id `dsh-autorestart`. The settings are split into two titled groups:
       *
       *   - "Restart settings": how long the host waits before a restart (a
       *     dropdown), whether the pre-restart backup is taken at all (a
       *     switch) and whether that backup also snapshots the installed
       *     plugins (a switch);
       *   - "Shutdown settings": how long the visible countdown of the
       *     graceful shutdown runs (a dropdown).
       *
       * The restart group comes first. The shutdown has no invisible reserve:
       * its countdown on screen IS the wait before the machine goes off.
       *
       * A change is written to the profile configuration at once (through the
       * plugin's own choice route, which uses the official `configEditor`
       * service), and the section reads the new values back from the Host.
       *
       * @param {object} props the Host's props: `t` (the translator of the
       *   registered locale, injected by the section registration)
       */
      /* ---------------------------------------------------------------- *
       * THE RECEIPT OF A SETTINGS CHANGE
       *
       * A setting is written the moment the user picks it ("change it and it
       * is in effect"), which left the user unable to tell whether it was
       * really stored. This is the missing half: ONE `sticky` line at the TOP
       * OF THE SETTINGS PANEL that says "Saved 21:40:12" once the HOST
       * answered `ok: true`, or "Not saved — <the reason>" in red when it
       * refused.
       *
       * It is drawn INSIDE the panel (a child of the panel's own tree), never
       * on the window: a window overlay put it on top of the conversation
       * area, outside the dialog it belongs to.
       *
       * The rules it keeps:
       *
       *   - NOTHING is announced before the Host's receipt: rendering the
       *     page, polling it and clicking a control all stay silent;
       *   - a failure is never swallowed and never fades: it stays until the
       *     next change succeeds or the user closes it;
       *   - a success fades out on its own after a moment, and three changes
       *     in a row update the SAME line instead of stacking new ones;
       *   - the line lives exactly as long as the panel does (closing the
       *     settings throws it away).
       * ---------------------------------------------------------------- */

      /** The id of the one stylesheet of the receipt line. */
      const SAVE_NOTICE_STYLE_ID = 'dsh-autorestart-save-notice'
      /** How long the green line stays; the red one stays for ever. */
      const SAVE_NOTICE_HIDE_MS = 3000

      /**
       * The receipt on screen right now (one for the whole panel: two changes
       * never produce two lines).
       *
       * `notice` is `null` until a save came back from the Host, and it is
       * `{ kind: 'ok' | 'failed', at, atText, reason }` afterwards.
       */
      const saveNoticeStore = {
        notice: null,
        listeners: new Set(),
        timer: null,
      }

      /** Tell every mounted receipt about the current one. */
      function notifySaveNotice() {
        saveNoticeStore.listeners.forEach((listener) => {
          try {
            listener(saveNoticeStore.notice)
          } catch {
            // One broken listener must not stop the others.
          }
        })
      }

      /** The local clock time of a receipt, as HH:MM:SS. */
      function formatSaveNoticeClock(at) {
        const moment = new Date(at)
        const pad = (value) => (value < 10 ? '0' + value : String(value))
        return pad(moment.getHours()) + ':' + pad(moment.getMinutes()) + ':' + pad(moment.getSeconds())
      }

      /**
       * Publish one receipt.
       *
       * A pending fade-out of the previous receipt is dropped first, so a
       * second change restarts the clock on the SAME line (test: "two saves,
       * one line").
       */
      function publishSaveNotice(notice) {
        if (saveNoticeStore.timer !== null) {
          clearTimeout(saveNoticeStore.timer)
          saveNoticeStore.timer = null
        }
        saveNoticeStore.notice = notice
        notifySaveNotice()
        // A failure stays: only the user closes it (or a save that works).
        if (notice.kind !== 'ok') return
        const timer = setTimeout(() => {
          saveNoticeStore.timer = null
          // A newer receipt replaced this one while the timer ran.
          if (saveNoticeStore.notice !== notice) return
          saveNoticeStore.notice = null
          notifySaveNotice()
        }, SAVE_NOTICE_HIDE_MS)
        // In a browser this is a number; under Node it is a Timeout that must
        // not hold the process open (the tests run in one).
        if (timer && typeof timer.unref === 'function') timer.unref()
        saveNoticeStore.timer = timer
      }

      /**
       * The Host took the change (`ok: true`): this is the ONE moment the
       * page may say "Saved".
       */
      function publishSaveSaved() {
        const at = Date.now()
        publishSaveNotice({ kind: 'ok', at, atText: formatSaveNoticeClock(at), reason: '' })
      }

      /**
       * The Host refused the change: say so, with the reason it gave, and
       * keep saying it.
       *
       * @param {string} reason the error of the Host answer (or of the request)
       */
      function publishSaveFailure(reason) {
        const at = Date.now()
        publishSaveNotice({
          kind: 'failed',
          at,
          atText: formatSaveNoticeClock(at),
          reason: typeof reason === 'string' ? reason : '',
        })
      }

      /** Close the receipt: only the user does that, with the close button. */
      function clearSaveNotice() {
        if (saveNoticeStore.timer !== null) {
          clearTimeout(saveNoticeStore.timer)
          saveNoticeStore.timer = null
        }
        if (saveNoticeStore.notice === null) return
        saveNoticeStore.notice = null
        notifySaveNotice()
      }

      /** The receipt on screen, re-rendered whenever it changes. */
      function useSaveNotice() {
        const [notice, setNotice] = useState(saveNoticeStore.notice)
        useEffect(() => {
          setNotice(saveNoticeStore.notice)
          saveNoticeStore.listeners.add(setNotice)
          return () => { saveNoticeStore.listeners.delete(setNotice) }
        }, [])
        return notice
      }

      // THE RECEIPT OF A SETTINGS CHANGE IS A STRIP OF THE SETTINGS PANEL.
      //
      // It used to be a WINDOW overlay (`shell.overlay`), and that was wrong:
      // the user saw it floating over the conversation area — outside the
      // dialog it belonged to. It is a child of the panel itself now: a
      // `sticky` strip at the top of the panel, so it stays visible while the
      // settings are scrolled and it can never leave the dialog.
      //
      // The strip COVERS the first line of the panel for its 30px (the wrapper
      // is sticky with height 0) instead of pushing the form down, so nothing
      // jumps when it appears or fades.
      const SAVE_NOTICE_CSS = [
        '.dsh-autorestart-save-notice{',
        '  position:sticky;',
        '  top:0;',
        '  z-index:5;',
        '  height:0;',
        '  pointer-events:none;',
        '}',
        '.dsh-autorestart-save-notice__bar{',
        '  display:flex;',
        '  align-items:center;',
        '  gap:8px;',
        '  box-sizing:border-box;',
        '  height:30px;',
        '  max-width:100%;',
        '  padding:0 4px 0 10px;',
        '  border:1px solid transparent;',
        '  border-radius:8px;',
        '  font-size:13px;',
        '  line-height:18px;',
        '  white-space:nowrap;',
        '  pointer-events:auto;',
        '  box-shadow:0 2px 8px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 14%, transparent);',
        '}',
        // The green strip: a light green ground with green text.
        '.dsh-autorestart-save-notice--ok .dsh-autorestart-save-notice__bar{',
        '  border-color:color-mix(in srgb, var(--dsw-alias-state-success,#1a7f37) 38%, transparent);',
        '  background:color-mix(in srgb, var(--dsw-alias-state-success,#1a7f37) 12%, var(--dsw-alias-bg-layer-1));',
        '  color:var(--dsw-alias-state-success-fg,var(--dsw-alias-state-success,#1a7f37));',
        '}',
        // The red one: a light red ground with red text. It does not fade.
        '.dsh-autorestart-save-notice--failed .dsh-autorestart-save-notice__bar{',
        '  border-color:color-mix(in srgb, var(--dsw-alias-danger,#d14343) 38%, transparent);',
        '  background:color-mix(in srgb, var(--dsw-alias-danger,#d14343) 12%, var(--dsw-alias-bg-layer-1));',
        '  color:var(--dsw-alias-danger,#d14343);',
        '}',
        '.dsh-autorestart-save-notice__title{flex:none;font-weight:600;}',
        // The clock time sits at the RIGHT of the strip, in small type.
        '.dsh-autorestart-save-notice__time{',
        '  flex:none;',
        '  margin-left:auto;',
        '  font-size:11.5px;',
        '  opacity:.75;',
        '  font-variant-numeric:tabular-nums;',
        '}',
        // The reason is the only text that may be cut, and even then the whole
        // text is in the tooltip: the short copy itself is never cut.
        '.dsh-autorestart-save-notice__reason{',
        '  flex:0 1 auto;',
        '  min-width:0;',
        '  overflow:hidden;',
        '  text-overflow:ellipsis;',
        '}',
        '.dsh-autorestart-save-notice__close{',
        '  flex:none;',
        '  width:20px;',
        '  height:20px;',
        '  padding:0;',
        '  border:none;',
        '  border-radius:6px;',
        '  background:transparent;',
        '  color:inherit;',
        '  font:inherit;',
        '  font-size:14px;',
        '  line-height:18px;',
        '  cursor:pointer;',
        '}',
        '.dsh-autorestart-save-notice__close:hover{background:color-mix(in srgb, currentColor 14%, transparent);}',
        '.dsh-autorestart-save-notice__close:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
        // The fade is decoration: a system that asks for less motion gets none.
        '@media (prefers-reduced-motion: no-preference){',
        '  .dsh-autorestart-save-notice__bar{animation:dsh-autorestart-save-notice-in .16s ease-out;}',
        '}',
        '@keyframes dsh-autorestart-save-notice-in{',
        '  from{opacity:0;transform:translateY(-3px);}',
        '  to{opacity:1;transform:translateY(0);}',
        '}',
      ].join('\n')

      /** Inject the stylesheet of the receipt exactly once. */
      function ensureSaveNoticeStyle() {
        if (typeof document === 'undefined' || !document.head) return
        try {
          if (document.getElementById(SAVE_NOTICE_STYLE_ID)) return
          const style = document.createElement('style')
          style.id = SAVE_NOTICE_STYLE_ID
          style.textContent = SAVE_NOTICE_CSS
          document.head.appendChild(style)
        } catch {
          // Without the stylesheet the line is still readable, just plainer.
        }
      }

      /**
       * THE RECEIPT OF A SETTINGS CHANGE, drawn INSIDE the settings panel.
       *
       * It is a child of the panel itself (never a window overlay): the DOM
       * ancestor of this strip IS the settings section, so it can not float
       * over the conversation area. `SAVE_NOTICE_CSS` makes it a `sticky`
       * strip at the top of the panel, so it stays visible while the settings
       * are scrolled, and it covers the first line instead of pushing the
       * form down.
       *
       * It renders NOTHING until a save came back from the Host — the first
       * render and every poll are silent.
       *
       * @param {(key: string) => string} t the translator of the panel
       * @param {object|null} notice the receipt on screen (`null` = none)
       */
      function saveNoticeBar(t, notice) {
        if (!notice) return null
        ensureSaveNoticeStyle()
        const saved = notice.kind === 'ok'
        return h(
          'div',
          {
            className: 'dsh-autorestart-save-notice'
              + (saved ? ' dsh-autorestart-save-notice--ok' : ' dsh-autorestart-save-notice--failed'),
            role: saved ? 'status' : 'alert',
            'aria-live': saved ? 'polite' : 'assertive',
            'data-dsh-autorestart-save-notice': saved ? 'ok' : 'failed',
            'data-dsh-autorestart-save-notice-at': notice.atText,
          },
          h(
            'div',
            { className: 'dsh-autorestart-save-notice__bar' },
            // LEFT: the short copy ("已生效" / "Saved").
            h(
              'span',
              { className: 'dsh-autorestart-save-notice__title' },
              saved ? t('settings.saveNotice.saved') : t('settings.saveNotice.failed'),
            ),
            // The reason of a failure (the only text that may be cut, and the
            // tooltip carries all of it).
            saved || notice.reason === ''
              ? null
              : h(
                'span',
                {
                  className: 'dsh-autorestart-save-notice__reason',
                  'data-dsh-autorestart-save-notice-reason': 'true',
                  title: notice.reason,
                },
                notice.reason,
              ),
            // RIGHT: the small clock time, then the close button.
            h('span', { className: 'dsh-autorestart-save-notice__time' }, notice.atText),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-save-notice__close',
                'data-dsh-autorestart-save-notice-close': 'true',
                onClick: clearSaveNotice,
                title: t('settings.saveNotice.dismiss'),
                'aria-label': t('settings.saveNotice.dismiss'),
              },
              '×',
            ),
          ),
        )
      }

      function AutorestartSection(props) {
        const status = useSleepStatus()
        const info = useSharedInfo(true)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        // The dry run of the restart command (null = not derived yet).
        const [dryRun, setDryRun] = useState(null)
        // "REPORT A PROBLEM": the text to copy by hand, shown when the
        // clipboard refuses (an insecure context, no permission).
        const [reportFallback, setReportFallback] = useState('')
        // The note under the backup path: copied, or "copy it by hand".
        const [pathNote, setPathNote] = useState('')
        // Whether the "technical details" fold is open. It is NOT persisted:
        // a fresh page starts closed, so nobody leaves technical text open by
        // accident.
        const [detailsOpen, setDetailsOpen] = useState(false)
        // The two folds of the BACKUP group (user decision, 2026-11-02): the long
        // explanation and the per-copy technical rows are collapsed by default,
        // while every switch stays visible. Both use the neutral label
        // `settings.backup.details` (added with the user's approval).
        const [backupDetailsOpen, setBackupDetailsOpen] = useState(false)
        const [backupListDetailsOpen, setBackupListDetailsOpen] = useState(false)
        // THE WHOLE BACKUP BLOCK IS ONE FOLD (user decision, 2026-11-02): the
        // four switches stay visible, everything that only EXPLAINS the backups
        // (the count, the rules, the copy cards, the path and the per-plugin
        // recovery) lives behind `settings.backup.section`. Closed by default —
        // except on a boot the system had to restore, where the one copy that
        // matters must not be hidden (see the fold below).
        const [backupSectionOpen, setBackupSectionOpen] = useState(false)
        // THE ONE-TIME "this host cannot restart" CARD (user decision,
        // 2026-11-02). `restartCardPending` is the Host's answer ("read once per
        // host"), `restartCardDone` only hides it in this session right after
        // the click, and `restartFixNote` carries the reason of a failed
        // attempt. Nothing is ever written without the click.
        const [restartCardPending, setRestartCardPending] = useState(false)
        const [restartCardDone, setRestartCardDone] = useState(false)
        const [restartFixNote, setRestartFixNote] = useState('')
        // The command this page just wrote ('' = none). It hides the strip at
        // once and shows what is configured NOW, instead of waiting for the next
        // health poll — the user clicked a button and must see the result.
        const [restartApplied, setRestartApplied] = useState('')
        // THE MANUAL ROLLBACK (user decision, 2026-10-30). Asking is a STATE,
        // not a `window.confirm`: the card has to say WHICH copy, that the
        // current state is replaced, and that a restart follows. `null` = nobody
        // is asking, and only a confirmation ever calls the route.
        // THE COPY LIMIT (user decision, 2026-11-02): the number the user picks,
        // the confirmation that stands between a smaller number and deleted
        // copies, and what the route reported back afterwards.
        const [limitBusy, setLimitBusy] = useState(false)
        const [limitNote, setLimitNote] = useState('')
        const [limitAsk, setLimitAsk] = useState(null)
        // The value the select SHOWS: seeded from the payload, replaced by the
        // answer, so the number on screen is the number in force right after the
        // write instead of waiting for the next poll.
        const [limitValue, setLimitValue] = useState(null)

        /**
         * WRITE THE COPY LIMIT (user decision, 2026-11-02).
         *
         * The route answers with the copies it really deleted and with
         * `keptWillExceedRequest`, so this reports the truth instead of echoing
         * the number the user asked for. A refusal carries the Host's `reason`
         * and is shown as-is — rewriting it would hide which value was refused.
         */
        const submitBackupLimit = async (wanted) => {
          const url = backupLimitUrlFor(info)
          // A WRITE THAT CANNOT BE ADDRESSED MUST SAY SO (user report,
          // 2026-11-02): this used to `return` silently, which is exactly how
          // "2 份改 3 份不生效" looked from the outside — no request, no message,
          // no change. The default route makes this branch unreachable, and if a
          // future change makes it reachable again the page says it failed
          // instead of pretending nothing happened.
          if (url === '') {
            setLimitNote(t('settings.backup.limitFailed'))
            return
          }
          setLimitBusy(true)
          setLimitNote('')
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ maxBackups: wanted }),
            })
            const answer = await response.json().catch(() => null)
            setLimitAsk(null)
            if (response.ok !== true || answer === null || answer.ok !== true) {
              setLimitNote(answer && typeof answer.reason === 'string' && answer.reason !== ''
                ? answer.reason
                : t('settings.backup.limitFailed'))
              return
            }
            const removed = Array.isArray(answer.removed) ? answer.removed.length : 0
            const kept = Number.isFinite(Number(answer.kept)) ? Number(answer.kept) : wanted
            setLimitValue(Number.isFinite(Number(answer.maxBackups)) ? Number(answer.maxBackups) : wanted)
            // BOTH READINGS MOVE TOGETHER (user report, 2026-11-02): the select
            // shows the confirmed number at once, and this poll brings the two
            // lines above it to the same value instead of leaving them saying the
            // old limit until the next 2 s tick.
            void pollOnce()
            setLimitNote(answer.keptWillExceedRequest === true
              ? fill(t('settings.backup.limitMore'), { requested: String(wanted), kept: String(kept) })
              : fill(t('settings.backup.limitDeleted'), { removed: String(removed), kept: String(kept) }))
          } catch {
            setLimitNote(t('settings.backup.limitFailed'))
          } finally {
            setLimitBusy(false)
          }
        }
        const [rollbackAsk, setRollbackAsk] = useState(null)
        const [rollbackBusy, setRollbackBusy] = useState(false)
        const [rollbackNote, setRollbackNote] = useState('')
        const t = makeTranslate(props && typeof props.t === 'function' ? props.t : translate)
        // THE RECEIPT OF A SETTINGS CHANGE, on screen right now. It belongs to
        // THIS panel (it is not a window overlay), so it is read here and
        // drawn here.
        const saveNotice = useSaveNotice()

        // The receipt lives exactly as long as this panel is on screen: a page
        // that is closed (or reopened) never shows a "Saved" of an earlier
        // visit. The mount clearing also covers a Host that keeps the section
        // mounted while it is hidden.
        useEffect(() => {
          clearSaveNotice()
          return () => { clearSaveNotice() }
        }, [])

        // The current values come from the Host, so the panel always shows what
        // is really in effect.
        const reported = status && typeof status === 'object' && typeof status.countdownSeconds === 'number'
          ? status.countdownSeconds
          : SLEEP_DEFAULT_COUNTDOWN_SECONDS
        const seconds = SLEEP_COUNTDOWN_CHOICES.indexOf(reported) === -1
          ? SLEEP_DEFAULT_COUNTDOWN_SECONDS
          : reported
        // The two backup switches: the Host says what is in effect.
        const backupOnRestart = status && typeof status === 'object' && typeof status.backupOnRestart === 'boolean'
          ? status.backupOnRestart
          : true
        const backupIncludePlugins = status && typeof status === 'object' && typeof status.backupIncludePlugins === 'boolean'
          ? status.backupIncludePlugins
          : true
        // The RESTART reserve: the Host reports it in milliseconds, the
        // dropdown works in seconds.
        const reportedRestartGraceMs = status && typeof status === 'object' && typeof status.restartGraceMs === 'number'
          ? status.restartGraceMs
          : GRACE_DEFAULT_MS
        const restartGraceSeconds = GRACE_CHOICES_SECONDS.indexOf(Math.round(reportedRestartGraceMs / 1000)) === -1
          ? GRACE_DEFAULT_SECONDS
          : Math.round(reportedRestartGraceMs / 1000)

        // THE SUPERVISOR: who starts this host, and can the restart work at all.
        // The Host reports it in the state payload.
        const supervisorStatus = info && typeof info === 'object' && info.supervisor && typeof info.supervisor === 'object'
          ? info.supervisor
          : null
        // HOW this host was started (the startup matrix): the mode, the
        // evidence the verdict rests on, and what the plugin may do about it.
        const supervisorStartup = supervisorStatus !== null
          && supervisorStatus.startup !== null
          && typeof supervisorStatus.startup === 'object'
          ? supervisorStatus.startup
          : null
        // THE PLATFORM GUIDE: how "start at login" works here (Windows /
        // Linux / WSL / container) and the commands the user can copy.
        const supervisorAutostart = supervisorStatus !== null
          && supervisorStatus.autostart !== null
          && typeof supervisorStatus.autostart === 'object'
          ? supervisorStatus.autostart
          : null
        const supervisorInstalled = supervisorStatus !== null && supervisorStatus.installed === true
        // WHICH END IS THIS? The same browser side serves the desktop app and
        // the hosted web host, so it may not assume one of them. The Host says
        // which one it is; when it does not say, the panel stays neutral.
        const hostIsDesktop = info && typeof info === 'object' && info.instance && typeof info.instance === 'object'
          ? info.instance.isDesktopApp === true
          : false
        const supervisorMode = supervisorStatus !== null && typeof supervisorStatus.mode === 'string'
          ? supervisorStatus.mode
          : ''
        // The install button is only offered where it makes sense: the desktop
        // app brings itself back up (there is nothing to install there), and a
        // host that somebody ELSE supervises must not get a second supervisor
        // (they would both start the host and fight over the port).
        const supervisorCanInstall = canOfferSupervisorInstall(supervisorStatus, info && info.instance)
        const supervisorNoInstall = hostIsDesktop
          ? 'settings.supervisor.noInstallDesktop'
          : (supervisorMode === 'external'
            ? 'settings.supervisor.noInstallExternal'
            : 'settings.supervisor.noInstallUnknown')
        const accessUrl = info && typeof info === 'object' && typeof info.accessUrl === 'string' ? info.accessUrl : ''
        // THE STARTUP BLOCK: the desktop client brings itself back up, so it has
        // no command to derive and must never write one. An unknown host stays
        // hidden as well — "not shown" beats "shown and misleading".
        const showStartupBlock = shouldShowStartupBlock(info)
        const startupStatus = startupStatusLine(t, info)
        // WHAT IS WRITTEN RIGHT NOW: the restart command and what an undo would
        // restore. The Host reads it — the browser cannot see the profile.
        const restartInfo = info && typeof info === 'object' && info.restart && typeof info.restart === 'object'
          ? info.restart
          : { mode: '', command: '', written: false, canRevert: false, previous: null }
        // CAN THIS HOST RESTART AT ALL? (user report, 2026-11-02)
        //
        // A hosted `dsh web` with no `command` restart mode is a host this
        // plugin cannot restart and will not back up before a restart — i.e. it
        // does nothing for the user. That used to be silent: the page looked
        // perfectly healthy. Both halves are required (`mode: 'command'` AND a
        // command), and the desktop app is never told this: it relaunches
        // itself.
        const restartModeValue = typeof restartInfo.mode === 'string' ? restartInfo.mode : ''
        const restartCommandValue = typeof restartInfo.command === 'string' ? restartInfo.command : ''
        const restartCapable = restartModeValue === 'command' && restartCommandValue.trim() !== ''
        // Only a Host that TOLD us about its restart settings can be accused of
        // having none: an older build (or the very first paint, before the state
        // arrived) must not produce a red strip.
        const restartKnown = Boolean(info && typeof info === 'object' && info.restart && typeof info.restart === 'object')
        const restartMissing = restartKnown && hostIsDesktop !== true && !restartCapable && restartApplied === ''
        // WHICH PROFILE WOULD BE BACKED UP (2026-11-02): the Host resolves it,
        // and `dir: null` means "more than one profile matched / none did" — so
        // backups and rollbacks are paused. The browser cannot look at the disk,
        // so this is only a DISPLAY of the Host's answer; when the Host does not
        // send it (older builds), nothing is claimed.
        const profileInfo = (() => {
          const source = info && typeof info === 'object' ? info.profile : null
          if (source && typeof source === 'object') return source
          if (typeof source === 'string') return { dir: source }
          const flat = info && typeof info === 'object' ? info.profileDir : null
          if (flat && typeof flat === 'object') return flat
          if (typeof flat === 'string') return { dir: flat }
          const fromRestart = info && typeof info === 'object' && info.lastRestart
            && typeof info.lastRestart === 'object' && info.lastRestart.snapshot
            && typeof info.lastRestart.snapshot === 'object'
            ? info.lastRestart.snapshot.profile
            : null
          return fromRestart && typeof fromRestart === 'object' ? fromRestart : null
        })()
        const profileUnknown = profileInfo !== null
          && (profileInfo.dir === null || profileInfo.dir === undefined || String(profileInfo.dir) === '')
        // THE BACKUPS ON DISK: the count, the local time, the size, whether the
        // plugins are in it and where it lives. The Host reads the directory.
        const backupsInfo = info && typeof info === 'object' && info.backups && typeof info.backups === 'object'
          ? info.backups
          : { dir: '', max: 0, count: 0, items: [] }
        // WHAT HAPPENED TO THE LAST RESTART REQUEST, computed once (2026-11-03).
        const cancelledRestart = cancelledRestartNote(info, props && typeof props.t === 'function' ? props.t : translate)
        const backupItems = Array.isArray(backupsInfo.items) ? backupsInfo.items : []
        // WHICH COPY THE ONE SENTENCE BELONGS TO (user decision, 2026-11-02):
        // resolved ONCE from the copies' own records, so the sentence follows the
        // copy and not the row it happens to be drawn in.
        const startupCopy = startupCopyName(backupItems)
        // IS THE ONE-TIME "cannot restart" CARD STILL UNREAD? (2026-11-02)
        //
        // Same ledger as the feature announcement (same route, same key style,
        // same "answered once per host" rule) — the card is a reminder, not a
        // new mechanism.
        useEffect(() => {
          if (!restartMissing) return undefined
          let alive = true
          void (async () => {
            const pending = await fetchAnnouncements().catch(() => [])
            if (!alive) return
            setRestartCardPending(pending.some((entry) => entry.feature === ANNOUNCED_RESTART))
          })()
          return () => { alive = false }
        }, [restartMissing])
        const supervisorPending = supervisorStatus !== null
          && supervisorStatus.detail !== null
          && typeof supervisorStatus.detail === 'object'
          && Array.isArray(supervisorStatus.detail.pendingCommands)
          && supervisorStatus.detail.pendingCommands.length > 0
          ? supervisorStatus.detail.pendingCommands.join('   ;   ')
          : ''

        /**
         * Install or uninstall the supervisor.
         *
         * The button IS the confirmation: the user pressed it, so the request
         * carries `confirmed: true`. Without it the Host refuses to touch the
         * machine.
         */
        const driveSupervisor = async (action) => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(supervisorUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, confirmed: true }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
              const message = body && typeof body === 'object'
                ? (body.error || String(response.status))
                : String(response.status)
              setError(fill(t('supervisor.error'), { message }))
              return
            }
          } catch (failure) {
            setError(fill(t('supervisor.error'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
          }
        }

        /**
         * E + B: derive the restart command and show it (the dry run).
         *
         * The dry run writes NOTHING. Only the "use this command" button sends
         * the confirmation, and only then does the Host write the command into
         * the profile configuration.
         */
        const driveDryRun = async (action) => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(supervisorUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, confirmed: action !== 'dry-run' }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
              const message = body && typeof body === 'object'
                ? (body.error || String(response.status))
                : String(response.status)
              setError(fill(t('supervisor.error'), { message }))
              return
            }
            if (action === 'dry-run') {
              setDryRun(body && typeof body.plan === 'object' ? body.plan : null)
            } else {
              // The command was written (or the undo ran): the preview is stale.
              setDryRun(null)
            }
          } catch (failure) {
            setError(fill(t('supervisor.error'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
          }
        }

        /**
         * THE ONE-CLICK REPAIR of a host that cannot restart (user decision,
         * 2026-11-02 — option A).
         *
         * THREE STEPS, and the click is the only reason anything is written:
         *   1. `dry-run`: the Host derives the command that starts this host
         *      again and validates it. NOTHING is written;
         *   2. `apply` with `confirmed: true`: NOW the command is written into
         *      the profile configuration (the Host refuses without it);
         *   3. the announcement is marked as read, so the card does not come
         *      back, and the undo stays available (`revert`).
         *
         * A failure is never silent: the Host's own reason is shown in the
         * user's words, and the manual path (the supervisor group's
         * "derive / use this command") stays where it is.
         */
        const fixRestartCommand = async () => {
          if (busy) return
          setBusy(true)
          setError('')
          setRestartFixNote('')
          try {
            const dryResponse = await fetch(supervisorUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'dry-run' }),
            })
            const dryBody = await dryResponse.json().catch(() => null)
            const plan = dryBody && typeof dryBody === 'object' && dryBody.plan && typeof dryBody.plan === 'object'
              ? dryBody.plan
              : null
            if (!dryResponse.ok || !plan || plan.ok !== true) {
              const reason = plan && typeof plan.reason === 'string' ? plan.reason.trim() : ''
              setRestartFixNote(reason === ''
                ? t('settings.supervisor.noCommand')
                : t('settings.supervisor.reason.' + reason))
              return
            }
            const applyResponse = await fetch(supervisorUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'apply', confirmed: true }),
            })
            const applied = await applyResponse.json().catch(() => null)
            if (!applyResponse.ok || !applied || typeof applied !== 'object' || applied.ok !== true) {
              const message = applied && typeof applied === 'object' && applied.error
                ? String(applied.error)
                : String(applyResponse.status)
              setRestartFixNote(fill(t('supervisor.error'), { message }))
              return
            }
            await acknowledgeAnnouncement(ANNOUNCED_RESTART).catch(() => {})
            setRestartCardPending(false)
            setRestartCardDone(true)
            // WHAT IS CONFIGURED NOW, straight from the Host's answer (never
            // from what we hoped it wrote).
            const written = applied.writes && typeof applied.writes === 'object'
              && typeof applied.writes.restartCommand === 'string'
              ? applied.writes.restartCommand
              : ''
            setRestartApplied(written === '' ? t('settings.supervisor.noCommand') : written)
          } catch (failure) {
            setRestartFixNote(fill(t('supervisor.error'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
          }
        }

        /** "Later": the card does not come back (the strip stays). */
        const dismissRestartCard = () => {
          setRestartCardPending(false)
          setRestartCardDone(true)
          void acknowledgeAnnouncement(ANNOUNCED_RESTART).catch(() => {})
        }

        /**
         * Write one change into the profile configuration.
         *
         * The Host answers with the effective values, and the panel reads them
         * back with a fresh poll — so the controls never show a value the
         * Host did not take.
         *
         * ONLY the Host's answer (`ok: true`) makes the window say "Saved":
         * picking a value, rendering the page and polling it stay silent.
         *
         * @param {object} changes the keys to write
         */
        /**
         * THE MANUAL ROLLBACK (user decision, 2026-10-30).
         *
         * It is ONLY ever called from the confirmation card: the button on a row
         * opens the question, and nothing is posted until the user says yes. The
         * route takes a backup NAME (never a path) and does the rest on the Host
         * — save the current state, restore that copy, request a restart.
         *
         * @param {{ name?: string, atLocal?: string|null }|null} ask what the user picked
         */
        const rollbackTo = async (ask) => {
          const name = ask && typeof ask.name === 'string' ? ask.name : ''
          if (name === '' || rollbackBusy === true) return
          setRollbackBusy(true)
          setRollbackNote('')
          try {
            const response = await fetch(rollbackUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok || !body || typeof body !== 'object' || body.ok !== true) {
              const message = body && typeof body === 'object'
                ? String(body.error || body.message || response.status)
                : String(response.status)
              setRollbackNote(fill(t('settings.backup.rollbackFailed'), { message }))
              return
            }
            // The copy is back and a restart has been requested: the card goes
            // away, and the panel says what is happening right now.
            setRollbackAsk(null)
            setRollbackNote(t('settings.backup.rollbackDone'))
          } catch (failure) {
            setRollbackNote(fill(t('settings.backup.rollbackFailed'), { message: describeError(failure) }))
          } finally {
            setRollbackBusy(false)
          }
        }

        const save = async (changes) => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(choiceUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(changes),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
              const message = body && typeof body === 'object'
                ? (body.message || body.error || String(response.status))
                : String(response.status)
              setError(fill(t('settings.error'), { message }))
              // The Host refused the write: the red line keeps the reason
              // until the next change works (or the user closes it).
              publishSaveFailure(message)
              return
            }
            if (!body || typeof body !== 'object' || body.ok !== true) {
              // The request came back, but the Host did not confirm it: a
              // "saved" line here would be a lie.
              const reason = body && typeof body === 'object'
                ? String(body.message || body.error || '')
                : ''
              setError(fill(t('settings.error'), {
                message: reason === '' ? String(response.status) : reason,
              }))
              publishSaveFailure(reason)
              return
            }
            // The receipt is there: now the window may say "Saved".
            publishSaveSaved()
            // Read the new values back from the Host.
            await pollSleepOnce()
          } catch (failure) {
            const message = describeError(failure)
            setError(fill(t('settings.error'), { message }))
            publishSaveFailure(message)
          } finally {
            setBusy(false)
          }
        }

        ensureSleepStyle()

        // "REPORT A PROBLEM". The diagnostic text comes from the HOST (one
        // generator, so the two can never drift); the browser only copies it
        // and opens the pre-filled issue page.
        const diagnostics = info && typeof info.diagnostics === 'string' ? info.diagnostics : ''
        const report = info && typeof info.report === 'object' && info.report !== null ? info.report : {}
        const reportEmail = typeof report.email === 'string' ? report.email : ''
        const reportIssueUrl = buildIssueUrl(
          typeof report.issueUrlBase === 'string' ? report.issueUrlBase : '',
          t('settings.report.issueTitle'),
          t('settings.report.issueBody'),
        )

        /**
         * Copy the diagnostics, and open the pre-filled issue page.
         *
         * The clipboard can refuse (an insecure context, no permission). Then
         * the text is shown in a box the user can select — a report must never
         * be lost because a browser said no.
         */
        const reportIssue = async () => {
          const copied = await copyReportText(diagnostics)
          if (copied.fallback) setReportFallback(copied.text)
          try {
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(reportIssueUrl, '_blank', 'noopener')
            }
          } catch {
            // A blocked pop-up must not eat the report: the text is copied.
          }
        }

        /** Copy the diagnostics only (the way out without GitHub). */
        const copyDiagnostics = async () => {
          const copied = await copyReportText(diagnostics)
          if (copied.fallback) setReportFallback(copied.text)
        }

        /**
         * Copy the path of the backup directory.
         *
         * The path is on screen anyway (selectable), so a refused clipboard
         * only costs a hint, not the path.
         */
        const copyBackupPath = async () => {
          const copied = await copyReportText(backupsInfo.dir)
          setPathNote(copied.fallback ? t('settings.backup.copyFailed') : t('settings.backup.copied'))
        }


        return h(
          'div',
          { className: 'dsh-autorestart-settings' },
          // THE RECEIPT: a `sticky` strip at the TOP of this panel. It is a
            // WHAT HAPPENED TO THE RESTART YOU ASKED FOR (user report, 2026-11-03): it waited
            // hours, a host restart cancelled it, and the page looked as if nothing had ever
            // been requested. It comes first, because the next thing the user wants is to ask
            // again — and that button is right below.
            cancelledRestart ? h(
              'div',
              {
                className: 'dsh-autorestart-settings__banner',
                'data-dsh-autorestart-restart': 'cancelled-note',
                role: 'status',
              },
              h(
                'span',
                { className: 'dsh-autorestart-settings__banner-text', 'data-dsh-autorestart-restart': 'cancelled-text' },
                cancelledRestart.text,
              ),
            ) : null,
          // child of the panel (the DOM ancestor of the message IS the
          // settings section), so it can not float over the conversation area
          // again — and it stays visible while the settings are scrolled.
          saveNoticeBar(t, saveNotice),
          // ③ THE RESULT OF THE CLICK: the command that is configured NOW. It is
          // shown where the strip was, so "it worked" is visible without opening
          // a fold and without waiting for the next poll.
          restartApplied !== ''
            ? h(
                'div',
                { className: 'dsh-autorestart-settings__field', 'data-dsh-autorestart-restart-fixed': 'true' },
                h(
                  'span',
                  { className: 'dsh-autorestart-settings__label', 'data-dsh-autorestart-restart-fixed': 'label' },
                  t('settings.supervisor.command'),
                ),
                h(
                  'code',
                  { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-restart-fixed': 'command' },
                  restartApplied,
                ),
              )
            : null,
          // ① A HOST THAT CANNOT RESTART, SAID AT THE TOP OF THE PAGE (user
          // decision, 2026-11-02 — option A).
          //
          // Without a `command` restart mode the plugin does nothing at all, and
          // that used to look exactly like a healthy install. The strip stays
          // while it is true, and it carries the ONE action that fixes it. It
          // never writes anything by itself: the button is the confirmation.
          restartMissing
            ? h(
                'div',
                {
                  className: 'dsh-autorestart-settings__banner',
                  role: 'status',
                  'data-dsh-autorestart-restart-missing': 'true',
                },
                h(
                  'span',
                  { className: 'dsh-autorestart-settings__banner-text', 'data-dsh-autorestart-restart-missing': 'text' },
                  t('settings.restartBanner.title'),
                ),
                h(
                  'div',
                  { className: 'dsh-autorestart-settings__banner-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      disabled: busy,
                      'data-dsh-autorestart-restart-missing': 'fix',
                      onClick: () => void fixRestartCommand(),
                    },
                    t('settings.restartBanner.fix'),
                  ),
                ),
                restartFixNote === ''
                  ? null
                  : h(
                      'span',
                      { className: 'dsh-autorestart-settings__banner-note', 'data-dsh-autorestart-restart-missing': 'note' },
                      restartFixNote,
                    ),
              )
            : null,
          // ② THE ONE-TIME CARD: same ledger as the feature announcement, so it
          // is shown once per host and never again after the user answered it.
          restartMissing && restartCardPending && !restartCardDone
            ? h(
                'div',
                { className: 'dsh-autorestart-settings__card', 'data-dsh-autorestart-restart-card': 'true' },
                h(
                  'h3',
                  { className: 'dsh-autorestart-settings__card-title', 'data-dsh-autorestart-restart-card': 'title' },
                  t('settings.restartBanner.title'),
                ),
                h(
                  'div',
                  { className: 'dsh-autorestart-settings__card-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      disabled: busy,
                      'data-dsh-autorestart-restart-card': 'fix',
                      onClick: () => void fixRestartCommand(),
                    },
                    t('settings.restartBanner.fix'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      disabled: busy,
                      'data-dsh-autorestart-restart-card': 'later',
                      onClick: () => dismissRestartCard(),
                    },
                    t('supervisor.later'),
                  ),
                ),
                restartFixNote === ''
                  ? null
                  : h(
                      'span',
                      { className: 'dsh-autorestart-settings__card-note', 'data-dsh-autorestart-restart-card': 'note' },
                      restartFixNote,
                    ),
              )
            : null,
          // The panel is split into two titled groups: the RESTART settings
          // come first, the SHUTDOWN settings after them. The two situations
          // are different, so they do not share one flat list.
          h(
            'div',
            {
              className: 'dsh-autorestart-settings__group',
              'data-dsh-autorestart-group': 'restart',
            },
            h(
              'div',
              { className: 'dsh-autorestart-settings__group-title' },
              t('settings.groups.restart'),
            ),
            // THE STATUS LINE: what the restart is doing right now, next to the
            // settings that control it. It lives here (the pill only exists
            // while a restart is pending), so a slow backup, "restarting" and
            // "back — carrying on" are visible where the user went looking.
            restartStageText(info && info.restartPhase) === ''
              ? null
              : h(
                'div',
                {
                  className: 'dsh-autorestart-settings__status',
                  'data-dsh-autorestart-stage': String(
                    info && info.restartPhase && info.restartPhase.phase ? info.restartPhase.phase : '',
                  ),
                  style: {
                    margin: '2px 0 8px',
                    fontSize: 12,
                    lineHeight: '16px',
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                  },
                },
                restartStageText(info && info.restartPhase),
              ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.restartGrace.label')),
              h(
                'select',
                {
                  className: 'dsh-autorestart-settings__select',
                  value: String(restartGraceSeconds),
                  disabled: busy,
                  'data-dsh-autorestart-setting': 'restartGraceMs',
                  onChange: (event) => {
                    const value = Number(event && event.target ? event.target.value : NaN)
                    if (!Number.isFinite(value) || value === restartGraceSeconds) return
                    void save({ restartGraceMs: value * 1000 })
                  },
                },
                GRACE_CHOICES_SECONDS.map((choice) => h(
                  'option',
                  { key: String(choice), value: String(choice) },
                  choice === 0
                    ? t('settings.restartGrace.immediate')
                    : fill(t('settings.restartGrace.value'), { n: choice }),
                )),
              ),
              h('span', { className: 'dsh-autorestart-settings__hint' }, t('settings.restartGrace.hint')),
            ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.backup.label')),
              h(
                'input',
                {
                  type: 'checkbox',
                  className: 'dsh-autorestart-settings__switch',
                  checked: backupOnRestart,
                  disabled: busy,
                  'data-dsh-autorestart-setting': 'backupOnRestart',
                  onChange: (event) => {
                    const value = Boolean(event && event.target ? event.target.checked : false)
                    if (value === backupOnRestart) return
                    void save({ backupOnRestart: value })
                  },
                },
              ),
              // THE EXPLANATION IS FOLDED (user decision, 2026-11-02): the switch
              // above stays on screen — only the words fold.
              h(
                'details',
                {
                  className: 'dsh-autorestart-settings__details',
                  'data-dsh-autorestart-backup': 'details',
                  onToggle: (event) => {
                    setBackupDetailsOpen(Boolean(event && event.target ? event.target.open : false))
                  },
                },
                h('summary', { className: 'dsh-autorestart-settings__summary' }, t('settings.backup.details')),
                backupDetailsOpen
                  ? h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'content-hint' },
                    t('settings.backup.hint'),
                  )
                  : null,
              ),
            ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.backupPlugins.label')),
              h(
                'input',
                {
                  type: 'checkbox',
                  className: 'dsh-autorestart-settings__switch',
                  checked: backupIncludePlugins,
                  // Without a pre-restart backup there is nothing to extend: the
                  // switch is greyed out (and the Host never reads it).
                  disabled: busy || !backupOnRestart,
                  'data-dsh-autorestart-setting': 'backupIncludePlugins',
                  onChange: (event) => {
                    const value = Boolean(event && event.target ? event.target.checked : false)
                    if (value === backupIncludePlugins) return
                    void save({ backupIncludePlugins: value })
                  },
                },
              ),
              h('span', { className: 'dsh-autorestart-settings__hint' }, t('settings.backupPlugins.hint')),
            ),
            // MORE THAN ONE PROFILE = NO BACKUPS AT ALL (2026-11-02): the Host
            // cannot tell which profile to copy, so backups and rollbacks are
            // paused. That is a fact about the whole block, so it sits ABOVE
            // the fold — and it is only ever shown when the Host actually said
            // so (`dir: null`); the browser never guesses.
            profileUnknown
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field', 'data-dsh-autorestart-backup': 'multi-profile' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'multi-profile-text' },
                    t('settings.backup.multiProfile'),
                  ),
                )
              : null,
            // WHAT IS BACKED UP RIGHT NOW — one FOLD (user decision, 2026-11-02).
            //
            // The words that only EXPLAIN the backups (the count, the rules, the
            // copy list, the path and the per-plugin recovery) made the page
            // long enough that the switches were pushed out of sight. They are
            // all behind `settings.backup.section` now, closed by default — but
            // NOT closed on a boot the system had to restore: an intervention
            // is the one fact that must not be hidden, so the fold opens itself
            // and says so on its summary.
            (() => {
              const anyIntervened = backupItems.some((item) => Boolean(item && item.intervention === true))
              const sectionOpen = backupSectionOpen || anyIntervened
              return h(
                'details',
                {
                  className: 'dsh-autorestart-settings__details',
                  'data-dsh-autorestart-backup': 'section',
                  ...(sectionOpen ? { open: true } : {}),
                  onToggle: (event) => {
                    setBackupSectionOpen(Boolean(event && event.target ? event.target.open : false))
                  },
                },
                h(
                  'summary',
                  {
                    className: 'dsh-autorestart-settings__summary',
                    'data-dsh-autorestart-backup': 'section-summary',
                  },
                  anyIntervened
                    ? t('settings.backup.section') + ' · ' + t('settings.backup.intervention.true')
                    : t('settings.backup.section'),
                ),
                // THE CONTENT IS ALWAYS IN THE TREE (only `<details>` hides it):
                // the panel is a few dozen nodes, and rendering them once keeps
                // the fold from re-mounting the buttons (and their state) every
                // time somebody opens it.
                h(
                  'div',
                  { className: 'dsh-autorestart-settings__field', 'data-dsh-autorestart-backup': 'list' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__label' },
                t('settings.backup.list'),
              ),
              // TWO LINES, AND ONLY TWO (user report, 2026-11-02). This block used
              // to spend five lines on the same three facts — twice on the
              // retention limit, and once with the number spelled out inside a
              // sentence, which went stale the moment the dropdown changed it.
              // Line 1: how many copies there are and what they take on disk.
              h(
                'span',
                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-backup': 'count' },
                fill(t('settings.backup.count'), {
                  n: backupItems.length,
                  size: formatBackupSize(
                    backupItems.reduce((total, item) => total + (Number(item && item.bytes) || 0), 0),
                  ),
                }),
              ),
              // Line 2: the rule that bounds them, with the limit in force — the
              // dropdown below is what changes that number.
              h(
                'span',
                { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'keep' },
                fill(t('settings.backup.keep'), { n: backupsInfo.max }),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'kinds-local' },
                t('settings.backup.kindsLocal'),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'kinds-third-party' },
                t('settings.backup.kindsThirdParty'),
              ),
              // THE COPY LIMIT IS EDITABLE HERE (user decision, 2026-11-02): a
              // dropdown of 1..10, defaulting to the value the Host reports. It
              // writes through the backup-limit route and the page re-reads the
              // state, so "the number shown" is always "the number in force".
              h(
                'div',
                { className: 'dsh-autorestart-settings__backup-row', key: 'backup-limit' },
                h(
                  'span',
                  { className: 'dsh-autorestart-settings__backup-label' },
                  t('settings.backup.limitLabel'),
                ),
                h(
                  'select',
                  {
                    className: 'dsh-autorestart-settings__select',
                    'data-dsh-autorestart-backup': 'limit-select',
                    'data-dsh-autorestart-setting': 'maxBackups',
                    value: String(limitValue === null ? backupsInfo.max : limitValue),
                    disabled: limitBusy,
                    onChange: (event) => {
                      const wanted = Number(event.target.value)
                      if (Number.isFinite(wanted) !== true) return
                      // SHRINKING IS THE ONLY DANGEROUS DIRECTION: nothing is
                      // written until the user confirms how many copies die.
                      if (wanted < backupItems.length) {
                        setLimitNote('')
                        setLimitAsk({ wanted, from: backupItems.length, remove: backupItems.length - wanted })
                        return
                      }
                      void submitBackupLimit(wanted)
                    },
                  },
                  [2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) =>
                    h('option', { key: 'limit-' + value, value: String(value) }, String(value))),
                ),
                // THE DISK WARNING SITS TO THE RIGHT OF THE DROPDOWN (user
                // report, 2026-11-02): as its own line BELOW the control it
                // arrived after the choice had already been made.
                h(
                  'span',
                  { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'limit-hint' },
                  t('settings.backup.limitHint'),
                ),
              ),
              limitAsk === null
                ? null
                : h(
                  'div',
                  { className: 'dsh-autorestart-settings__backup-row', key: 'limit-ask' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__backup-label', 'data-dsh-autorestart-backup': 'limit-ask-body' },
                    fill(t('settings.backup.limitAsk'), {
                      remove: String(limitAsk.remove),
                      from: String(limitAsk.from),
                      to: String(limitAsk.wanted),
                    }),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'dsh-autorestart-announcement__cta',
                    'data-dsh-autorestart-backup': 'limit-confirm',
                    disabled: limitBusy,
                    onClick: () => { void submitBackupLimit(limitAsk.wanted) },
                  }, t('settings.backup.limitConfirm')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-autorestart-announcement__cta',
                    'data-dsh-autorestart-backup': 'limit-cancel',
                    // CANCELLING SENDS NOTHING: no route call, no write, no delete.
                    onClick: () => { setLimitAsk(null); setLimitNote('') },
                  }, t('settings.backup.limitCancel')),
                ),
              limitNote === ''
                ? null
                : h(
                  'span',
                  { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'limit-note' },
                  limitNote,
                ),
              // THE TWO EXPLAINING PARAGRAPHS ARE GONE (user report, 2026-11-02).
              //
              // They said a backup has "one of two identities" and that only a
              // "safe" copy is ever rolled back — but since 2026-11-02 the list
              // has no tier at all: every copy is one row with its own rollback
              // button. Keeping the paragraph made the page contradict itself,
              // and a user who believes it will not dare press the button on an
              // older copy. What is left on this page is what is TRUE: the count,
              // the rules in force (`keep`), the rows themselves, the path.
              backupItems.length === 0
                ? h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'empty' },
                    t('settings.backup.empty'),
                  )
                : null,
              // THE BACKUP THAT WAS SKIPPED, SAID OUT LOUD (2026-11-07): the
              // Host could not name the profile directory, so no copy was
              // taken — and a copy nobody mentions is a copy the user believes
              // exists. The count comes from the Host's own scan.
              profileUnknown === true
                ? h(
                    'span',
                    {
                      className: 'dsh-autorestart-settings__hint',
                      'data-dsh-autorestart-backup': 'profile-unknown',
                      role: 'alert',
                    },
                    fill(t('settings.backup.profileUnknown'), {
                      n: String(Number.isFinite(Number(info && info.profileCandidates))
                        ? Number(info.profileCandidates)
                        : 0),
                    }),
                  )
                : null,
              // ONE ROW PER COPY, AND ONE SENTENCE ON ONE COPY
              // (user decision, 2026-11-02).
              //
              // The page used to split the list into "the good copy" and
              // "everything else". That split was a promise the plugin cannot
              // keep: on a hosted instance nothing ever qualified, so the good
              // tier was empty forever and every real copy sat in the demoted
              // row. So there is no tier any more, and nothing is read from
              // `certifiedBy` / `kind` / `certificationEvidence` to draw a row.
              //
              // What is left is what can be said without judging: one row per
              // copy with its time and its own rollback button, plus the single
              // sentence that describes WHICH copy this is — the state the host
              // last started from. `startupCopy` is resolved from the copies' own
              // records (`startupCopyName`), never from the row order: a sentence
              // that followed the position would walk onto an older copy the day
              // the Host returns them in another order.
              backupItems.map((item, index) => h(
                'div',
                {
                  className: 'dsh-autorestart-settings__backup',
                  'data-dsh-autorestart-backup': 'item',
                  'data-backup-index': String(index),
                  key: 'backup-' + index,
                },
                h(
                  'div',
                  { className: 'dsh-autorestart-settings__backup-row' },
                  h(
                    'span',
                    {
                      className: 'dsh-autorestart-settings__backup-value',
                      'data-dsh-autorestart-backup': 'time',
                    },
                    formatBackupTime(item && item.atLocal),
                  ),
                  // ROLL BACK TO THIS COPY. The button only OPENS the question —
                  // the route is called from the confirmation card and nowhere
                  // else, so a click alone never restores anything.
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      disabled: busy === true || rollbackBusy === true,
                      'data-dsh-autorestart-backup': 'rollback',
                      'data-backup-name': item && typeof item.name === 'string' ? item.name : '',
                      onClick: () => {
                        setRollbackNote('')
                        setRollbackAsk({
                          name: item && typeof item.name === 'string' ? item.name : '',
                          atLocal: item && typeof item.atLocal === 'string' ? item.atLocal : null,
                        })
                      },
                    },
                    t('settings.backup.rollback'),
                  ),
                ),
                // THE ONE SENTENCE, ON THE ONE COPY IT IS TRUE OF — matched by
                // the copy's own name, never by `index === 0`.
                startupCopy !== null && item && item.name === startupCopy
                  ? h(
                      'div',
                      {
                        className: 'dsh-autorestart-settings__backup-note',
                        'data-dsh-autorestart-backup': 'startup-hint',
                      },
                      t('settings.backup.startupHint'),
                    )
                  : null,
              )),
              // THE SECOND CONFIRMATION OF A MANUAL ROLLBACK (user decision,
              // 2026-10-30): it names the copy, says that the current state is
              // replaced (and that it is saved first), and says that a restart
              // follows. Nothing is posted until the confirm button is pressed.
              rollbackAsk === null
                ? null
                : h(
                  'div',
                  {
                    className: 'dsh-autorestart-settings__confirm',
                    'data-dsh-autorestart-backup': 'rollback-confirm',
                  },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__label' },
                    t('settings.backup.rollbackConfirmTitle'),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'rollback-confirm-body' },
                    fill(t('settings.backup.rollbackConfirmBody'), { time: formatBackupTime(rollbackAsk.atLocal) }),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'rollback-confirm-restart' },
                    t('settings.backup.rollbackConfirmRestart'),
                  ),
                  h(
                    'div',
                    { className: 'dsh-autorestart-settings__backup-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-autorestart-settings__button',
                        disabled: rollbackBusy === true,
                        'data-dsh-autorestart-backup': 'rollback-confirm-yes',
                        onClick: () => void rollbackTo(rollbackAsk),
                      },
                      rollbackBusy === true
                        ? t('settings.backup.rollbackBusy')
                        : t('settings.backup.rollbackConfirmYes'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-autorestart-settings__button',
                        disabled: rollbackBusy === true,
                        'data-dsh-autorestart-backup': 'rollback-confirm-no',
                        onClick: () => {
                          // Cancel: nothing was posted, nothing is restored.
                          setRollbackAsk(null)
                          setRollbackNote('')
                        },
                      },
                      t('settings.backup.rollbackConfirmNo'),
                    ),
                  ),
                ),
              rollbackNote === ''
                ? null
                : h(
                  'span',
                  { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'rollback-note' },
                  rollbackNote,
                ),
              backupsInfo.dir === ''
                ? null
                : h(
                    'div',
                    { className: 'dsh-autorestart-settings__field' },
                    h(
                      'span',
                      { className: 'dsh-autorestart-settings__label' },
                      t('settings.backup.path'),
                    ),
                    h(
                      'code',
                      { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-backup': 'path' },
                      backupsInfo.dir,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-autorestart-settings__button',
                        disabled: busy,
                        'data-dsh-autorestart-backup': 'copy-path',
                        onClick: () => void copyBackupPath(),
                      },
                      t('settings.backup.copyPath'),
                    ),
                    pathNote === ''
                      ? null
                      : h(
                          'span',
                          { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-backup': 'copy-note' },
                          pathNote,
                        ),
                  ),
              ),
                )
              })(),
          ),
          h(
            'div',
            {
              className: 'dsh-autorestart-settings__group',
              'data-dsh-autorestart-group': 'shutdown',
            },
            h(
              'div',
              { className: 'dsh-autorestart-settings__group-title' },
              t('settings.groups.shutdown'),
            ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.seconds.label')),
              h(
                'select',
                {
                  className: 'dsh-autorestart-settings__select',
                  value: String(seconds),
                  disabled: busy,
                  'data-dsh-autorestart-setting': 'sleepCountdownSeconds',
                  onChange: (event) => {
                    const value = Number(event && event.target ? event.target.value : NaN)
                    if (!Number.isFinite(value) || value === seconds) return
                    void save({ sleepCountdownSeconds: value })
                  },
                },
                SLEEP_COUNTDOWN_CHOICES.map((choice) => h(
                  'option',
                  { key: String(choice), value: String(choice) },
                  choice === 0 ? t('settings.seconds.immediate') : fill(t('settings.seconds.value'), { n: choice }),
                )),
              ),
              h('span', { className: 'dsh-autorestart-settings__hint' }, t('settings.seconds.hint')),
            ),
          ),
          // The SUPERVISOR group: who starts this host, and whether the restart
          // can work at all. HIDDEN ON THE DESKTOP APP (user decision, 2026-11-02):
          // the desktop client relaunches itself, so there is no supervisor to
          // install and nothing in this group can be acted on.
          hostIsDesktop === true ? null : h(
            'div',
            {
              className: 'dsh-autorestart-settings__group',
              'data-dsh-autorestart-group': 'supervisor',
            },
            h(
              'div',
              { className: 'dsh-autorestart-settings__group-title' },
              t('settings.groups.supervisor'),
            ),
            h(
              'div',
              { className: 'dsh-autorestart-settings__field' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__label' },
                t('settings.supervisor.status'),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'mode' },
                supervisorModeLabel(t, supervisorStatus),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__hint' },
                t('settings.supervisor.hint'),
              ),
            ),
            h(
              'div',
              { className: 'dsh-autorestart-settings__field' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__label' },
                t('settings.supervisor.capable'),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'capable' },
                supervisorStatus && supervisorStatus.restartCapable === true
                  ? t('settings.supervisor.capableYes')
                  : t('settings.supervisor.capableNo'),
              ),
            ),
            supervisorStartup !== null
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__label' },
                    t('settings.supervisor.startup'),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'startup' },
                    startupModeLabel(t, supervisorStartup),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint' },
                    startupWhy(t, supervisorStartup),
                  ),
                )
              : null,
            supervisorAutostart !== null
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__label' },
                    t('settings.supervisor.autostart'),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'autostart' },
                    humanKind(t, supervisorAutostart.kind),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint' },
                    stripMarkdown(supervisorAutostart.reason),
                  ),
                  supervisorAutostart.commands.length > 0
                    ? h(
                        'span',
                        { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-supervisor': 'autostart-commands' },
                        supervisorAutostart.commands.join('   ;   '),
                      )
                    : null,
                )
              : null,
            supervisorInstalled || supervisorCanInstall
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      disabled: busy,
                      'data-dsh-autorestart-supervisor': supervisorInstalled ? 'uninstall' : 'install',
                      onClick: () => void driveSupervisor(supervisorInstalled ? 'uninstall' : 'install'),
                    },
                    supervisorInstalled ? t('settings.supervisor.uninstall') : t('settings.supervisor.install'),
                  ),
                  supervisorPending
                    ? h(
                        'span',
                        { className: 'dsh-autorestart-settings__hint' },
                        fill(t('settings.supervisor.pending'), { commands: supervisorPending }),
                      )
                    : null,
                )
              : h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-supervisor': 'no-install' },
                    t(supervisorNoInstall),
                  ),
                ),
            accessUrl
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__label' },
                    t('settings.supervisor.access'),
                  ),
                  h(
                    'code',
                    { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-access': 'url' },
                    accessUrl,
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint' },
                    t('settings.supervisor.accessHint'),
                  ),
                )
              : null,
            // E + B, in plain words: ONE line that says what this plugin
            // remembers about the way the host was started, two small actions
            // next to it, and the command itself folded away ("technical
            // details"). The desktop client brings ITSELF back up, so the
            // whole block stays away there — and so does an unknown host.
            showStartupBlock
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'startup-status' },
                    t(startupStatus.key),
                  ),
                  startupStatus.canDerive
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-autorestart-settings__button',
                          disabled: busy,
                          'data-dsh-autorestart-supervisor': 'derive',
                          onClick: () => void driveDryRun('dry-run'),
                        },
                        t('settings.supervisor.deriveHelp'),
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      disabled: busy,
                      'data-dsh-autorestart-supervisor': 'redetect',
                      onClick: () => void driveDryRun('dry-run'),
                    },
                    t('settings.supervisor.redetect'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      // Nothing to undo: the button says so instead of lying.
                      disabled: busy || !restartInfo.canRevert,
                      'data-dsh-autorestart-supervisor': 'revert',
                      onClick: () => void driveDryRun('revert'),
                    },
                    t('settings.supervisor.revert'),
                  ),
                )
              : null,
            showStartupBlock
              ? h(
                  'details',
                  {
                    className: 'dsh-autorestart-settings__details',
                    'data-dsh-autorestart-supervisor': 'details',
                    onToggle: (event) => {
                      setDetailsOpen(Boolean(event && event.target ? event.target.open : false))
                    },
                  },
                  h(
                    'summary',
                    { className: 'dsh-autorestart-settings__summary' },
                    t('settings.supervisor.technical'),
                  ),
                  // The content is only IN the page while the fold is open: a
                  // closed fold shows the title only.
                  detailsOpen
                    ? h(
                        'div',
                        { className: 'dsh-autorestart-settings__dry-run' },
                        h(
                          'span',
                          { className: 'dsh-autorestart-settings__hint' },
                          t('settings.supervisor.technicalHint'),
                        ),
                        dryRun
                          ? h(
                              'div',
                              { className: 'dsh-autorestart-settings__dry-run', 'data-dsh-autorestart-dry-run': 'true' },
                              h(
                                'span',
                                { className: 'dsh-autorestart-settings__hint' },
                                t('settings.supervisor.plan'),
                              ),
                              h(
                                'code',
                                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-dry-run': 'command' },
                                dryRun.command || t('settings.supervisor.noCommand'),
                              ),
                              h(
                                'span',
                                { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-dry-run': 'reason' },
                                t('settings.supervisor.reason.' + (dryRun.reason || 'ok')),
                              ),
                              dryRun.ok
                                ? h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'dsh-autorestart-settings__button',
                                      disabled: busy,
                                      'data-dsh-autorestart-supervisor': 'apply',
                                      onClick: () => void driveDryRun('apply'),
                                    },
                                    t('settings.supervisor.apply'),
                                  )
                                : null,
                            )
                          : null,
                        restartInfo.written
                          ? h(
                              'div',
                              { className: 'dsh-autorestart-settings__dry-run' },
                              h(
                                'span',
                                { className: 'dsh-autorestart-settings__hint' },
                                t('settings.supervisor.command'),
                              ),
                              h(
                                'code',
                                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'written' },
                                restartInfo.command,
                              ),
                            )
                          : null,
                        restartInfo.previous && restartInfo.previous.restartCommand
                          ? h(
                              'div',
                              { className: 'dsh-autorestart-settings__dry-run' },
                              h(
                                'span',
                                { className: 'dsh-autorestart-settings__hint' },
                                t('settings.supervisor.previous'),
                              ),
                              h(
                                'code',
                                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'previous' },
                                restartInfo.previous.restartCommand,
                              ),
                            )
                          : null,
                      )
                    : null,
                )
              : null,
          ),
          // "REPORT A PROBLEM": copy the diagnostics and open a pre-filled
          // issue page. The email is the way out when there is no GitHub
          // account. When the clipboard refuses, the text is shown in a box
          // the user can select.
          h(
            'div',
            {
              className: 'dsh-autorestart-settings__group',
              'data-dsh-autorestart-group': 'report',
            },
            h(
              'div',
              { className: 'dsh-autorestart-settings__group-title' },
              t('settings.groups.report'),
            ),
            h(
              'div',
              { className: 'dsh-autorestart-settings__field' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__label' },
                t('settings.report.label'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-autorestart-settings__button',
                  disabled: busy,
                  'data-dsh-autorestart-report': 'github',
                  onClick: () => void reportIssue(),
                },
                t('settings.report.github'),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__hint' },
                t('settings.report.hint'),
              ),
            ),
            h(
              'div',
              { className: 'dsh-autorestart-settings__field' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__hint' },
                fill(t('settings.report.email'), { email: reportEmail }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-autorestart-settings__button',
                  disabled: busy,
                  'data-dsh-autorestart-report': 'copy',
                  onClick: () => void copyDiagnostics(),
                },
                t('settings.report.copy'),
              ),
            ),
            reportFallback === ''
              ? null
              : h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-report': 'copy-failed' },
                    t('settings.report.copyFailed'),
                  ),
                  h(
                    'textarea',
                    {
                      className: 'dsh-autorestart-settings__value',
                      readOnly: true,
                      rows: 10,
                      'data-dsh-autorestart-report': 'text',
                      value: reportFallback,
                      onFocus: (event) => {
                        try {
                          if (event && event.target && typeof event.target.select === 'function') event.target.select()
                        } catch {
                          // The browser decides how a selection behaves.
                        }
                      },
                    },
                    reportFallback,
                  ),
                ),
          ),
          error === ''
            ? null
            : h('p', { className: 'dsh-autorestart-settings__error', role: 'alert' }, error),
        )
      }

      function SleepButton(props) {
        const status = useSleepStatus()
        const [arming, setArming] = useState(false)
        const [error, setError] = useState('')
        const t = makeTranslate(translate)

        // The Host's truth decides, and an UNKNOWN truth decides NOTHING: before
        // the first poll the button renders nothing at all, so a host that has
        // the button switched off never sees it flash for two seconds.
        const remoteKnown = Boolean(
          status && typeof status === 'object' && typeof status.showSleepButton === 'boolean',
        )
        const visible = remoteKnown && shouldShowSleepButton(status)

        // The narrow rail shows the icon only; the wide column shows the label.
        const wide = !(props && props.wide === false)

        // How long the countdown lasts (the settings page offers a dropdown).
        const reported = status && typeof status === 'object' && typeof status.countdownSeconds === 'number'
          ? status.countdownSeconds
          : SLEEP_DEFAULT_COUNTDOWN_SECONDS
        const countdownSeconds = SLEEP_COUNTDOWN_CHOICES.indexOf(reported) === -1
          ? SLEEP_DEFAULT_COUNTDOWN_SECONDS
          : reported
        const countdownHint = countdownSeconds > 0
          ? fill(t('sleep.button.title'), { n: countdownSeconds })
          : t('sleep.button.titleImmediate')

        // The button is a TOGGLE: a click arms the shutdown, and a click while
        // the shutdown is armed cancels it. That way there is ALWAYS a way out,
        // even when the countdown screen is not (or no longer) on top.
        const armed = Boolean(
          status && typeof status === 'object' && (
            status.armed === true
            || status.phase === 'waiting'
            || status.phase === 'countdown'
            || status.phase === 'shutting-down'
          ),
        )

        /**
         * Ask the Host to stand by: it waits for every session to finish and
         * then counts down.
         *
         * That is all a click does: the Host arms the shutdown, waits for the
         * busy conversations and counts down. Clicking again (or the cancel
         * button on the card) takes it back.
         */
        const arm = async () => {
          if (arming) return
          setArming(true)
          setError('')
          try {
            await driveSleep('arm')
          } catch (failure) {
            setError(fill(t('sleep.error'), { message: describeError(failure) }))
          } finally {
            setArming(false)
          }
        }

        /** Take the shutdown back: the countdown stops and the machine stays on. */
        const cancel = async () => {
          if (arming) return
          setArming(true)
          setError('')
          try {
            await driveSleep('cancel')
          } catch (failure) {
            setError(fill(t('sleep.error'), { message: describeError(failure) }))
          } finally {
            setArming(false)
          }
        }

        /**
         * The click itself is the action: the moon button arms the shutdown,
         * and while it is armed the same button cancels it again.
         *
         * @param {object} event the DOM event of the click
         */
        const handleClick = (event) => {
          if (armed) cancel()
          else arm()
        }

        if (!visible) return null
        ensureSleepStyle()

        const button = h(
          'button',
          {
            type: 'button',
            className: 'dsh-autorestart-sleep-button'
              + (armed ? ' dsh-autorestart-sleep-button--armed' : '')
              + (wide ? '' : ' dsh-autorestart-sleep-button--rail'),
            'aria-label': armed ? t('sleep.button.cancel') : t('sleep.button.aria'),
            title: error || (armed ? t('sleep.button.cancel') : countdownHint),
            disabled: arming,
            onClick: handleClick,
            'data-dsh-autorestart-sleep-button': 'true',
            'data-armed': armed ? 'true' : 'false',
            'data-wide': wide ? 'true' : 'false',
          },
          arming
            ? h('span', { className: 'dsh-autorestart-sleep-button__spinner', 'aria-hidden': 'true' })
            : moonIcon(),
          // The narrow rail has no room for a label: the icon alone, with the
          // title and the aria-label telling what it does.
          wide
            ? h(
              'span',
              { className: 'dsh-autorestart-sleep-button__label' },
              arming
                ? t('sleep.button.busy')
                : (armed ? t('sleep.button.cancel') : t('sleep.button.label')),
            )
            : null,
        )

        // A refused request is never silent: the reason is written under the
        // button.
        if (!wide || error === '') return button
        return h(
          'div',
          { className: 'dsh-autorestart-sleep-button__wrap' },
          button,
          h(
            'span',
            { className: 'dsh-autorestart-sleep-button__error', role: 'alert' },
            error,
          ),
        )
      }

      /**
       * A small sketch of the workspace with the shutdown button at the foot of
       * the left sidebar: the arrow points at the place the button appears.
       *
       * It carries no copy of its own: the words around it come from the
       * locale files.
       */
      function sleepDiagram() {
        return h(
          'svg',
          {
            className: 'dsh-autorestart-choice__diagram__art',
            viewBox: '0 0 260 120',
            width: '260',
            height: '120',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          // The window.
          h('rect', {
            x: '6',
            y: '6',
            width: '248',
            height: '108',
            rx: '10',
            fill: 'var(--dsw-alias-bg-layer-2,transparent)',
            stroke: 'var(--dsw-alias-border-l1)',
          }),
          h('line', {
            x1: '6',
            y1: '24',
            x2: '254',
            y2: '24',
            stroke: 'var(--dsw-alias-border-l1)',
          }),
          // The left sidebar.
          h('line', {
            x1: '78',
            y1: '24',
            x2: '78',
            y2: '114',
            stroke: 'var(--dsw-alias-border-l1)',
          }),
          // Two session rows in the sidebar.
          h('rect', {
            x: '16',
            y: '36',
            width: '46',
            height: '7',
            rx: '3.5',
            fill: 'var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))',
          }),
          h('rect', {
            x: '16',
            y: '50',
            width: '52',
            height: '7',
            rx: '3.5',
            fill: 'var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))',
          }),
          // The button at the foot of the sidebar, right above the Settings row.
          h('rect', {
            x: '14',
            y: '80',
            width: '52',
            height: '18',
            rx: '6',
            fill: 'var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe))',
          }),
          h(
            'g',
            { transform: 'translate(-4 45)' },
            h('path', {
              d: 'M28 44a6 6 0 0 1 8-8 6 6 0 1 0 7 7 6 6 0 0 1-8 8 6 6 0 0 1-7-7z',
              fill: 'var(--dsw-alias-bg-layer-1,#fff)',
            }),
          ),
          // The Settings row underneath it.
          h('circle', {
            cx: '20',
            cy: '107',
            r: '4.5',
            fill: 'none',
            stroke: 'var(--dsw-alias-label-secondary)',
            'stroke-width': '1.5',
          }),
          h('rect', {
            x: '30',
            y: '103',
            width: '34',
            height: '7',
            rx: '3.5',
            fill: 'var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))',
          }),
          // The arrow that points at the bottom-left corner.
          h('path', {
            d: 'M186 100 L74 92',
            fill: 'none',
            stroke: 'var(--dsw-alias-label-secondary)',
            'stroke-width': '2',
            'stroke-linecap': 'round',
            'stroke-dasharray': '5 4',
          }),
          h('path', {
            d: 'M74 92 l12-1 -5 10 z',
            fill: 'var(--dsw-alias-label-secondary)',
          }),
        )
      }

      /**
       * The whale: an inline SVG animated with CSS only.
       *
       * No external image and no dependency on another plugin: the whale is
       * drawn here, floats, blinks and blows sleepy Zs.
       */
      function whaleArt(urgent) {
        return h(
          'svg',
          {
            className: 'dsh-autorestart-whale' + (urgent ? ' dsh-autorestart-whale--urgent' : ''),
            viewBox: '0 0 200 140',
            width: '200',
            height: '140',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h(
            'g',
            { className: 'dsh-autorestart-whale__float' },
            h('path', {
              className: 'dsh-autorestart-whale__tail',
              d: 'M142 84c14-16 26-30 44-38-6 12-9 22-9 30 0 8 3 18 9 30-18-8-30-16-44-22z',
              fill: 'var(--dsw-alias-brand-primary,#4d8bf0)',
            }),
            h('ellipse', {
              className: 'dsh-autorestart-whale__body',
              cx: '84',
              cy: '84',
              rx: '66',
              ry: '38',
              fill: 'var(--dsw-alias-brand-primary,#4d8bf0)',
            }),
            h('ellipse', {
              className: 'dsh-autorestart-whale__belly',
              cx: '90',
              cy: '97',
              rx: '50',
              ry: '23',
              fill: 'var(--dsw-alias-bg-layer-1,#fff)',
              opacity: '0.85',
            }),
            h('path', {
              className: 'dsh-autorestart-whale__fin',
              d: 'M72 110c8 10 18 14 30 12-6 8-16 12-26 10-8-2-12-11-4-22z',
              fill: 'var(--dsw-alias-brand-primary,#4d8bf0)',
            }),
            h(
              'g',
              { className: 'dsh-autorestart-whale__eye' },
              h('circle', { cx: '48', cy: '74', r: '6.5', fill: 'var(--dsw-alias-bg-layer-1,#fff)' }),
              h('circle', { cx: '47', cy: '75', r: '3', fill: 'var(--dsw-alias-label-primary,#333)' }),
            ),
            h('path', {
              className: 'dsh-autorestart-whale__mouth',
              d: 'M28 88c6 6 14 8 22 6',
              fill: 'none',
              stroke: 'var(--dsw-alias-label-secondary,#888)',
              'stroke-width': '2',
              'stroke-linecap': 'round',
            }),
            h(
              'g',
              { className: 'dsh-autorestart-whale__spout' },
              h('circle', { cx: '62', cy: '38', r: '5', fill: 'var(--dsw-alias-label-secondary,#888)', opacity: '0.7' }),
              h('circle', { cx: '74', cy: '28', r: '3.5', fill: 'var(--dsw-alias-label-secondary,#888)', opacity: '0.55' }),
              h('circle', { cx: '52', cy: '26', r: '3', fill: 'var(--dsw-alias-label-secondary,#888)', opacity: '0.45' }),
            ),
          ),
          h('text', { className: 'dsh-autorestart-whale__z dsh-autorestart-whale__z--1', x: '148', y: '46' }, 'Z'),
          h('text', { className: 'dsh-autorestart-whale__z dsh-autorestart-whale__z--2', x: '166', y: '30' }, 'Z'),
          h('text', { className: 'dsh-autorestart-whale__z dsh-autorestart-whale__z--3', x: '182', y: '16' }, 'Z'),
        )
      }

      /**
       * The countdown overlay, in the shell's overlay layer.
       *
       * It renders NOTHING unless the Host really is counting down, waiting
       * for the sessions or already powering off.
       */
      function SleepOverlay() {
        const status = useSleepStatus()
        const [, setTick] = useState(0)
        // The overlay folds away locally as soon as the user cancels.
        const [hidden, setHidden] = useState(false)
        const [error, setError] = useState('')
        const [busy, setBusy] = useState(false)
        // The safety net of the "good night" screen: the user may close the
        // notice, and a screen that stays for too long offers the same exit.
        const [dismissed, setDismissed] = useState(false)
        const [stuck, setStuck] = useState(false)
        // The note of a finished rehearsal: what the host WOULD have run. It
        // folds away on its own (or when the user closes it).
        const [dryNotice, setDryNotice] = useState(null)
        const t = makeTranslate(translate)

        const phase = status && typeof status === 'object' && typeof status.phase === 'string'
          ? status.phase
          : ''

        // The last run the host reports. A REHEARSAL (dry run) says what it
        // would have done and executed nothing; a real failure says what went
        // wrong. The two never look alike, so the notice can never mistake one
        // for the other.
        const lastRun = status && typeof status === 'object' && status.lastRun && typeof status.lastRun === 'object'
          ? status.lastRun
          : null
        const dryRunAt = lastRun !== null && lastRun.dryRun === true && typeof lastRun.at === 'string'
          ? lastRun.at
          : ''
        const planned = lastRun !== null && typeof lastRun.command === 'string' && lastRun.command !== ''
          ? [lastRun.command].concat(Array.isArray(lastRun.args) ? lastRun.args : []).join(' ')
          : ''

        // The shared poll runs every 2s, but the big number has to move every
        // second: the countdown owns a local 1s tick. The interval is cleared
        // when the phase changes and when the component leaves.
        useEffect(() => {
          if (phase !== 'countdown') return undefined
          const timer = setInterval(() => setTick((value) => value + 1), 1000)
          return () => clearInterval(timer)
        }, [phase])

        // A NEW countdown always shows the overlay again: a cancellation that
        // happened earlier must never leave the layer folded away, or the next
        // countdown would run without the user being able to see (or stop) it.
        useEffect(() => {
          if (phase === 'countdown') setHidden(false)
        }, [phase])

        // A finished rehearsal leaves a note: the command it WOULD have run.
        // Without it the user would see nothing at all and could not tell a
        // rehearsal from a real shutdown. The note folds away after eight
        // seconds (or when the user closes it); a new rehearsal shows it again.
        useEffect(() => {
          if (dryRunAt === '') return undefined
          setDryNotice({ at: dryRunAt, command: planned })
          const timer = setTimeout(() => setDryNotice(null), SLEEP_DRY_RUN_NOTICE_MS)
          return () => clearTimeout(timer)
        }, [dryRunAt])

        /**
         * The time safety net of the "good night" screen.
         *
         * A machine that really powers off is killed by the system, so this
         * screen cannot last eight seconds — if it does, the command did not
         * work and the user gets a way out. The timer is cleared when the phase
         * changes and when the component leaves.
         */
        useEffect(() => {
          if (phase !== 'shutting-down') {
            setStuck(false)
            setDismissed(false)
            return undefined
          }
          const timer = setTimeout(() => setStuck(true), 8000)
          return () => clearTimeout(timer)
        }, [phase])

        // The remaining time is measured from the moment the status arrived,
        // so the number keeps ticking between two polls.
        const remainingMs = status && typeof status.remainingMs === 'number' && Number.isFinite(status.remainingMs)
          ? status.remainingMs
          : 0
        const elapsed = sleepStore.at > 0 ? Date.now() - sleepStore.at : 0
        const seconds = formatRemainingMs(Math.max(0, remainingMs - elapsed))

        // How long the countdown lasts (the settings page offers a dropdown).
        const reported = status && typeof status === 'object' && typeof status.countdownSeconds === 'number'
          ? status.countdownSeconds
          : SLEEP_DEFAULT_COUNTDOWN_SECONDS
        const countdownSeconds = SLEEP_COUNTDOWN_CHOICES.indexOf(reported) === -1
          ? SLEEP_DEFAULT_COUNTDOWN_SECONDS
          : reported
        // A countdown of zero seconds is NO countdown: the machine is switched
        // off the moment the gate opens, so there is no card to show (and no
        // whale). The waiting card takes over when the gate keeps it closed.
        const noCountdown = countdownSeconds === 0

        /**
         * Cancel the shutdown.
         *
         * The layer folds away only when the Host CONFIRMS the cancellation
         * (`phase === 'cancelled'`): a request that fails leaves the countdown
         * on screen, so the user can simply try again instead of being stuck
         * behind a machine that is still counting down.
         */
        const cancel = async () => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const body = await driveSleep('cancel')
            if (body && typeof body === 'object' && body.phase === 'cancelled') setHidden(true)
          } catch (failure) {
            // The countdown keeps running: the button can be pressed again.
            setHidden(false)
            setError(fill(t('sleep.error'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
          }
        }

        // The line that tells the user WHY the last request failed.
        const errorLine = () => (error === ''
          ? null
          : h('p', { className: 'dsh-autorestart-sleep-overlay__error', role: 'alert' }, error))

        // The Host confirmed the cancellation: the layer is gone.
        if (hidden) return null

        if (phase === 'waiting') {
          ensureSleepStyle()
          const blockers = status && Array.isArray(status.blockers) ? status.blockers : []
          // A pending restart is not a task: it is what the shutdown waits for,
          // so it is never counted as one.
          const tasks = blockers.filter((entry) => !isRestartPending(entry))
          // The count is about TASKS, not blockers: a session and its own
          // subagents are ONE task, exactly as the left sidebar counts them.
          const taskCount = countBlockerTasks(tasks)
          // How many of the tasks are carried by SUBAGENTS ONLY: the session
          // itself is idle, one of its subagents works. The card says so, so the
          // count is not read as "that many conversations".
          const subagentCount = countSubagentTasks(tasks)
          // The list of the card: the SAME rule as the bubble (the subagents of
          // one session are one item, the list is capped), so a team of a dozen
          // members does not become a dozen lines.
          const pending = blockers.filter((entry) => isRestartPending(entry))
          const grouped = summarizeBlockers(tasks, { t })
          return h(
            'div',
            {
              className: 'dsh-autorestart-sleep-waiting',
              role: 'status',
              'aria-live': 'polite',
              'data-dsh-autorestart-sleep-waiting': 'true',
              // The card never eats a click: only its cancel button does.
              style: { pointerEvents: 'none' },
            },
            h('p', { className: 'dsh-autorestart-sleep-waiting__title' }, t('sleep.waiting.title')),
            h('p', { className: 'dsh-autorestart-sleep-waiting__body' }, t('sleep.waiting.body')),
            blockers.length === 0
              ? h(
                'p',
                { className: 'dsh-autorestart-sleep-waiting__none' },
                // The Host's own message explains WHY the machine waits (the
                // grace window for work this plugin cannot see); the generic
                // line is only the fallback.
                typeof status.message === 'string' && status.message !== ''
                  ? status.message
                  : t('sleep.waiting.none'),
              )
              : h(
                'ul',
                {
                  className: 'dsh-autorestart-sleep-waiting__list',
                  // The tooltip carries the COMPLETE list: the card itself
                  // shows a short one (the same rule as the bubble).
                  title: grouped.full,
                },
                grouped.groups.slice(0, BLOCKER_SUMMARY_LIMIT).map((group, index) => h(
                  'li',
                  { key: 'blocker-' + index },
                  blockerGroupLine(group),
                )),
                grouped.groups.length > BLOCKER_SUMMARY_LIMIT
                  ? h(
                    'li',
                    { key: 'blocker-more', className: 'dsh-autorestart-sleep-waiting__more' },
                    fill(t('blockerMore'), { n: grouped.groups.length - BLOCKER_SUMMARY_LIMIT }),
                  )
                  : null,
                // A pending restart is not a task: it is what the shutdown waits
                // for, so it is never part of the grouped list.
                pending.map((entry, index) => h(
                  'li',
                  { key: 'pending-' + index },
                  blockerLine(entry),
                )),
              ),
            h('p', { className: 'dsh-autorestart-sleep-waiting__count' }, tasks.length === 0
              ? null
              : fill(t('sleep.waiting.count'), { n: taskCount })),
            subagentCount === 0
              ? null
              : h(
                'p',
                { className: 'dsh-autorestart-sleep-waiting__subagents' },
                fill(t('sleep.waiting.subagents'), { k: subagentCount }),
              ),
            errorLine(),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-sleep-waiting__cancel',
                onClick: cancel,
                disabled: busy,
                style: { pointerEvents: 'auto' },
              },
              t('sleep.waiting.cancel'),
            ),
          )
        }

        if (phase === 'countdown') {
          // A countdown of zero seconds shows NO card at all: the machine is
          // switched off the moment the gate opens, so there is nothing to
          // count down and nothing to cancel.
          if (noCountdown) return null
          ensureSleepStyle()
          const urgent = seconds <= 3
          const hint = fill(t('sleep.countdown.hint'), { n: seconds })
          return h(
            'div',
            {
              className: 'dsh-autorestart-sleep-overlay'
                + (urgent ? ' dsh-autorestart-sleep-overlay--urgent' : ''),
              role: 'dialog',
              'aria-live': 'assertive',
              'aria-label': hint,
              'data-dsh-autorestart-sleep-countdown': 'true',
              // The card is a FLOATING card: it never covers the interface and
              // it never eats a click — only its cancel button does.
              style: { pointerEvents: 'none' },
            },
            // The key changes every second, so the number restarts its pulse
            // on every tick.
            h(
              'div',
              { className: 'dsh-autorestart-sleep-overlay__number', key: 'number-' + seconds },
              String(Math.max(0, seconds)),
            ),
            whaleArt(urgent),
            h(
              'p',
              { className: 'dsh-autorestart-sleep-overlay__caption', key: 'caption-' + seconds },
              pickSleepCaption(seconds, t),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-sleep-overlay__cancel',
                onClick: cancel,
                disabled: busy,
                style: { pointerEvents: 'auto' },
              },
              t('sleep.countdown.cancel'),
            ),
            h('p', { className: 'dsh-autorestart-sleep-overlay__hint' }, hint),
            errorLine(),
          )
        }

        if (phase === 'shutting-down') {
          ensureSleepStyle()
          // The user closed the notice: the screen is gone, the Host keeps
          // whatever it thinks (this button never cancels anything).
          if (dismissed) return null
          // A dry run never powers the machine off, so the screen must say so
          // and offer the way out right away.
          const dryRun = (status && status.dryRun === true) || dryRunAt !== ''
          const closeButton = (dryRun || stuck)
            ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-sleep-overlay__cancel',
                onClick: () => setDismissed(true),
                style: { pointerEvents: 'auto' },
              },
              t('sleep.shuttingDown.dismiss'),
            )
            : null
          return h(
            'div',
            {
              className: 'dsh-autorestart-sleep-overlay dsh-autorestart-sleep-overlay--goodnight',
              role: 'status',
              'aria-live': 'assertive',
              'data-dsh-autorestart-sleep-shutdown': 'true',
              'data-dsh-autorestart-sleep-dry-run': dryRun ? 'true' : 'false',
              // The good-night card is a floating card too: it never covers the
              // interface, only its dismiss button takes clicks.
              style: { pointerEvents: 'none' },
            },
            whaleArt(false),
            h(
              'p',
              { className: 'dsh-autorestart-sleep-overlay__caption' },
              dryRun
                ? fill(t('sleep.shuttingDown.dryRun'), { command: planned })
                : t('sleep.shuttingDown.title'),
            ),
            h('p', { className: 'dsh-autorestart-sleep-overlay__hint' }, t('sleep.shuttingDown.body')),
            closeButton,
          )
        }

        // The machine is idle again. A finished rehearsal leaves its note:
        // the command it WOULD have run. A real failure has no dryRun marker
        // and therefore never ends up here (the host says so in `message`).
        if (dryNotice !== null) {
          ensureSleepStyle()
          return h(
            'div',
            {
              className: 'dsh-autorestart-sleep-waiting dsh-autorestart-sleep-dryrun',
              role: 'status',
              'aria-live': 'polite',
              'data-dsh-autorestart-sleep-dryrun': 'true',
              // The note is a FLOATING card: it never covers the interface and
              // it never eats a click — only its close button does.
              style: { pointerEvents: 'none' },
            },
            h('p', { className: 'dsh-autorestart-sleep-waiting__title' }, t('sleep.dryRun.title')),
            h('p', { className: 'dsh-autorestart-sleep-waiting__body' }, t('sleep.dryRun.body')),
            h(
              'code',
              { className: 'dsh-autorestart-sleep-dryrun__command' },
              dryNotice.command,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-sleep-waiting__cancel',
                onClick: () => setDryNotice(null),
                style: { pointerEvents: 'auto' },
              },
              t('sleep.dryRun.close'),
            ),
          )
        }

        return null
      }

      /* ------------------------------------------------------------------ *
       * The one-time announcement of a new feature.
       * ------------------------------------------------------------------ */

      // The route that reports the announcements the user has not seen yet and
      // records that it saw one. It is a sibling of the health route and shares
      // its prefix, so it is derived the very same way.
      const DEFAULT_ANNOUNCEMENTS_URL = ROUTE_PREFIX + '/announcements'

      // The feature this client half can describe. The Host may know more
      // features, but only this one has a card here.
      const ANNOUNCED_FEATURE = 'sleep'

      // A HOST THAT CANNOT RESTART (2026-11-02): its own one-time card, in the
      // same announcement ledger as the feature above — same route, same
      // "answered once per host" rule, no second mechanism.
      const ANNOUNCED_RESTART = 'restart-command'

      /**
       * The announcements the user has not seen yet.
       *
       * @returns {Promise<{ feature: string, version: string }[]>}
       */
      async function fetchAnnouncements() {
        const response = await fetch(DEFAULT_ANNOUNCEMENTS_URL, { cache: 'no-store' })
        if (!response.ok) return []
        const body = await response.json().catch(() => null)
        if (!body || typeof body !== 'object' || !Array.isArray(body.pending)) return []
        return body.pending.filter((entry) => entry && typeof entry.feature === 'string')
      }

      /**
       * The sleep status, read ONCE for the announcement.
       *
       * The card quotes the countdown length that is really in effect (it is
       * never written into the copy) and says whether the moon button is
       * switched on.
       *
       * @returns {Promise<object|null>}
       */
      async function fetchSleepStatusOnce() {
        try {
          const response = await fetch(DEFAULT_SLEEP_URL, { cache: 'no-store' })
          if (!response.ok) return null
          const body = await response.json().catch(() => null)
          return body && typeof body === 'object' ? body : null
        } catch {
          return null
        }
      }

      /**
       * Tell the Host that the user has seen the announcement of a feature.
       *
       * @param {string} feature
       * @returns {Promise<boolean>} true when the Host recorded it
       */
      async function acknowledgeAnnouncement(feature) {
        const response = await fetch(DEFAULT_ANNOUNCEMENTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ feature }),
        })
        return response.ok === true
      }

      // The look of the card follows the install prompt: one heading, three
      // lines of copy and one button. Only theme tokens are used, so light and
      // dark themes both work.
      const ANNOUNCEMENT_STYLE_ID = 'dsh-autorestart-announcement'
      const ANNOUNCEMENT_CSS = [
        '.dsh-autorestart-announcement{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:6px;',
        '  width:min(560px,94vw);',
        '  max-width:100%;',
        '  box-sizing:border-box;',
        '  margin:0 0 6px;',
        '  padding:14px 16px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:12px;',
        '  background:var(--dsw-alias-bg-layer-1);',
        '  box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 20%, transparent);',
        '  color:var(--dsw-alias-label-secondary);',
        '  font-size:13px;',
        '  line-height:18px;',
        '}',
        '.dsh-autorestart-announcement h3{',
        '  margin:0;',
        '  font-size:14px;',
        '  font-weight:600;',
        '  line-height:20px;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-announcement p{margin:0;overflow-wrap:anywhere;}',
        '.dsh-autorestart-announcement__note{',
        '  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));',
        '}',
        '.dsh-autorestart-announcement__error{',
        '  color:var(--dsw-alias-state-error-fg,var(--dsw-alias-label-secondary));',
        '}',
        '.dsh-autorestart-announcement__cta{',
        '  align-self:flex-start;',
        '  margin-top:4px;',
        '  padding:5px 14px;',
        '  border:none;',
        '  border-radius:var(--dsw-radius-md,8px);',
        '  background:var(--dsw-alias-brand-primary,#5b8def);',
        '  color:var(--dsw-alias-label-on-primary,#fff);',
        '  font:inherit;',
        '  font-size:13px;',
        '  line-height:20px;',
        '  cursor:pointer;',
        '}',
        '.dsh-autorestart-announcement__cta:disabled{',
        '  opacity:.6;',
        '  cursor:default;',
        '}',
        '.dsh-autorestart-announcement__cta:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
        // THE CARD THAT FITS ITS TEXT (user report, 2026-11-06).
        //
        // The card above is a fixed 560px wide, which is right for a card with
        // three lines of copy. The leftovers card has one or two short lines,
        // and in a wide window that left a long empty band to the right of the
        // text — the "floating window" the user complained about.
        //
        // So this card takes the width of its own text (up to about forty
        // Chinese characters) and sits on the left, like the text in it.
        '.dsh-autorestart-announcement--fit{',
        '  width:auto;',
        '  max-width:min(40em,94vw);',
        '  align-self:flex-start;',
        '}',
      ].join('\n')

      /**
       * Inject the announcement styles exactly once. The id keeps a second
       * injection from duplicating the rule.
       */
      function ensureAnnouncementStyle() {
        if (typeof document === 'undefined' || !document.head) return
        try {
          if (document.getElementById(ANNOUNCEMENT_STYLE_ID)) return
          const style = document.createElement('style')
          style.id = ANNOUNCEMENT_STYLE_ID
          style.textContent = ANNOUNCEMENT_CSS
          document.head.appendChild(style)
        } catch {
          // Without the stylesheet the card is still readable, just plainer.
        }
      }

      /**
       * The one-time card that announces a new feature.
       *
       * The install prompt only ever reaches a FRESH installation, so an
       * installation that already existed would never learn about the new moon
       * button — the feature would simply not exist for it. This card is that
       * missing half: the Host reports the announcements the user has not seen
       * yet, and the card disappears for good when the user presses "知道了".
       *
       * It is an ordinary block in the composer dock (the same place as the
       * install prompt): it never covers the interface, it never touches the
       * countdown, and it stays until the user answers it. An unanswered
       * announcement comes back with the next start — it is never swallowed
       * silently.
       */
      function FeatureAnnouncementPanel() {
        const [state, setState] = useState({ loaded: false, pending: [], status: null, error: '' })
        const [busy, setBusy] = useState(false)
        const t = makeTranslate(translate)

        useEffect(() => {
          let cancelled = false
          // The install prompt owns the dock while it is unanswered: a fresh
          // installation must never get two prompts at once.
          if (backupChoicePending() || sleepChoicePending()) return undefined
          const load = async () => {
            let pending = []
            let status = null
            try {
              const [announced, sleepStatus] = await Promise.all([
                fetchAnnouncements(),
                fetchSleepStatusOnce(),
              ])
              pending = announced
              status = sleepStatus
            } catch {
              // A failed request shows nothing: the announcement comes back
              // with the next start (it is never swallowed silently).
            }
            if (cancelled) return
            setState({ loaded: true, pending, status, error: '' })
          }
          void load()
          return () => { cancelled = true }
        }, [])

        /**
         * The "知道了" button: the Host records the announcement and the card
         * disappears. A refused request keeps the card (with the reason), so
         * the announcement is never lost.
         */
        const acknowledge = () => {
          if (busy) return
          setBusy(true)
          setState((current) => ({ ...current, error: '' }))
          void (async () => {
            try {
              const recorded = await acknowledgeAnnouncement(ANNOUNCED_FEATURE)
              if (!recorded) throw new Error('the Host refused the announcement')
            } catch (failure) {
              setBusy(false)
              setState((current) => ({
                ...current,
                error: fill(t('announcement.error'), { message: describeError(failure) }),
              }))
              return
            }
            setBusy(false)
            setState((current) => ({
              ...current,
              pending: current.pending.filter((entry) => entry.feature !== ANNOUNCED_FEATURE),
            }))
          })()
        }

        if (!state.loaded) return null
        const entry = state.pending.find((item) => item && item.feature === ANNOUNCED_FEATURE)
        if (!entry) return null

        // The countdown length is read from the Host, never written into the
        // copy: the card always quotes what is really in effect.
        const seconds = state.status && typeof state.status.countdownSeconds === 'number'
          ? state.status.countdownSeconds
          : null
        const hidden = Boolean(state.status && state.status.showSleepButton === false)
        ensureAnnouncementStyle()

        return h(
          'div',
          {
            className: 'dsh-autorestart-announcement',
            role: 'status',
            'data-dsh-autorestart-announcement': 'true',
            'data-dsh-autorestart-announcement-feature': ANNOUNCED_FEATURE,
          },
          h('h3', { className: 'dsh-autorestart-announcement__title' }, t('announcement.title')),
          h('p', { className: 'dsh-autorestart-announcement__line' }, t('announcement.line1')),
          h(
            'p',
            { className: 'dsh-autorestart-announcement__line' },
            seconds === null
              ? t('announcement.line2.generic')
              : fill(t('announcement.line2'), { n: seconds }),
          ),
          h('p', { className: 'dsh-autorestart-announcement__line' }, t('announcement.line3')),
          hidden
            ? h('p', { className: 'dsh-autorestart-announcement__note' }, t('announcement.disabled'))
            : null,
          state.error === ''
            ? null
            : h('p', { className: 'dsh-autorestart-announcement__error', role: 'alert' }, state.error),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-announcement__cta',
              'data-dsh-autorestart-announcement-ack': 'true',
              disabled: busy,
              onClick: acknowledge,
            },
            t('announcement.button'),
          ),
        )
      }

      /**
       * THE LEFTOVERS OF AN OLDER BUILD — asked ONCE, gone for good (2026-11-06).
       *
       * The Host counts the directories under the backups root that carry NO
       * manifest: a copy that never finished. On the real machine there were
       * 105 of them (23 966 MB), and every restart tried to delete them again.
       *
       * THE CARD IS NOT A SETTINGS ENTRY AND NOT A BANNER. It appears only when
       * the Host says there is something to decide, it offers exactly two
       * answers ("delete them" / "I will handle them myself"), and after the
       * answer it is gone: nothing of it is left on the screen, and the
       * question never comes back — not with the next boot, not with the next
       * release. The leftovers are a leftover of an old build, not a permanent
       * feature of the interface.
       *
       * It sits in the composer dock, like the announcement: it never covers
       * the interface and never touches the countdown.
       */
      const DEFAULT_SHELL_BACKUPS_URL = ROUTE_PREFIX + '/shell-backups'

      /**
       * What the Host knows about the leftovers.
       *
       * @returns {Promise<object|null>} null when the Host cannot be asked
       */
      async function fetchShellBackups() {
        try {
          const response = await fetch(DEFAULT_SHELL_BACKUPS_URL, { cache: 'no-store' })
          if (!response.ok) return null
          const body = await response.json().catch(() => null)
          return body && typeof body === 'object' ? body : null
        } catch {
          return null
        }
      }

      /**
       * Give the Host one of the two answers.
       *
       * @param {string} action 'clean' or 'self'
       * @returns {Promise<object>} the Host's answer
       */
      async function answerShellBackups(action) {
        const response = await fetch(DEFAULT_SHELL_BACKUPS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || !body || body.ok !== true) {
          // A MARKED REFUSAL, NOT A SENTENCE (2026-11-06): the card shows the
          // text of the user's own language. A Chinese user must never read an
          // English fallback.
          const failure = new Error('shell-backups-refused')
          failure.refused = true
          throw failure
        }
        return body
      }

      function ShellBackupsPanel() {
        const [state, setState] = useState({
          loaded: false,
          pending: false,
          count: 0,
          bytes: null,
          truncated: false,
          working: false,
          // WHICH ACTION IS IN FLIGHT (2026-11-07): the card says what it is
          // doing — 「正在清理…」 or 「正在记下来…」.
          workingFor: '',
          // THE ANSWER OF THE CLICK: the old host carries the result in it,
          // and the receipt of a cleanup that the new host is still running is
          // read out of it when the job is done.
          answer: null,
          note: '',
          error: '',
        })
        const [busy, setBusy] = useState(false)
        // IS THE PAGE ON THE SCREEN? (2026-11-07): a card that vanishes while
        // nobody looks at it is a sentence the user never reads.
        const [visible, setVisible] = useState(
          () => !(typeof document !== 'undefined' && document.hidden === true),
        )
        const t = makeTranslate(translate)

        /**
         * THE TEXT OF A RECEIPT — out of whatever the Host answered.
         *
         * @param {object|null} payload an answer of the click or of a GET
         * @returns {{ note: string, error: string }}
         */
        const receiptText = (payload) => {
          const receipt = shellCleanupReceipt(payload)
          return {
            note: receipt.removed > 0
              ? fill(t('shellBackups.cleaned'), {
                count: String(receipt.removed),
                size: formatShellSize(receipt.freedBytes),
              })
              : t('shellBackups.cleanedNothing'),
            error: receipt.failures.length > 0
              ? fill(t('shellBackups.failed'), {
                count: String(receipt.failures.length),
                reason: receipt.failures
                  .map((entry) => (entry && entry.name ? entry.name : ''))
                  .filter((name) => name !== '')
                  .join(', '),
              })
              : '',
          }
        }

        // THE WATCH OF THE LEFTOVERS (2026-11-07): THE CARD MUST COME BY
        // ITSELF. The page is usually already open when the leftovers show up
        // (the boot sweep is what found them), and a user does not press
        // "refresh" — for a user there is no such thing. So the panel watches:
        // one check at once, then one every five seconds, and nothing at all
        // while the page is hidden.
        const watcherRef = useRef(null)

        useEffect(() => {
          const watcher = createShellBackupsWatcher({
            fetchStatus: fetchShellBackups,
            onStatus: (body) => {
              setState((current) => shellBackupsStatus(current, body))
            },
            // THE PAGE IS NOT ON THE SCREEN: nobody sees a card that is not
            // there, so the watch waits for the visibility event.
            isVisible: () => !(typeof document !== 'undefined' && document.hidden === true),
            schedule: (fn, ms) => setTimeout(fn, ms),
            cancel: (id) => clearTimeout(id),
          })
          watcherRef.current = watcher
          watcher.start()
          const onVisibility = () => { watcher.resume() }
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibility)
          }
          return () => {
            if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
              document.removeEventListener('visibilitychange', onVisibility)
            }
            watcher.stop()
            watcherRef.current = null
          }
        }, [])

        /**
         * THE ANSWER IS GIVEN: THE WATCH IS OVER.
         *
         * The user answered, so the question must not come back — and the
         * panel must not keep asking the Host either.
         */
        const stopWatch = () => {
          const watcher = watcherRef.current
          if (watcher && typeof watcher.stop === 'function') watcher.stop()
        }

        // THE PAGE CAME BACK OR WENT AWAY (2026-11-07).
        useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onVisibility = () => {
            setVisible(!(typeof document !== 'undefined' && document.hidden === true))
          }
          document.addEventListener('visibilitychange', onVisibility)
          return () => document.removeEventListener('visibilitychange', onVisibility)
        }, [])

        // THE CARD GOES AWAY BY ITSELF (2026-11-07): the user pressed a button,
        // the work is done, and the card has nothing left to say. THREE seconds
        // for the receipt, TEN for an error — three seconds would swallow a
        // sentence before it was read.
        //
        // THE CLOCK STARTS WHEN THE WORDS REALLY APPEAR: while the cleanup is
        // running there is nothing to count, and a card that vanished during
        // the work would look like a button that does nothing.
        //
        // AND IT ONLY RUNS WHILE THE PAGE IS ON THE SCREEN: the card must not
        // disappear where nobody can read it.
        useEffect(() => {
          if (state.working === true) return undefined
          const hasReceipt = typeof state.note === 'string' && state.note !== ''
          const hasError = typeof state.error === 'string' && state.error !== ''
          if (hasReceipt !== true && hasError !== true) return undefined
          if (visible !== true) return undefined
          const timer = setTimeout(() => {
            setState((current) => ({ ...current, note: '', error: '' }))
          }, hasError === true ? SHELL_CARD_ERROR_MS : SHELL_CARD_RECEIPT_MS)
          // THE TIMER DIES WITH THE CARD: a card that is taken off the screen
          // (the session changed, the panel was unmounted) must not fire later
          // and pop up somewhere else.
          return () => clearTimeout(timer)
        }, [state.note, state.error, state.working, visible])

        /**
         * THE CLEANUP RUNS IN THE BACKGROUND (2026-11-06).
         *
         * The Host answers the click at once and deletes in batches, so this
         * card polls for the receipt instead of waiting inside a fetch that
         * would time out on 23 GB of deletion.
         */
        useEffect(() => {
          if (state.working !== true) return undefined
          const startedAt = Date.now()
          const timer = setInterval(() => {
            void (async () => {
              try {
                const body = await fetchShellBackups()
                if (!body) return
                if (shellCleanupFinished(body) !== true) {
                  // NOT DONE YET — and the card must NOT wait for ever: after the
                  // ceiling it says that the result may still be on its way.
                  if (shellCleanupTimedOut(startedAt, Date.now()) === true) {
                    setState((current) => ({
                      ...current,
                      working: false,
                      workingFor: '',
                      note: t('shellBackups.maybeLater'),
                    }))
                  }
                  return
                }
                // THE RECEIPT: out of the job of the new host, out of the answer
                // of the click for the old one (whose GET has no job at all).
                const receipt = receiptText(shellCleanupJob(body) ?? state.answer ?? {})
                setState((current) => ({
                  ...current,
                  working: false,
                  workingFor: '',
                  pending: false,
                  note: receipt.note,
                  error: receipt.error,
                }))
              } catch (failure) {
                // A POLL THAT THROWS IS A MESSAGE, NOT A SILENCE (2026-11-07):
                // the card says what happened instead of spinning for ever.
                setState((current) => ({
                  ...current,
                  working: false,
                  workingFor: '',
                  error: shellCleanupFailureText(failure, t),
                }))
              }
            })()
          }, SHELL_CLEANUP_POLL_MS)
          return () => clearInterval(timer)
        }, [state.working])

        /** 「清理掉」: the leftovers go now, and the receipt says what happened. */
        const clean = () => {
          if (busy) return
          // THE ANSWER IS GIVEN: NO MORE CHECKS.
          stopWatch()
          setBusy(true)
          // THE CLICK MUST BE SEEN (2026-11-07): the card says 「正在清理…」 and
          // the two buttons are disabled AT ONCE. A click that shows nothing at
          // all looks like a broken button — that is what the user reported.
          setState((current) => ({ ...current, error: '', working: true, workingFor: 'clean' }))
          void (async () => {
            try {
              const body = await answerShellBackups('clean')
              if (shellCleanupAnswerIsFinal(body) === true) {
                // THE OLD HOST: the answer IS the receipt. The cleanup is done
                // (it always was — it took milliseconds), so the card shows
                // the result NOW instead of spinning on "清理中" for ever.
                const receipt = receiptText(body)
                setState((current) => ({
                  ...current,
                  pending: false,
                  working: false,
                  workingFor: '',
                  answer: body,
                  note: receipt.note,
                  error: receipt.error,
                }))
                return
              }
              // THE NEW HOST: the delete runs in the background, and the
              // receipt comes with a later GET — but only up to the ceiling.
              setState((current) => ({
                ...current,
                // THE QUESTION IS GONE: the answer is final, so the card does
                // not offer the two buttons any more — it waits for the
                // receipt.
                pending: false,
                working: true,
                workingFor: 'clean',
                answer: body,
              }))
            } catch (failure) {
              // A REFUSAL OR A BROKEN CONNECTION IS A MESSAGE, NOT A SILENCE
              // (2026-11-07): the question stays open, the card says what
              // happened, and the user may press the button again.
              setState((current) => ({
                ...current,
                pending: true,
                working: false,
                workingFor: '',
                error: shellCleanupFailureText(failure, t),
              }))
            }
            setBusy(false)
          })()
        }

        /** 「我自己处理」: the user takes over and the question is never asked again. */
        const self = () => {
          if (busy) return
          // THE ANSWER IS GIVEN: NO MORE CHECKS.
          stopWatch()
          setBusy(true)
          // THE CLICK MUST BE SEEN (2026-11-07): the card says what it is
          // doing, at once — a click that shows nothing looks broken.
          setState((current) => ({ ...current, error: '', working: true, workingFor: 'self' }))
          void (async () => {
            try {
              await answerShellBackups('self')
              setState((current) => ({
                ...current,
                pending: false,
                working: false,
                workingFor: '',
                note: t('shellBackups.selfDone'),
              }))
            } catch (failure) {
              // A REFUSAL OR A BROKEN CONNECTION IS A MESSAGE, NOT A SILENCE
              // (2026-11-07): the question stays open and the card says what
              // happened.
              setState((current) => ({
                ...current,
                pending: true,
                working: false,
                workingFor: '',
                error: shellCleanupFailureText(failure, t),
              }))
            }
            setBusy(false)
          })()
        }

        // NOTHING TO SAY: no leftovers, or the user already answered. The card
        // does not exist then — not as an empty box, not as a greyed-out entry.
        if (shellBackupsCardVisible(state) !== true) return null
        ensureAnnouncementStyle()

        const rows = []
        const actions = []
        try {
          if (state.pending) {
            rows.push(h('h3', { className: 'dsh-autorestart-announcement__title' }, t('shellBackups.title')))
            rows.push(h('p', { className: 'dsh-autorestart-announcement__line' }, state.bytes === null
              ? fill(t('shellBackups.line1.noSize'), { count: String(state.count) })
              : fill(t('shellBackups.line1'), {
                count: String(state.count),
                size: formatShellSize(state.bytes),
              })))
            rows.push(h('p', { className: 'dsh-autorestart-announcement__line' }, t('shellBackups.line2')))
          }
          if (state.working === true) {
            rows.push(h('p', { className: 'dsh-autorestart-announcement__note' }, state.workingFor === 'self'
              ? t('shellBackups.workingSelf')
              : t('shellBackups.working')))
          }
          if (state.note !== '') {
            rows.push(h('p', { className: 'dsh-autorestart-announcement__note' }, state.note))
          }
          if (state.error !== '') {
            rows.push(h('p', { className: 'dsh-autorestart-announcement__error', role: 'alert' }, state.error))
          }
          if (state.pending) {
            actions.push(h('button', {
              type: 'button',
              className: 'dsh-autorestart-announcement__cta',
              'data-dsh-autorestart-shell-backups': 'clean',
              disabled: busy,
              onClick: clean,
            }, t('shellBackups.clean')))
            actions.push(h('button', {
              type: 'button',
              className: 'dsh-autorestart-announcement__cta',
              'data-dsh-autorestart-shell-backups': 'self',
              disabled: busy,
              onClick: self,
            }, t('shellBackups.self')))
          }
        } catch (failure) {
          // A CARD THAT THROWS WHILE IT DRAWS MUST STILL SAY SOMETHING
          // (2026-11-07): the user may not be left with a vanished card — or a
          // black screen — and no word about it.
          rows.length = 0
          actions.length = 0
          rows.push(h('p', {
            className: 'dsh-autorestart-announcement__error',
            role: 'alert',
          }, t('shellBackups.error.broken')))
        }

        return h(
          'div',
          {
            className: 'dsh-autorestart-announcement dsh-autorestart-announcement--fit',
            role: 'status',
            'data-dsh-autorestart-shell-backups': 'true',
          },
          rows,
          actions,
        )
      }

      /**
       * The single-plugin restore: the button in the plugin-failure panel.
       *
       * `POST /plugin-restore` with `{ "plugin": "<name>" }` puts THAT ONE
       * plugin back from the last known-good backup. The Host answers with
       * `ok:false` + a reason for "no backup" / "could not copy" — and it says
       * so with HTTP 200, because that is an answer, not a server error.
       */
      const DEFAULT_PLUGIN_RESTORE_URL = ROUTE_PREFIX + '/plugin-restore'

      /**
       * WHERE "the user said 知道了" IS REMEMBERED.
       *
       * One key, holding the FINGERPRINT of the report that was dismissed — not
       * a boolean. That is the whole point: a boolean would silence a real
       * failure forever, while a fingerprint only silences the boot that wrote
       * that report. The next start writes a new report (new `at`) and the panel
       * comes back by itself.
       */
      const PLUGIN_FAILURE_DISMISS_KEY = 'dsh-autorestart.plugin-failure.dismissed'

      async function restorePluginOnce(plugin) {
        const response = await fetch(DEFAULT_PLUGIN_RESTORE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plugin }),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const body = await response.json()
        if (!body || typeof body !== 'object') throw new Error('the Host sent no answer')
        return body
      }

      /**
       * THE PLUGIN THAT DID NOT LOAD — the popup the user asked for.
       *
       * WHY IT EXISTS: the host ALREADY survives a broken plugin (measured: 22 s
       * on the desktop, 2.0–2.6 s on hosted `dsh web`, profile untouched, no
       * repeated restarts under the supervisor), so the plugin no longer
       * restores anything by itself at boot. What was missing was the OTHER
       * half: the user finding out. This panel says which plugin did not
       * activate and what error it reported, and offers exactly one action —
       * "put THIS one plugin back from the last backup".
       *
       * It is an ordinary block in the composer dock (the same place as the
       * install prompt and the announcement): it never covers the interface and
       * never touches the countdown. It is not dismissible by hiding a problem:
       * it disappears when the plugin loads again (a new boot with a clean log,
       * which clears the report).
       */
      /**
       * WHAT THE PANEL MAY SAY, AND NOTHING MORE.
       *
       * Two facts, kept apart on purpose:
       *   - "these functions did not come up this time" - the watch compared this
       *     boot with the previous one and something is gone. A hard fact.
       *   - "these plugins differ from the backup" - a lead, not a verdict: the
       *     files changed, which may simply mean an upgrade.
       *
       * It never says a plugin is broken or failed to load: nothing here can know
       * that. Interface module names are reported as ONE number and never as
       * plugin names (they are things like \`batches\`, not plugins).
       */


      /**
       * THE FLOATING CARD.
       *
       * The panels used to sit in `conversation.input.dock`, which is part of the
       * layout flow: the message column was pushed up and the text ran straight
       * into the conversation with no edge of its own. Declaring the frame here
       * means every panel draws the same card, whatever the page CSS does.
       */
      // THE CARD'S OWN PAINT (2026-11-01).
      //
      // Hard-coded, OPAQUE colours on purpose. The first version used
      // `var(--dsh-surface, #fff)`, and when the theme does not define that
      // variable the card was drawn with no background at all - on the real
      // machine the text simply sat in the conversation, indistinguishable from
      // the messages around it.
      // THE ANCHOR THAT TAKES NO SPACE.
      //
      // `position: fixed` does NOT mean "relative to the viewport" when any
      // ancestor has `transform`, `filter`, `perspective` or `will-change`: the
      // card then anchors to that ancestor and stays in its layout, which is why
      // the conversation was pushed up. This wrapper is ZERO-sized and the card
      // hangs out of it with `position: absolute`, so the flow never sees it, no
      // matter what the host puts above us.
      /**
       * THE CARD, AS A REAL COMPONENT.
       *
       * It has to be a component (not a plain helper) because it now MEASURES
       * itself: the card renders a line with its own computed style, so a single
       * screenshot says which layer is broken - the inline style not applied, an
       * ancestor overriding it, or the portal never happening.
       *
       * Every painting property is inline and hard-coded: no className, no CSS
       * variable. Inline wins over every stylesheet rule, so if the card still
       * comes out unstyled the reason is not CSS specificity.
       */
      // A quiet line under the buttons. The panel is the door; the settings page
      // is where you come back later if you change your mind.
      function overlayHint(text) {
        return h('p', {
          key: 'overlay-hint',
          'data-dsh-autorestart-hint': '1',
          style: {
            margin: '2px 0 0',
            color: 'var(--dsw-alias-label-tertiary, #888888)',
            fontSize: '11px',
            lineHeight: '1.4',
          },
        }, text)
      }

      function OverlayCard(props) {
        const id = props ? props.id : 'overlay'
        const title = props ? props.title : ''
        const onClose = props && typeof props.onClose === 'function' ? props.onClose : () => {}
        const rows = props && Array.isArray(props.rows) ? props.rows : []
        // CARD-LEVEL ACTIONS LIVE IN THE HEADER (user report, 2026-11-02): buttons
        // that apply to the WHOLE card used to sit at the bottom of the list, so
        // they looked like they belonged to the last item in it. The header owns
        // them now — title on the left (it truncates), actions on the right.
        const actions = props && Array.isArray(props.actions) ? props.actions : []
        const header = h('div', {
          key: 'overlay-header',
          'data-dsh-autorestart-overlay-header': id,
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            flexWrap: 'nowrap',
          },
        },
        h('strong', {
          key: 'overlay-title',
          style: {
            flex: '1 1 auto',
            minWidth: '0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '14px',
            lineHeight: '1.4',
            color: 'var(--dsw-alias-label-primary, #111111)',
          },
        }, title),
        h('div', {
          key: 'overlay-actions',
          'data-dsh-autorestart-overlay-actions': id,
          style: {
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flexWrap: 'nowrap',
          },
        },
        actions,
        h('button', {
          type: 'button',
          key: 'overlay-close',
          title: translate('pluginFailure.close'),
          'aria-label': translate('pluginFailure.close'),
          onClick: onClose,
          style: {
            flex: '0 0 auto',
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.22))',
            borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            color: 'var(--dsw-alias-label-primary, #111111)',
            fontSize: '16px',
            lineHeight: '1',
            padding: '2px 8px',
          },
        }, '\u00d7')))

        const body = [header, ...rows]

        const card = h('div', {
          key: id,
          'data-dsh-autorestart-overlay': id,
          style: {
            position: "fixed",
            left: '24px',
            bottom: '24px',
            width: 'min(560px, calc(100vw - 48px))',
            maxHeight: 'min(70vh, 640px)',
            overflowY: 'auto',
            boxSizing: 'border-box',
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            backgroundColor: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.22))',
            borderRadius: '12px',
            boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
            padding: '14px 16px',
            zIndex: 2147483000,
            color: 'var(--dsw-alias-label-primary, #111111)',
            font: 'inherit',
            textAlign: 'left',
            lineHeight: '1.5',
            fontSize: '13px',
          },
        }, body)

        return card
      }

      function overlayCard(id, title, onClose, rows) {
        return h(OverlayCard, { key: 'overlay-' + id, id, title, onClose, rows })
      }

      const SETTINGS_STYLE = {
        section: {
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          padding: '14px 16px',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #111111)',
          border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.18))',
          borderRadius: '12px',
          font: 'inherit',
          textAlign: 'left',
          lineHeight: '1.5',
          fontSize: '13px',
        },
        description: { color: 'var(--dsw-alias-label-secondary, #666666)', fontSize: '12px' },
        button: {
          alignSelf: 'flex-start',
          cursor: 'pointer',
          padding: '6px 14px',
          borderRadius: '8px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.22))',
          background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
          color: 'var(--dsw-alias-label-primary, #111111)',
          font: 'inherit',
          fontSize: '13px',
        },
        restoreButton: {
          cursor: 'pointer',
          padding: '3px 10px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.22))',
          background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
          color: 'var(--dsw-alias-label-primary, #111111)',
          font: 'inherit',
          fontSize: '12px',
        },
        list: {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          margin: 0,
          padding: 0,
          listStyle: 'none',
        },
        row: {
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          alignItems: 'center',
          gap: '10px',
          padding: '6px 8px',
          borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-2, #f7f7f7)',
        },
        name: { fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all' },
        status: { color: 'var(--dsw-alias-label-secondary, #666666)', fontSize: '12px', whiteSpace: 'nowrap' },
        hint: {
          gridColumn: '1 / -1',
          color: 'var(--dsw-alias-label-tertiary, #888888)',
          fontSize: '11px',
          lineHeight: '1.4',
        },
        note: { color: 'var(--dsw-alias-state-warn-label, #a15c00)', fontSize: '12px' },
      }

      /**
       * THE SETTINGS PAGE (plugins.bundle.config).
       *
       * Everything here is on demand: nothing talks to the inventory route until
       * the user presses the button. "Check now" really re-requests the route -
       * it does not re-render whatever the last reading was.
       */
      function SettingsPanel() {
        const info = useSharedInfo(true)
        const t = makeTranslate(translate)

        const items = []
        items.push(h('strong', { key: 'settings-title' }, 'dsh-autorestart'))
        items.push(h('p', { key: 'settings-description', style: SETTINGS_STYLE.description }, t('settings.description')))

        return h('section', { 'data-dsh-autorestart-settings': 'dsh-autorestart', style: SETTINGS_STYLE.section }, items)
      }

      function PluginFailurePanel() {
        const info = useSharedInfo(true)
        const [loaded, setLoaded] = useState(null)
        const [judgedHere, setJudgedHere] = useState(false)
        const [busy, setBusy] = useState('')
        const [note, setNote] = useState('')
        const [dismissed, setDismissed] = useState(() => {
          try {
            return window.localStorage.getItem(PLUGIN_FAILURE_DISMISS_KEY) || ''
          } catch {
            return ''
          }
        })
        const t = makeTranslate(translate)

        // The pure helpers live in the second module and are reachable through
        // the global namespace, like `buildPluginFailureModel` above.
        const helpers = globalThis.__dshAutorestartClient
        const build = helpers && typeof helpers.buildPluginFailureModel === 'function'
          ? helpers.buildPluginFailureModel
          : null
        const bootIdOf = helpers && typeof helpers.pluginFailureBootId === 'function'
          ? helpers.pluginFailureBootId
          : () => ''
        const judgedKeyOf = helpers && typeof helpers.pluginFailureJudgedKey === 'function'
          ? helpers.pluginFailureJudgedKey
          : () => PLUGIN_FAILURE_DISMISS_KEY
        const fingerprintOf = helpers && typeof helpers.pluginFailureFingerprint === 'function'
          ? helpers.pluginFailureFingerprint
          : () => ''

        // WHICH PROFILE THIS HOST IS (user report, 2026-11-05). The restore
        // command has to name a REAL profile — `--profile <profile>` is a
        // placeholder the user cannot copy and run. The Host answers with the
        // profile DIRECTORY and the name is its last segment (`web` on the
        // hosted instance, `desktop` on the desktop build).
        //
        // IT IS READ AT RENDER TIME, NOT AT MOUNT TIME: the shared payload may
        // still be on its way when the panel mounts, and the command is drawn
        // from whatever the payload says NOW.
        const profileName = helpers && typeof helpers.pluginFailureProfileName === 'function'
          ? helpers.pluginFailureProfileName(info)
          : ''

        // WHICH BOOT IS THIS? (user decision, 2026-11-02.) This card reports the
        // RESULT of a restart, so the boot identity — not the passing time —
        // decides when it may appear: `bootId` when the Host sends one,
        // `generation` when it does not (see pluginFailureBootId).
        const bootId = bootIdOf(info)
        const judgedKey = judgedKeyOf(bootId)

        /** The record an earlier judgement of a boot left behind, or null. */
        const judgedRecord = (key) => {
          try {
            const stored = window.localStorage.getItem(key)
            return stored === null || stored === '' ? null : stored
          } catch {
            return null
          }
        }

        // THE JUDGEMENT IS THE RESTART EVENT, NOT A LIVE READING. Two requests,
        // once, on the first mount of this boot — no polling, and nothing that
        // re-runs when the shared payload refreshes. The effect is keyed on the
        // boot identity alone, so a page refresh inside the same boot does not
        // judge again, and the next boot does.
        useEffect(() => {
          if (judgedRecord(judgedKey) !== null) return undefined
          let alive = true
          const get = async (url) => {
            try {
              const response = await fetch(url, { headers: { accept: 'application/json' } })
              if (!response || response.ok !== true) return null
              return await response.json()
            } catch {
              return null
            }
          }
          void (async () => {
            const watch = await get(pluginWatchUrlFor(info))
            const inventory = await get(pluginInventoryUrlFor(info))
            if (alive !== true) return
            // THE RECORD IS WRITTEN EVEN WHEN THERE IS NOTHING TO REPORT: "this
            // boot was judged" is the whole point, so a file that changes later
            // in the same boot cannot make the card appear out of nowhere.
            const modelNow = build === null ? null : build({ watch, inventory, profile: profileName })
            try {
              window.localStorage.setItem(judgedKey, JSON.stringify({
                at: Date.now(),
                boot: bootId,
                fingerprint: fingerprintOf(modelNow),
              }))
            } catch {}
            setJudgedHere(true)
            setLoaded({ watch, inventory })
          })()
          return () => { alive = false }
        }, [judgedKey])

        // AN EARLIER MOUNT OF THIS BOOT ALREADY JUDGED: nothing to show, and
        // nothing to ask the Host either (the effect above returned early).
        if (!judgedHere && judgedRecord(judgedKey) !== null) return null

        if (loaded === null || build === null) return null
        const model = build({ watch: loaded.watch, inventory: loaded.inventory, profile: profileName })
        if (model === null) return null

        // The fingerprint is WHICH report this is (which plugins did not come up),
        // so dismissing silences this one for the rest of the boot; the boot record
        // keeps it silent even after a page refresh.
        const fingerprint = (model.certain || []).map((entry) => entry.name).sort().join(',')
        if (dismissed !== '' && dismissed === fingerprint) return null
        ensureAnnouncementStyle()

        const restore = (plugin) => {
          if (busy !== '') return
          setBusy(plugin)
          setNote('')
          void (async () => {
            try {
              const restored = await restorePluginOnce(plugin)
              setNote(fill(t('pluginFailure.restored'), { plugin, at: '' }))
              if (restored && restored.ok !== true) setNote(fill(t('pluginFailure.failed'), { plugin, reason: '' }))
            } catch (failure) {
              setNote(fill(t('pluginFailure.failed'), { plugin, reason: describeError(failure) }))
            }
            setBusy('')
          })()
        }
        // DISMISS IS BOOT-SCOPED TOO (user decision, 2026-11-02): the record for
        // this boot already exists (it is written at judgement time), so the card
        // stays away for the rest of the boot — including after a page refresh —
        // and the next boot judges again. The fingerprint is stored as well so a
        // single report can be silenced without silencing the boot.
        // «全部恢复» needs no extra work for the same reason: it acts on the
        // judgement that this boot already made.
        const dismiss = () => {
          setDismissed(fingerprint)
          try { window.localStorage.setItem(PLUGIN_FAILURE_DISMISS_KEY, fingerprint) } catch {}
          try {
            if (judgedRecord(judgedKey) === null) {
              window.localStorage.setItem(judgedKey, JSON.stringify({ at: Date.now(), boot: bootId, fingerprint }))
            }
          } catch {}
        }

        const rows = []
        const line = (key, text) => rows.push(h('p', { className: 'dsh-autorestart-announcement__line', key }, text))

        // NO SECOND TITLE LINE (user report, 2026-11-02): the card header already
        // says what the card is about, and repeating it as the first paragraph
        // made the panel look like it had two headings.
        //
        // THE HEADER TITLE COUNTS NOTHING (user report, 2026-11-05): it used to
        // say «有两件事要你看一下» / «Two things worth a look» — a claim about a
        // count this card never had. It holds ONE list, of any length.

        // WHICH PLUGINS DID NOT COME UP. There is exactly ONE list on this card
        // now (user decision, 2026-11-02): a plugin that is declared in the
        // profile and did not load this time. A file that merely differs from the
        // backup is NOT on this card — it belongs to the settings page, without a
        // verdict attached to it.
        const certain = Array.isArray(model.certain) ? model.certain : []
        if (certain.length > 0) {
          rows.push(h('p', { className: 'dsh-autorestart-announcement__note', key: 'certain-title' }, t('pluginFailure.certainTitle')))
          line('certain-intro', t('pluginFailure.certainIntro'))
          for (const entry of certain) {
            line('certain:' + entry.name, entry.name)
            const action = entry.action && typeof entry.action === 'object' ? entry.action : {}
            if (entry.kind === 'linked') {
              rows.push(h('p', { className: 'dsh-autorestart-announcement__note', key: 'hint:' + entry.name }, t('pluginFailure.linkedHint')))
              rows.push(h('button', {
                type: 'button',
                className: 'dsh-autorestart-announcement__cta',
                key: 'cta:' + entry.name,
                disabled: busy !== '',
                onClick: () => restore(entry.name),
              }, busy === entry.name
                ? fill(t('pluginFailure.restoring'), { plugin: entry.name })
                : fill(t('pluginFailure.restore'), { plugin: entry.name })))
            } else if (typeof action.command === 'string' && action.command !== '') {
              // THE COMMAND IS THERE, SO THE CARD MAY POINT AT IT (user report,
              // 2026-11-05). The hint says «use the command below» — it may only
              // be said when a command actually follows it. It used to be pushed
              // FIRST and unconditionally, so a plugin without a version showed
              // «use the command below» over an empty line, and the sentence
              // right below it («it can only be reinstalled by name») contradicted
              // it. The promise and the command now belong to the same branch.
              rows.push(h('p', { className: 'dsh-autorestart-announcement__note', key: 'hint:' + entry.name }, t('pluginFailure.thirdPartyHint')))
              rows.push(h('p', { className: 'dsh-autorestart-announcement__line', key: 'cmd:' + entry.name }, action.command))
              // AND THE WAY OUT FOR EVERYONE WHO DOES NOT LIKE COMMANDS (user
              // report, 2026-11-05). It sits in the SAME branch as the command:
              // without a command there is nothing to point at, and a promise
              // nobody can keep is the thing this card was fixed for.
              //
              // IT ALSO SAYS WHAT THE REINSTALL GIVES: the LATEST version, not
              // the one in the backup. The command above installs the backup
              // version; reinstalling from the interface does not. The user has
              // to be told which one they are about to get.
              rows.push(h('p', { className: 'dsh-autorestart-announcement__note', key: 'reinstall:' + entry.name }, t('pluginFailure.reinstallHint')))
            } else {
              // NO COMMAND, NO PROMISE. Say what is true and stop there.
              rows.push(h('p', { className: 'dsh-autorestart-announcement__note', key: 'nocmd:' + entry.name }, t('pluginFailure.noCommandHint')))
            }
          }
        }

        // ONE BUTTON FOR ALL OF THEM. Only plugins we wrote ourselves are in it:
        // a third-party plugin has no files in the backup, so "restore" cannot be
        // offered for it - those keep their reinstall hint instead.
        //
        // IT BELONGS TO THE CARD, SO IT SITS IN THE HEADER (user report,
        // 2026-11-02): at the bottom of the list it read like "restore all" applied
        // to the last plugin only. Same for «知道了».
        const linkedClues = certain.filter((entry) => entry.kind === 'linked')
        const actions = []
        if (linkedClues.length > 1) {
          actions.push(h('button', {
            type: 'button',
            className: 'dsh-autorestart-announcement__cta',
            'data-dsh-autorestart-plugin-failure': 'restore-all',
            key: 'restore-all',
            disabled: busy !== '',
            onClick: () => restoreAll(linkedClues),
          }, fill(t('pluginFailure.restoreAll'), { count: String(linkedClues.length) })))
        }

        // A blind spot is a NUMBER: those module names are not plugin names.
        const blind = Number(model.uiBlindSpot)
        if (Number.isFinite(blind) && blind > 0) {
          rows.push(h('p', { className: 'dsh-autorestart-announcement__note', key: 'blind' },
            fill(t('pluginFailure.uiBlindSpot'), { count: String(blind) })))
        }
        if (note !== '') rows.push(h('p', { className: 'dsh-autorestart-announcement__note', key: 'note' }, note))

        actions.push(h('button', {
          type: 'button',
          className: 'dsh-autorestart-announcement__cta',
          'data-dsh-autorestart-plugin-failure': 'dismiss',
          key: 'dismiss',
          title: t('pluginFailure.dismissLabel'),
          onClick: dismiss,
        }, t('pluginFailure.dismiss')))

        return h(OverlayCard, {
          key: 'overlay-plugin-failure',
          id: 'plugin-failure',
          title: t('pluginFailure.title'),
          onClose: dismiss,
          rows: rows.concat([overlayHint(t('pluginFailure.hint'))]),
          actions,
        })
      }

      return {
        inject: ['slots', 'locale'],
        apply(ctx) {
          ctx.effect(
            () => ctx.locale.register(NS, { zh: ZH, en: EN }),
            'dsh-autorestart: client locale',
          )
          const t = ctx.locale.bind(NS)
          translate = t
          // The locale service knows the active language (the user picked one,
          // or the browser decided). The fallback translator reads it at call
          // time, so a language switch is followed at once.
          localeService = ctx.locale
          ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'autorestart-restart-pill', order: 0 }, RestartPill))
          ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'autorestart-restart-dot', order: 20 }, RestartDot))
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'autorestart-backup-choice', order: 7, locale: NS }, BackupChoicePanel))
          // The one-time announcement of a new feature: the install prompt only
          // reaches a fresh installation, so an installation that already
          // existed would never hear of a new feature. The card sits in the
          // same dock (it never covers the interface and never touches the
          // countdown) and disappears for good once the user answered it.
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'autorestart-feature-announcement', order: 8, locale: NS }, FeatureAnnouncementPanel))
          // THE LEFTOVERS OF AN OLDER BUILD (2026-11-06): a card that appears
          // ONLY when the Host says there is something to decide, and that is
          // gone for good after the answer. It is deliberately NOT a settings
          // entry and NOT a permanent banner — the problem must disappear with
          // the answer.
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'autorestart-shell-backups', order: 9, locale: NS }, ShellBackupsPanel))
          // THE PLUGIN THAT DID NOT LOAD (user decision, 2026-11-01): the boot
          // pass only REPORTS now, so this panel is where the user finds out
          // which plugin did not activate — and where the ONE action lives:
          // "put this one plugin back from the last backup".
          // The graceful-shutdown button: a LIST slot at the foot of the left
          // sidebar, beside the Settings row. The slot is a ROOT slot, so the
          // button is there even when no conversation is open — and the
          // sidebar hands the column state to it, so the collapsed rail shows
          // the icon only.
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'autorestart-sleep-button', order: 10, locale: NS }, SleepButton))
          // The settings section of the plugin: an entry of its own in the
          // settings sidebar ("Auto-restart & shut down"), right below the
          // Agent presets. The three controls live inside it, so the user does
          // not have to dig through the plugin details.
          //
          // The order is computed at registration time: right after
          // `agent-presets` when that section exists, otherwise after the
          // sections that are registered already; 1000 when there is none.
          // That is "naturally last" without hard-coding a number.
          ctx.slots.inject('settings.section', function* () {
            const existing = ctx.slots.entries('settings.section')
            const agentPresets = existing.find((entry) => entry.options.id === 'agent-presets')
            const maxOrder = existing.reduce((max, entry) => Math.max(max, entry.options.order ?? 0), 0)
            const order = agentPresets !== undefined
              ? (agentPresets.options.order ?? 0) + 1
              : existing.length > 0
                ? maxOrder + 1
                : 1000
            yield ctx.slots.register({
              name: 'settings.section',
              id: 'dsh-autorestart',
              order,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({ t }),
            }, AutorestartSection)
          })
          // The countdown overlay: a frame-wide floating layer above every
          // column.
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'autorestart-sleep-overlay', order: 60 }, SleepOverlay))
          // THE CENTRED OVERLAY of a running restart: the stage (waiting / the
          // backup with its real megabytes and its progress bar / restarting /
          // back) in the middle of the interface, so the composer row can stay
          // one short clipped line. It draws NOTHING when no restart is staged.
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'autorestart-restart-overlay', order: 55, locale: NS }, RestartOverlay))
          // THESE TWO COME LAST ON PURPOSE: the countdown and the restart notice are
          // registered above, and the slot service keeps registrations in call order.
          // The plugin-failure card joins them in the same floating layer.
      // THE DOCK, ON PURPOSE (2026-11-01). These two cards were registered on
      // `shell.overlay` first, and on the real machine NOTHING rendered at all -
      // not even the diagnostic skeleton - so that slot never reached this plugin.
      // `conversation.input.dock` is the slot this plugin has always rendered in.
      // The card is taken OUT of the layout flow by its own `position: fixed`, so
      // it floats in the corner instead of pushing the conversation up.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'autorestart-plugin-failure', order: 9, label: () => 'dsh-autorestart', locale: NS }, PluginFailurePanel))
      // THE SETTINGS PAGE lives on its OWN slot, keyed to this package.
      // Name + key + locale is exactly how dsh-mnemon registers there.
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-autorestart', locale: NS }, SettingsPanel))
          // NOTE: the receipt of a settings change is NOT registered here. It
          // is a `sticky` strip INSIDE the settings panel (see
          // `saveNoticeBar`), because a window overlay put it on top of the
          // conversation area instead of inside the dialog it belongs to.
        },
        // The named exports of this module (the client module system hands
        // `factory(require) -> exports` to every importer).
        pickSleepCaption,
        shouldShowSleepButton,
        buildChoiceBody,
        formatRemainingMs,
      }
    },
  })

  // ---------------------------------------------------------------------------
  // THE PLUGIN-FAILURE MODEL (pure, testable, no React and no fetch)
  //
  // Two DIFFERENT facts feed the panel, and they must never be blurred:
  //
  //   certain - "these functions did not come up this time". A HARD fact: the last
  //             reading had them and this one does not.
  //   clues   - "these plugins differ from the backup". A LEAD, not a verdict. A
  //             plugin whose files changed may be perfectly fine.
  //
  // Neither of them says a plugin is BROKEN or FAILED to load: we have no way to
  // know that, and claiming it would be a guess dressed up as a finding.
  //
  // The three live layers are not equally good at naming a plugin. Measured on the
  // real host: tools 140 items, packages 29, clientModules only 4 - and those four
  // are module names (`batches`, `entries`, `release`), NOT plugin names. So
  // clientModules never produces a list entry; it becomes one number.
  // ---------------------------------------------------------------------------

  const PLUGIN_FAILURE_THIRD_PARTY = 'third-party'
  const PLUGIN_FAILURE_LINKED = 'linked'

  /** `codekg_query` -> `codekg`; a name with no separator is returned as it is. */
  function pluginFailureToolOwner(name) {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') return ''
    const cut = text.indexOf('_')
    return cut > 0 ? text.slice(0, cut) : text
  }

  /** `@scope/name#host` -> `@scope/name`; `plain` stays `plain`. */
  function pluginFailurePackageName(name) {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') return ''
    const cut = text.indexOf('#')
    return cut > 0 ? text.slice(0, cut) : text
  }

  /** Entry name out of one layer item, or '' when the shape is not recognised. */
  function pluginFailureLayerItemName(item) {
    if (typeof item === 'string') return item.trim()
    if (item === null || typeof item !== 'object') return ''
    for (const key of ['name', 'id', 'key', 'label']) {
      const value = item[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return ''
  }

  /** The items a watch layer reports as gone, whichever shape the host used. */
  function pluginFailureWatchLayer(watch, layer) {
    const out = []
    const push = (item) => {
      if (typeof item === 'string') { if (item.trim() !== '') out.push(item.trim()); return }
      if (item === null || typeof item !== 'object') return
      // `{layer, name}` (listDisappearances) or `{name, ...}`
      if (item.layer !== undefined && item.layer !== layer) return
      const name = pluginFailureLayerItemName(item)
      if (name !== '') out.push(name)
    }
    try {
      if (Array.isArray(watch && watch.disappeared)) {
        for (const item of watch.disappeared) push(item)
      }
      const layers = watch && typeof watch === 'object' ? watch.layers : null
      const bucket = layers && typeof layers === 'object' ? layers[layer] : null
      if (bucket && Array.isArray(bucket.removed)) {
        for (const item of bucket.removed) push(item)
      }
    } catch {
      return []
    }
    return out
  }

  /** The inventory rows, whichever wrapper the route used. */
  function pluginFailureInventoryRows(inventory) {
    if (inventory === null || typeof inventory !== 'object') return []
    if (Array.isArray(inventory.plugins)) return inventory.plugins
    if (Array.isArray(inventory.items)) return inventory.items
    if (Array.isArray(inventory.entries)) return inventory.entries
    return []
  }

  /** Is this inventory row a plugin the user wrote themselves (a link install)? */
  function pluginFailureIsLinked(row) {
    if (row === null || typeof row !== 'object') return false
    if (row.linked === true) return true
    if (row.isLink === true) return true
    for (const key of ['kind', 'installKind', 'source', 'install', 'mode']) {
      const value = row[key]
      if (typeof value === 'string' && /^(link|linked|local|dev|development)$/i.test(value.trim())) return true
    }
    return false
  }

  /**
   * Turn one plugin into the action the panel is allowed to offer.
   *
   * A hand-written (link) plugin can be put back from the backup: we hold its
   * files. A third-party plugin CANNOT - that is the whole point of keeping only
   * the config - so it gets a hint and a command with the EXACT version, never a
   * one-click button that would silently install something else.
   */
  function pluginFailureActionFor(name, kind, row, profile) {
    if (kind === PLUGIN_FAILURE_LINKED) {
      return { type: 'restore', label: name }
    }
    const version = row && typeof row === 'object' && typeof row.version === 'string' ? row.version.trim() : ''
    const profileName = typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : '<profile>'
    if (version === '') {
      return {
        type: 'hint',
        command: null,
        note: 'the exact version is unknown, so no install command can be built',
      }
    }
    return {
      type: 'hint',
      command: 'dsh plugin --profile ' + profileName + ' add ' + name + '@' + version,
      note: '',
    }
  }

  /**
   * THE BOOT THIS PAGE BELONGS TO (user decision, 2026-11-02).
   *
   * The plugin card reports the RESULT of a restart, so it is judged once per
   * boot — not monitored. The identity comes from the health payload: `bootId`
   * when the Host sends one, `generation` when it does not. Several wrappers are
   * accepted because the payload is flat in some builds and nested in others;
   * when the Host says nothing at all the identity is '' and the panel falls back
   * to one judgement per page load (reporting once beats monitoring forever).
   *
   * @param {object|null} info the shared health payload
   * @returns {string} the boot identity, or ''
   */
  function pluginFailureBootId(info) {
    const read = (source, key) => {
      if (source === null || typeof source !== 'object') return ''
      const value = source[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return ''
    }
    const holders = [info]
    if (info !== null && typeof info === 'object') {
      for (const key of ['health', 'status', 'instance', 'restart']) {
        if (info[key] !== null && typeof info[key] === 'object') holders.push(info[key])
      }
    }
    for (const key of ['bootId', 'boot', 'generation']) {
      for (const holder of holders) {
        const found = read(holder, key)
        if (found !== '') return found
      }
    }
    return ''
  }

  /**
   * WHERE the "this boot was already judged" record lives: the key carries the
   * boot identity, so a restart leaves the old record behind and the next boot
   * starts clean.
   *
   * @param {string} bootId the identity from {@link pluginFailureBootId}
   * @returns {string} the localStorage key
   */
  function pluginFailureJudgedKey(bootId) {
    const id = typeof bootId === 'string' && bootId.trim() !== '' ? bootId.trim() : 'page'
    return 'dsh-autorestart.plugin-failure.judged.' + id
  }

  /**
   * The identity of one judgement: which functions are missing and which plugins
   * differ. Stored with the boot record so the page can tell "already reported"
   * from "the same report came back".
   *
   * @param {object|null} model a model from {@link buildPluginFailureModel}
   * @returns {string}
   */
  function pluginFailureFingerprint(model) {
    const names = (list) => (Array.isArray(list) ? list : [])
      .map((entry) => (entry && typeof entry.name === 'string' ? entry.name : ''))
      .filter((name) => name !== '')
      .sort()
      .join(',')
    if (model === null || typeof model !== 'object') return ''
    return names(model.certain)
  }

  /**
   * WHICH PROFILE THIS HOST IS (user report, 2026-11-05).
   *
   * The restore command has to name a REAL profile. `--profile <profile>` is a
   * placeholder the user cannot copy and run, and the card is read by people who
   * are told to run exactly what they see.
   *
   * The Host already knows: it answers with the profile DIRECTORY, and the
   * profile NAME is its last segment — `/home/fg/.dsh/profiles/web` on the
   * hosted web instance, `…\.dsh\profiles\desktop` on the desktop build. Both
   * separators are handled, and a path that ends in one still has a name.
   *
   * THE NAME IS ONLY TEXT. It is never executed, never written to a file, never
   * put into innerHTML: it is a piece of a command line the user reads and
   * copies on purpose.
   *
   * @param {object|null} info the shared health payload
   * @returns {string} the profile name, or '' when the Host did not say
   */
  function pluginFailureProfileName(info) {
    // The name is unique on purpose: `read` is already used by another helper
    // in this module, and two functions with the same inner name shadow each
    // other in the eyes of the code graph.
    const readProfile = (holder) => {
      if (holder === null || typeof holder !== 'object') return ''
      const value = holder.profile
      if (typeof value === 'string') return value.trim()
      // Some builds send the profile as an object; the directory is in it.
      if (value !== null && typeof value === 'object') {
        for (const key of ['dir', 'path', 'name']) {
          if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim()
        }
      }
      return ''
    }
    const holders = [info]
    if (info !== null && typeof info === 'object') {
      for (const key of ['health', 'status', 'instance', 'restart']) {
        if (info[key] !== null && typeof info[key] === 'object') holders.push(info[key])
      }
    }
    for (const holder of holders) {
      const raw = readProfile(holder)
      if (raw === '') continue
      // THE TRAILING SEPARATOR GOES FIRST: a path that ends in one has no
      // segment after it, so the name would be lost.
      const text = raw.replace(/[/\\]+$/, '')
      if (text === '') continue
      const bySlash = text.split('/')
      let last = bySlash[bySlash.length - 1]
      const byBackslash = last.split('\\')
      last = byBackslash[byBackslash.length - 1]
      const name = last.trim()
      if (name !== '') return name
    }
    return ''
  }

  /**
   * Merge the two data sources into the panel's model.
   *
   * @param {{ watch?: object|null, inventory?: object|null, profile?: string }} input
   * @returns {{ certain: object[], uiBlindSpot: number, watchAt: number|null }|null}
   */
  function buildPluginFailureModel(input) {
    try {
      const source = input !== null && typeof input === 'object' ? input : {}
      const watch = source.watch !== null && typeof source.watch === 'object' ? source.watch : null
      const inventory = source.inventory !== null && typeof source.inventory === 'object' ? source.inventory : null
      const profile = typeof source.profile === 'string' ? source.profile : ''

      // WHICH PLUGINS DID NOT COME UP (user decision, 2026-11-02).
      //
      // The ONLY evidence this card accepts: a plugin PACKAGE that loaded on the
      // previous start and is not loaded now. That is "it did not come up" — the
      // whole entry is gone, not just a few of its tools.
      //
      // What is deliberately NOT evidence:
      //   * a file difference from the backup (an upgrade, our own edits) — that is
      //     normal work, and the settings page shows it without judging it;
      //   * a FEW capabilities disappearing while the package still loads — an
      //     upgrade renames a tool; that is not a plugin that failed;
      //   * a plugin the user removed from the bundles — that already happened.
      const notInstalled = new Set()
      const inventoryRows = pluginFailureInventoryRows(inventory)
      for (const row of inventoryRows) {
        if (row === null || typeof row !== 'object') continue
        if (row.status !== 'not-installed') continue
        const name = typeof row.name === 'string' ? row.name.trim() : ''
        if (name !== '') notInstalled.add(name)
      }
      const inventoryRowFor = (name) => inventoryRows
        .find((row) => row !== null && typeof row === 'object'
          && typeof row.name === 'string' && row.name.trim() === name) || null

      // THE INVENTORY IS THE LIST OF THIS PROFILE'S PLUGINS (user report,
      // 2026-11-05). A package that is NOT in it is not a plugin the user
      // installed — it is a module the HOST ships with
      // (`@deepseek-ai/dsh-experimental-client-ui-forge` and friends). Such a
      // package has no files in our backup and no version we could reinstall,
      // so listing it as "did not come up" asked the user to do something that
      // cannot be done. It is now skipped.
      //
      // THE FILTER ONLY APPLIES WHEN THE INVENTORY ACTUALLY ANSWERED. An
      // unreadable inventory (no rows) must not silence the whole card: the
      // list stays as it was, because a missing list is not a proof that
      // nothing is missing.
      const inventoryUsable = inventoryRows.length > 0

      const certain = []
      const byName = new Map()
      const addNotLoaded = (value, from) => {
        // `@scope/pkg@1.2.3` is one package with a version: the card names the
        // PLUGIN, and the version belongs in the command, not in the name.
        const text = typeof value === 'string' ? value.trim() : ''
        const at = text.lastIndexOf('@')
        const name = at > 0 ? text.slice(0, at) : text
        if (name === '') return
        if (notInstalled.has(name)) return
        // A module of the HOST is not a plugin of this profile: it cannot be
        // restored, and it was never the user's to install.
        if (inventoryUsable && inventoryRowFor(name) === null) return
        if (byName.has(name)) return
        const row = inventoryRowFor(name)
        const kind = row !== null && pluginFailureIsLinked(row) ? PLUGIN_FAILURE_LINKED : PLUGIN_FAILURE_THIRD_PARTY
        const entry = {
          name,
          source: from,
          kind,
          action: pluginFailureActionFor(name, kind, row, profile),
          lostTools: [],
        }
        byName.set(name, entry)
        certain.push(entry)
      }
      for (const raw of pluginFailureWatchLayer(watch, 'packages')) addNotLoaded(pluginFailurePackageName(raw), 'packages')

      // A vanished TOOL is EVIDENCE, never a trigger: it is attached to a package
      // that already did not come up. A tool that vanished while its package still
      // loads is an upgrade and stays out of this card.
      for (const raw of pluginFailureWatchLayer(watch, 'tools')) {
        const owner = pluginFailureToolOwner(raw)
        const entry = byName.get(owner)
        if (entry === undefined) continue
        const tool = typeof raw === 'string' ? raw.trim() : ''
        if (tool !== '' && entry.lostTools.includes(tool) === false) entry.lostTools.push(tool)
      }

      // clientModules CANNOT name a plugin: its items are module names. It is a
      // blind spot, and it is reported as a number so nobody mistakes `batches`
      // for a plugin the user should go and look for.
      const uiBlindSpot = pluginFailureWatchLayer(watch, 'clientModules').length

      // Nothing to say: no shell, no empty panel.
      if (certain.length === 0) return null

      const watchAt = watch && Number.isFinite(Number(watch.at)) ? Number(watch.at) : null
      return { certain, uiBlindSpot, watchAt }
    } catch {
      // The panel is a convenience; a malformed payload must never break the page.
      return null
    }
  }

  /**
   * THE CLEANUP, AS THE HOST ANSWERED IT (2026-11-06).
   *
   * TWO HOST SHAPES, ONE RECEIPT.
   *
   * The NEW host answers the click with `{ started, cleanup: { state } }`: it
   * deletes in the background and sends the receipt with a later GET. The OLD
   * host answers with the RESULT ITSELF (`{ removed, failures, freedBytes }`)
   * and its GET has no `cleanup` field at all — that was the host running on
   * the real machine.
   *
   * The card used to wait for `cleanup.state === 'done'` and so spun on
   * "清理中" for ever on that host: the cleanup had finished in milliseconds
   * (the directories were gone, the count was 0) and the screen did not know,
   * because it waited for a field that host never sends.
   *
   * So: the answer of the click is read FIRST (on the old host it IS the
   * receipt — no polling, no spinning), the polling is only for the host that
   * says "running", and the polling has a CEILING and a terminal state that
   * does not depend on the `cleanup` field.
   */
  const SHELL_CLEANUP_POLL_MS = 800
  const SHELL_CLEANUP_POLL_LIMIT_MS = 60000

  /**
   * THE WATCH OF THE LEFTOVERS (2026-11-07).
   *
   * THE CARD MUST COME BY ITSELF. The page is usually already open when the
   * leftovers show up (the boot sweep is what found them), and a user does not
   * press "refresh" — for a user there is no such thing. So the panel keeps
   * watching: one check at once, then one every five seconds.
   *
   * NOT FASTER THAN FIVE SECONDS: every check makes the Host walk what is on
   * the disk, and the Host measures the leftovers while the question is open.
   * NOT SLOWER THAN TEN: the card must be on the screen within ten seconds of
   * the leftovers appearing — so the distance between two checks is bound at
   * both ends, five seconds at the least and ten at the most.
   */
  const SHELL_BACKUPS_WATCH_MS = 5000
  const SHELL_BACKUPS_WATCH_MIN_MS = 5000
  const SHELL_BACKUPS_WATCH_MAX_MS = 10000

  /**
   * HOW LONG THE CARD STAYS AFTER IT HAS SAID ITS PIECE (2026-11-07).
   *
   * The user pressed a button, the work is done, and the card has nothing
   * left to say — three seconds and it goes, on its own. An ERROR gets ten:
   * three seconds would swallow a sentence before it was read.
   */
  const SHELL_CARD_RECEIPT_MS = 3000
  const SHELL_CARD_ERROR_MS = 10000

  /**
   * The job of a Host answer, if it has one.
   *
   * @param {object|null} payload
   * @returns {object|null}
   */
  function shellCleanupJob(payload) {
    if (payload === null || typeof payload !== 'object') return null
    const job = payload.cleanup
    return job !== null && typeof job === 'object' ? job : null
  }

  /**
   * THE RECEIPT OF A CLEANUP — out of whatever the Host answered.
   *
   * The old host sends the names of the removed directories, the new host
   * sends their number: both are read here, so the receipt is the same text
   * either way.
   *
   * @param {object|null} payload an answer of the click or of a GET
   * @returns {{ removed: number, failures: Array<object>, freedBytes: number }}
   */
  function shellCleanupReceipt(payload) {
    const source = payload !== null && typeof payload === 'object' ? payload : {}
    const job = shellCleanupJob(source)
    const removed = job !== null ? job.removed : source.removed
    const failures = job !== null ? job.failures : source.failures
    const freedBytes = job !== null ? job.freedBytes : source.freedBytes
    return {
      removed: Array.isArray(removed)
        ? removed.length
        : (Number.isFinite(Number(removed)) ? Number(removed) : 0),
      failures: Array.isArray(failures) ? failures : [],
      freedBytes: Number.isFinite(Number(freedBytes)) ? Number(freedBytes) : 0,
    }
  }

  /**
   * DOES THE ANSWER OF THE CLICK ALREADY CARRY THE RESULT?
   *
   * The old host does — and then the card is DONE at once: the receipt is
   * printed, no polling starts, nothing spins. The new host says "running",
   * and only then the card waits.
   *
   * @param {object|null} payload an answer of the click
   * @returns {boolean}
   */
  function shellCleanupAnswerIsFinal(payload) {
    const source = payload !== null && typeof payload === 'object' ? payload : {}
    const job = shellCleanupJob(source)
    if (job !== null) return job.state !== 'running'
    // THE OLD HOST: the answer carries the removed directories.
    return Array.isArray(source.removed) || source.freedBytes !== undefined
  }

  /**
   * IS THE CLEANUP DONE?
   *
   * The new host says so (`cleanup.state === 'done'`). The old host does not
   * have that field — but its GET says how many are left, and a cleanup that
   * left nothing behind is a finished cleanup.
   *
   * @param {object|null} payload an answer of a GET
   * @returns {boolean}
   */
  function shellCleanupFinished(payload) {
    const source = payload !== null && typeof payload === 'object' ? payload : {}
    const job = shellCleanupJob(source)
    if (job !== null) return job.state === 'done'
    return source.pending !== true && Number(source.count) === 0
  }

  /**
   * THE CEILING OF THE POLLING.
   *
   * A card that waits for ever is worse than a card that gives up with a
   * sentence: after a minute the card stops waiting and says that the result
   * may still be on its way.
   *
   * @param {number} startedAt when the polling began
   * @param {number} now
   * @returns {boolean}
   */
  function shellCleanupTimedOut(startedAt, now) {
    const start = Number(startedAt)
    const at = Number(now)
    if (!Number.isFinite(start) || !Number.isFinite(at)) return false
    return at - start >= SHELL_CLEANUP_POLL_LIMIT_MS
  }

  /**
   * THE STATE OF THE CARD, OUT OF AN ANSWER OF THE HOST.
   *
   * A LATER ANSWER MUST NOT WIPE A RECEIPT: the note of a finished cleanup
   * says what happened, and a check of the watcher must not take it away.
   *
   * @param {object} current the state of the card
   * @param {object|null} body the answer of the Host
   * @returns {object} the next state of the card
   */
  function shellBackupsStatus(current, body) {
    const base = current !== null && typeof current === 'object' ? current : {}
    const source = body !== null && typeof body === 'object' ? body : {}
    const pending = source.pending === true
    const next = {
      ...base,
      loaded: true,
      // THE HOST DECIDES: a machine without leftovers, and a machine that
      // already answered, never see this card at all.
      pending,
      count: Number.isFinite(Number(source.count)) ? Number(source.count) : 0,
      // THE SIZE MAY BE UNKNOWN: the Host measures it only while the question
      // is open, and only inside its budget. `null` means "not measured" — the
      // card then says so instead of guessing.
      bytes: source.bytes !== null && source.bytes !== undefined && Number.isFinite(Number(source.bytes))
        ? Number(source.bytes)
        : null,
      truncated: source.truncated === true,
    }
    // THE QUESTION IS OPEN: an error of an earlier refused click must not stay
    // on the card.
    if (pending === true) {
      next.note = ''
      next.error = ''
    }
    return next
  }

  /**
   * MUST THE CARD BE ON THE SCREEN?
   *
   * NO: a machine without leftovers, and a machine that already answered, see
   * nothing at all — not an empty box, not a greyed-out entry.
   *
   * @param {object} state the state of the card
   * @returns {boolean}
   */
  function shellBackupsCardVisible(state) {
    if (state === null || typeof state !== 'object') return false
    if (state.loaded !== true) return false
    if (state.pending === true) return true
    if (state.working === true) return true
    if (typeof state.note === 'string' && state.note !== '') return true
    // AN ERROR IS A REASON TO STAY (2026-11-07): a failed click must leave a
    // sentence on the screen — the card may not vanish and take the reason
    // with it.
    if (typeof state.error === 'string' && state.error !== '') return true
    return false
  }

  /**
   * THE TEXT OF A FAILED CLICK (2026-11-07).
   *
   * A click that fails must SAY SO: in the language of the user, never as a
   * silence and never as an English sentence from the browser. The Host may
   * refuse, the network may break, and the page may throw while it draws —
   * every one of them ends here, as one sentence the card can show.
   *
   * @param {object} failure what went wrong
   * @param {(key: string) => string} translate the translator of the card
   * @returns {string} the sentence for the card
   */
  function shellCleanupFailureText(failure, translate) {
    const t = typeof translate === 'function' ? translate : (key) => key
    const refused = failure !== null && typeof failure === 'object' && failure.refused === true
    const message = refused === true
      ? t('shellBackups.refused')
      : t('shellBackups.error.failed')
    return fillTemplate(t('shellBackups.error.cleanup'), { message })
  }

  /**
   * THE WATCHER OF THE LEFTOVERS (2026-11-07).
   *
   * It is written WITHOUT React, so that a fake clock can prove what it does:
   * one check at once, one every five seconds, nothing at all while the page
   * is hidden, an immediate check when the page comes back, and never another
   * one once the question is closed.
   *
   * IT STOPS IN THREE CASES, AND ONLY IN THREE:
   *   - the user answered (the marker of the Host says so): the question must
   *     never come back;
   *   - the card is on the screen: the user has something to decide, and
   *     asking again would gain nothing;
   *   - the user pressed one of the two buttons: the panel stops the watch at
   *     once, without another request.
   *
   * WHILE THERE IS NOTHING TO SHOW, IT KEEPS WATCHING: the leftovers may show
   * up long after the page was opened, and the card has to come by itself.
   *
   * @param {object} options the parts it needs
   * @param {() => Promise<object|null>} options.fetchStatus asks the Host
   * @param {(body: object) => void} options.onStatus what to do with an answer
   * @param {() => boolean} [options.isVisible] whether the page is on the screen
   * @param {(fn: Function, ms: number) => any} [options.schedule] the clock
   * @param {(id: any) => void} [options.cancel] the clock
   * @param {number} [options.intervalMs] the distance between two checks
   * @returns {{ start: Function, stop: Function, resume: Function, isStopped: Function }}
   */
  function createShellBackupsWatcher(options) {
    const settings = options !== null && typeof options === 'object' ? options : {}
    const fetchStatus = typeof settings.fetchStatus === 'function' ? settings.fetchStatus : async () => null
    const onStatus = typeof settings.onStatus === 'function' ? settings.onStatus : () => {}
    const isVisible = typeof settings.isVisible === 'function' ? settings.isVisible : () => true
    const schedule = typeof settings.schedule === 'function'
      ? settings.schedule
      : (fn, ms) => setTimeout(fn, ms)
    const cancel = typeof settings.cancel === 'function' ? settings.cancel : (id) => clearTimeout(id)
    const wanted = Number(settings.intervalMs)
    // THE DISTANCE BETWEEN TWO CHECKS IS BOUNDED: five seconds at the least,
    // ten at the most.
    const intervalMs = Number.isFinite(wanted) && wanted > 0
      ? Math.min(Math.max(Math.trunc(wanted), SHELL_BACKUPS_WATCH_MIN_MS), SHELL_BACKUPS_WATCH_MAX_MS)
      : SHELL_BACKUPS_WATCH_MS
    let timer = null
    let stopped = false
    let busy = false

    const clear = () => {
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
    }

    const tick = async () => {
      // THE TIMER THAT BROUGHT US HERE HAS FIRED.
      timer = null
      if (stopped === true || busy === true) return
      // THE PAGE IS NOT ON THE SCREEN: nobody sees a card that is not there,
      // and the disk does not need to be walked for nobody. The visibility
      // event brings the watch back.
      if (isVisible() !== true) return
      busy = true
      let body = null
      try {
        body = await fetchStatus()
      } catch {
        body = null
      }
      busy = false
      if (stopped === true) return
      if (body !== null && typeof body === 'object') {
        onStatus(body)
        // THE QUESTION IS CLOSED FOR GOOD: the marker of the answer is durable,
        // so the card must never come back.
        if (body.handled === true) {
          stopped = true
          clear()
          return
        }
        // THE CARD IS ON THE SCREEN: there is nothing left to look for.
        if (body.pending === true) {
          stopped = true
          clear()
          return
        }
      }
      if (stopped === true) return
      timer = schedule(() => { void tick() }, intervalMs)
    }

    return {
      /** THE FIRST CHECK, AT ONCE. */
      start() {
        if (stopped === true) return
        void tick()
      },
      /** NO MORE CHECKS, FOR GOOD. */
      stop() {
        stopped = true
        clear()
      },
      /** THE PAGE CAME BACK: CHECK AT ONCE. */
      resume() {
        if (stopped === true) return
        // THE PENDING CHECK IS REPLACED BY THIS ONE.
        clear()
        void tick()
      },
      isStopped() {
        return stopped
      },
    }
  }

  const SHELL_BACKUPS_EXPORTS = {
    SHELL_CLEANUP_POLL_MS,
    SHELL_CLEANUP_POLL_LIMIT_MS,
    shellCleanupAnswerIsFinal,
    shellCleanupFinished,
    shellCleanupReceipt,
    shellCleanupTimedOut,
    // THE WATCH OF THE LEFTOVERS (2026-11-07)
    SHELL_BACKUPS_WATCH_MS,
    SHELL_BACKUPS_WATCH_MIN_MS,
    SHELL_BACKUPS_WATCH_MAX_MS,
    // HOW LONG THE CARD STAYS AFTER IT HAS SAID ITS PIECE (2026-11-07)
    SHELL_CARD_RECEIPT_MS,
    SHELL_CARD_ERROR_MS,
    createShellBackupsWatcher,
    shellBackupsStatus,
    shellBackupsCardVisible,
    shellCleanupFailureText,
  }

  const PLUGIN_FAILURE_EXPORTS = {
    buildPluginFailureModel,
    pluginFailureBootId,
    pluginFailureJudgedKey,
    pluginFailureFingerprint,
    pluginFailureToolOwner,
    pluginFailurePackageName,
    pluginFailureProfileName,
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.__dshAutorestartClient = Object.assign(
      globalThis.__dshAutorestartClient || {},
      PLUGIN_FAILURE_EXPORTS,
      SHELL_BACKUPS_EXPORTS,
    )
  }

})()
