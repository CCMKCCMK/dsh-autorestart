# dsh-autorestart

中文说明 · [English](../README.md)

![dsh-autorestart 图标](../assets/icon-180.png)

当前版本：**0.9.6**

## 它做什么

三件小事，都发生在「重启」前后。

**一、重启排成队。** 有会话要求重启时，插件不会立刻掐断还在跑的对话：它等所有会话都空闲了才动手，重启完再把被打断的活接着做完——会话自动恢复，目标（goal）重新上链。多个会话同时要求重启会合并成一次，且每个请求者都会被唤醒。带 goal 的会话不会把重启卡死：重启前先解除它的 goal（当前那一轮照常跑完，什么都不丢），重启后自动重新武装。

**二、重启前自动备份。** 每次重启前把配置和本地 `link:` 装的插件目录存到 `~/.dsh/storages/dsh-autorestart/backups/`，最多保留 `maxBackups` 份（默认 2，范围 2–10），旧的和不完整的会被清理。某个旧快照删不掉时（例如里面有文件被占用），会在 health 的 `backupHygiene.error` 里如实报出来，不会假装已清掉——所以份数可能暂时超过上限。

**三、清掉登录 cookie。** 桌面客户端每启动一次就多一枚 `dsh-auth-*` 通行证，攒多了请求头超过约 16 KB，服务器回 431，客户端只报 `Web authentication failed`。插件在每次重启前把这些过期凭证清掉，结果写进 `last-cookie-clear.json`。

另外还有**收工关机**：左侧栏底部的月亮按钮，等所有会话收工后在屏幕上倒数，然后关掉整台电脑。

## 它不做什么

- **不监视宿主**，也不判断「这次重启回没回来」；
- **它自己不会把备份放回去**：备份只给你手工查看或回滚，插件绝不会在你不知情时改写配置或插件（唯一例外是你自己装了「开机自启」守护——那个独立进程会在宿主起不来时回滚上次快照）；
- **没有需要手工跑的东西**：起不来就用 DSH 自己的崩溃对话框，或重装插件。

## 给 agent 用的工具

| 工具 | 作用 |
|---|---|
| `continuum_restart` | 排队一次优雅重启（等所有会话空闲） |
| `continuum_status` | 看阶段、代号、排队中的请求、被哪个会话挡住 |
| `continuum_cancel_restart` | 撤回排队中的请求（`scope: "mine"` 或 `"all"`） |
| `continuum_park_goal` | 解除 goal，让排队中的重启能过闸 |
| `continuum_recover_now` | 立刻重试重启后的恢复 |
| `continuum_handoff` | 把超上下文的会话交接给新会话 |
| `continuum_supervisor` | 查看或安装「开机自启」的守护 |

## 配置项

设置页写的就是这些，默认值取自代码。

| 键 | 默认 | 含义 |
|---|---|---|
| `restartMode` | `app` | `app` = 让桌面客户端自己重开；`command` = 执行你给的重启命令 |
| `restartCommand` | `''` | `restartMode` 为 `command` 时用的命令，支持 `{pid}` `{ppid}` `{app}` 占位符 |
| `settleMs` | `2000` | 宿主必须安静多久才允许开始重启 |
| `restartGraceMs` | `0` | 最后一个会话空闲后额外等多久才真正重启——**下拉框：0 / 5 / 10 / 20 / 30 / 60 秒**；`0` = 不额外等 |
| `queuedGraceMs` | `60000` | 排队中的收件箱消息最多挡多久；**正在跑的会话在任何设置下都照样挡路** |
| `marketStatusUrl` | `''` | 插件市场在哪里报告「我正在装东西」。空 = 本宿主自己的状态路由（`/dsh-market/status`）。只读——探针从不写任何东西 |
| `marketProbeTimeoutMs` | `800` | 一次市场探针最多花多久（毫秒；可以调短，绝不能调过 800） |
| `marketProbeIntervalMs` | `1500` | 等待重启期间多久问一次市场（毫秒） |
| `marketInstallCooldownMs` | `15000` | 市场说「装完了」之后还要再等多久，用来跨过它队列里两次操作之间的空档（毫秒） |
| `pluginFilesWatch` | `true` | 插件目录在变的时候也等——`package.json`、`pnpm-lock.yaml`、`node_modules` 和 `node_modules-link`。这覆盖了根本不走市场的安装：手工 `pnpm add`，或宿主自己的插件管理器 |
| `pluginFilesStableMs` | `15000` | 插件文件要多久不动才算「装完了」（毫秒）——设置页是下拉框：**5 / 10 / 15 / 30 / 60 秒**；误报会在这个窗口之后自己消失 |
| `pluginFilesMaxBlockMs` | `300000` | 一次文件变动最多能挡住重启多久，免得卡死的安装把宿主钉住（毫秒）——设置页是下拉框：**5 / 10 / 30 / 60 分钟**（最短就是 5 分钟） |
| `forceRestartWhenBusy` | `false` | 不等空闲、直接打断正在跑的对话；默认永不打断任何会话 |
| `deferPollMs` | `3000` | 等会话空闲时的轮询间隔 |
| `relaunchDelaySeconds` | `2` | 脱离的 helper 在杀掉应用之前等几秒 |
| `restartWindow` | `background` | 重启命令脚本怎么拉起：`background` = 不出窗口、不抢焦点（**这一版起是默认**）；`foreground` = 那个可见的控制台窗口。老配置里已经显式写着 `foreground` 的仍然保持前台——只有缺这个键或值读不懂时才回落到 `background` |
| `backupOnRestart` | `true` | 每次重启前先比对，有变化才存一份存档；默认保留 2 份，超出自动删最旧的；关掉这个开关既不比对、也不产生存档 |
| `backupIncludePlugins` | `true` | 存档里也包含插件，分三类：**你自己写的插件**、以及从线上下载后**又本地改过（做过本地化）**的插件——连文件一起拷，回退时能原样还原；其余**原样安装的线上第三方插件**只记下名字和版本，不拷文件，它们由插件作者维护，出问题重装一次即可（本机带文件约 117 MB、多约 3 秒） |
| `maxBackups` | `2` | 保留几份存档（2–10）。下拉框现在是**「重启前备份」下的第三行从属项**，不再在「备份信息」折叠里；超出这个份数就删最旧的，把份数调小会先问你要删掉几份 |
| `restartCommandTimeoutMs` | `30000` | 重启命令最多让插件等多久（毫秒） |
| `showSleepButton` | `true` | 显示收工关机按钮 |
| `sleepCountdownSeconds` | `10` | 关机前倒数几秒——**下拉框：0 / 10 / 20 / 30 / 60 秒**。`10` 只是「从没设置过这一项」的实例拿到的默认值：profile 里已经存着 `20`（或 `30`、`60`）的，读到的仍是自己的值，**不做迁移、也不覆写** |
| `sleepCommand` | `''` | 覆盖默认的关机命令 |
| `resumeOnBoot` | `true` | 重启后恢复被打断的会话 |
| `recoveryDelayMs` | `6000` | 第一次恢复前等多久 |
| `maxResumeAttempts` | `2` | 每个会话最多尝试几次恢复（跨重启累计） |
| `maxSessions` | `4` | 一次启动最多恢复几个会话 |
| `continuationText` | `''` | 覆盖默认的续接提示文本 |
| `stateFile` | `''` | 检查点文件路径；空 = `<DSH_HOME>/storages/dsh-autorestart/state.json` |
| `autoReloadPage` | `true` | 重启后自动刷新页面 |
| `blockManualRestart` | `true` | 拦下 agent 用命令手动杀掉/重启 DSH，并引导它改用 `continuum_restart` |
| `healthPath` | `/__dsh_autorestart/health` | 健康检查路由：启动代号、pid、阶段、自检标志 |
| `enabled` | `true` | 关掉整个插件 |
| `watchEnabled` | `true` | **插件清单监听**：宿主稳定后比对一次插件提供的工具/界面模块/包，报告这次没起来的那些——它只报告，不自动修 |
| `watchDelayMs` | `8000` | 监听在启动后等多久再读 |
| `deferSoftMs`、`deferHardMs`、`deferPolicy` | `300000` / `900000` / `auto` | **已弃用——读入但完全无效。** 待重启没有截止时间；仅为兼容旧配置文件保留 |

上面八个键里，`restartWindow`、`pluginFilesWatch`、`pluginFilesStableMs`、`pluginFilesMaxBlockMs` 四个在设置页
有对应控件，位置在**更多设置**块里；四个 `market*` 键是纯配置键、设置页没有控件，见下面的「更多设置」。

### 设置页

整页一行一件事：**标题在左、控件在右**，说明统一折进**「查看说明」**里，页面才不至于变成一堵字墙。凡是
「开 / 关」这类行，控件都是**滑动开关**，不是勾选框。控件列足够宽（260 px，下拉最小 200 px），像
*后台运行（不出现窗口，也不抢焦点，默认）* 这种长选项会完整显示，不会被挤断。

只在上面那一行开着时才有意义的行，会画成那一行的**从属项**：缩进在它下面、跟一道淡竖线，上面那行关掉时
**变灰、控件不可用**。

| 分组 | 里面有什么 |
|---|---|
| **重启相关设置** | 重启前的等待、**重启前备份**（它下面有**两行从属项**：**备份包含已安装插件**、**保留份数**），以及**「备份信息」**折叠（只读） |
| **关机相关设置** | 收工关机的倒数秒数 |
| **更多设置** | 独立成块、**默认收起**：重启命令脚本运行方式，以及插件目录看门狗 |
| **开机自启** | 这台机器上「开机自启」怎么做，附可直接复制的命令。插件**不会**替你改系统配置。桌面客户端上不显示——它自己重开，没有守护要装 |
| **遇到问题** | 诊断信息，以及一个「报告问题」按钮：复制诊断并打开预填好的 GitHub issue —— 不含访问令牌、不含密钥 |

**「重启前备份」说的是它实际怎么干活**：每次重启前先比对 DSH 配置和它下面两行覆盖的插件，**有变化才新建一份存档，没变化就沿用最近那份**。**默认保留 2 份**，超出自动删最旧的——这个份数在**「保留份数」**里改，也就是这一组的第三行。关掉这个开关时**不做比对，也不产生存档**。存档**不会自动还原**：要回退，去**「备份信息」**里点那个按钮。

**「备份包含已安装插件」把插件分成三类**：

- **你自己写的插件**，以及从线上下载后**又本地改过（做过本地化）**的插件——**连文件一起拷**，回退时能原样还原；
- 其余**原样安装的线上第三方插件**——只记下**名字和版本**，不拷文件；它们由插件作者维护，出问题重装一次即可。

这个分法不是文案发明：`lib/backup.js` 确实把手写的 `link`、本地化的 `localized` 与其余 `thirdParty` 分开处理，而 `localized` 是连文件一起拷的。

**「备份信息」** 是展示「备份了什么」的那个折叠：现在有几份、占多少空间、什么时候会备份、每份带时间与一个「回退到这一份」的按钮、备份路径与复制按钮。这一版起它**只剩只读内容**——**「保留份数」下拉框已经从折叠里挪出去**，变成**「重启前备份」下的第三行从属项**，份数在那边改。它**默认收起**——只有「这次启动是系统回滚过」的时候会自己展开，并在标题上写明，因为回滚是唯一不能藏起来的事。

**「上次重启」那一行已经从页面上撤掉了**：上次真正用的是哪个拉起方式（`wscript`、PowerShell 回落、前台窗口）宿主照旧报出来——它在状态数据里、也在诊断信息里——只是不再占设置页的地方。

### 更多设置（「更多设置」）

独立成块，位置在**「关机相关设置」之后、「遇到问题」之前**，**默认收起**——不点标题就只看得到标题本身。

| 页面上的标题 | 键 | 控件 |
|---|---|---|
| **重启命令脚本运行方式** | `restartWindow` | 下拉框：*前台运行（会短暂出现一个窗口）* ／ *后台运行（不出现窗口，也不抢焦点，默认）* |
| **装插件时先不重启、不关机** | `pluginFilesWatch` | 滑动开关 |
| **等待插件没有文件改动多少秒，就算装完** | `pluginFilesStableMs` | 下拉框：5 / 10 / 15 / 30 / 60 秒 |
| **最多等插件安装多久** | `pluginFilesMaxBlockMs` | 下拉框：5 / 10 / 30 / 60 分钟 |

后两项是上面那个开关的**从属项**：它们缩进画在开关下面，开关关掉时**变灰、下拉不可用**；开关那一行自己也
写着这句话——「关掉上面那个开关时，这两项不起作用。」

一个不在选项里的值不会被改写：它会作为**「当前值」**出现在下拉框里，老配置照旧能用，直到你自己选一个。

**这一版起默认是后台运行。** 重启命令脚本以前是前台跑的，那个控制台窗口会在宽限等待期间一直亮着。老配置里
已经显式写着 `foreground` 的仍然保持前台——默认值只负责补上缺失或读不懂的值。重启的其它部分一处没动：
等待、空闲闸、杀整棵进程树、清 cookie、重新拉起，顺序和语义都一样。这台电脑不让运行这类小脚本时，会改用
隐藏的 PowerShell 跑同一条命令，并把原因写进重启报告。

四个**市场探针**键——`marketStatusUrl`、`marketProbeTimeoutMs`、`marketProbeIntervalMs`、
`marketInstallCooldownMs`——在设置页**没有控件**：它们是配置键，写在 profile 行里、或走配置接口改。上表里的
默认值就是探针真正用的值。

## 重启前会等什么

重启是排队，不是硬切。闸门会等还在进行的活——**收工关机**（月亮按钮）等的是同样这三样，外加一样，因为关机把
一次安装拦腰截断，比重启还狠。

| 等什么 | 怎么判 | 你会看到 |
|---|---|---|
| **所有会话都空闲** | 插件问宿主哪些会话还在跑。排队中（没人认领）的收件箱消息最多挡 `queuedGraceMs`；**正在跑的会话**任何情况下都照样挡 | 重启继续排队；`continuum_status` 会点名挡住它的会话 |
| **插件市场装完** | 只读一次 `GET` 市场的状态路由（`/dsh-market/status`）：`busy` 或 `active` 就是「在装」。读不到的答复——超时、404、非 2xx、body 不是一个对象——一律算**「没在装东西」**，重启照旧往下走 | 重启胶囊上出现一颗药丸（「等插件市场装完插件后再重启」）；侧栏小圆点的 tooltip 说同一句话 |
| **插件目录安静下来** | profile 里的 `package.json`、`pnpm-lock.yaml`、`node_modules`、`node_modules-link` 会被取指纹；指纹还在动，重启就等。这能抓住根本不走市场的安装：手工 `pnpm add`，或宿主自己的插件管理器 | 重启胶囊上出现一颗药丸（「等插件装完再重启」） |
| **还在跑的目标**（只对关机） | 目标算「在跑」的条件是：仍然**武装着**、没到终态（`paused` / `blocked` / `complete` / `completed` / `done`）、轮次还没用完。暂停的、被缴的、做完的目标都不会挡住机器 | 关机被挡住，并点名是哪个目标还在做 |

两个「安装」类的等待都有上限，所以坏掉的信号不会把宿主永远钉住：

- **市场**：一次「在装」的答复最多只记 `marketInstallCooldownMs`（默认 15 秒），而且**只在市场完全联系不上的时候**
  才保留；超过这个窗口，市场就算空闲。
- **插件文件**：一次文件变动最多挡 `pluginFilesMaxBlockMs`（默认 5 分钟），而且只有「最后一次变动距今不到
  `pluginFilesStableMs`（默认 15 秒）」才算「还在变」。

两个探针都是只读的：一次 `GET`、不带 body、不重试、什么都不写。

## 它把文件写在哪

| 路径 | 内容 |
|---|---|
| `~/.dsh/storages/dsh-autorestart/state.json` | 启动代号、阶段、每个会话的重启状态 |
| `~/.dsh/storages/dsh-autorestart/backups/<时间戳>/` | 一份快照的 `config/` + `node_modules-link/` |
| `~/.dsh/storages/dsh-autorestart/last-cookie-clear.json` | 上次清掉了几枚凭证 |
| `~/.dsh/storages/dsh-autorestart/access.json` | 插件监听的本地端口与令牌 |

## 关于那份备份

它包含**配置文件**（`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`）和**连文件一起拷的那些插件**——你自己写的、以及你在本机改过的线上插件。**原样安装的线上第三方插件不在里面**：manifest 只记下它们的名字和版本，它们可以用 `package.json` + `pnpm-lock.yaml` 重新装回来。所以它适合「看看以前是怎么配的」「把某个插件版本翻回去」，不是一键重装。

### 备份有多大、体积从哪来

**体积几乎全来自「连文件一起拷」的那几类插件。** 线上第三方插件只往 manifest 里记一个名字和版本，
在磁盘上不占空间。

本机实测（2026-11-11，桌面版；读数来自 manifest 与磁盘）：

| 备份 | 体积 | 文件数 | `links` | `localized` | `thirdParty` |
|---|---|---|---|---|---|
| `2026-11-11T06-36-48-336Z` | **132.1 MB** | **820** | 7 | 0 | 145（只记名字 + 版本） |
| `2026-11-11T04-13-04-262Z` | 129.2 MB | 820 | 7 | 0 | 145（只记名字 + 版本） |

`linkBytes` 是 **138,395,369**——差不多就是这份副本的全部字节。两份备份的**结构完全一样**，只有字节数动了。

那 138 MB 落在哪 —— 被连文件拷的 7 个插件：

| 插件 | 体积 |
|---|---|
| `dsh-codekg` | **118.7 MB** |
| `dsh-goal-guard` | 6.1 MB |
| `dsh-autorestart` | 5.1 MB |
| `dsh-secret-vault` | 1.2 MB |
| `dsh-github-guard` | 0.4 MB |
| `dsh-security-scan` | 0.3 MB |
| `dsh-web-fetch-fallback` | 0.1 MB |

**`dsh-codekg` 一个就占整份备份的约 86%**，而它里面几乎全是它自己的 `data/` 目录（**114.0 MB**）：
`snapshots/` **99.6 MB**（108 个文件，绝大多数是工具自己写的 `run-*.json` 基线）、`graphs/` 11.4 MB、
`runs/` 2.9 MB。那是**工具跑出来的运行数据**，会随使用与工具自己的保留策略涨落。

所以**备份体积会浮动，这是正常的**——它不代表备份出了问题，也不代表漏了插件：体积跟着插件自己的运行数据走。
**要看的是文件数与插件清单**，不是字节总数。

## 平台

| 平台 | 状态 |
|---|---|
| Windows 桌面客户端（`restartMode: app`） | 真机验过 |
| WSL 上的托管 `dsh web`，有 systemd（`restartMode: command`） | 真机验过 |
| Windows 上的托管 `dsh web` | 未验 |
| 无 systemd 的 WSL、原生 Linux | 未验 |

macOS、无图形环境的远程 SSH、容器**不在支持范围内** —— 未实测、不支持。逐项能力矩阵见
[platform-matrix.md](platform-matrix.md)。

### 托管版 `dsh web` 里的浮层——指望它之前先读这段

重启 / 关机 / 插件故障这几个界面画在**客户端**槽位 `shell.overlay` 上——「一个横跨整帧的浮层，在每一列之上、
在它们的滚动容器之外」。下面两条事实是对着已发布的包和一个活客户端核对过的，不是推测：

- 那个槽位由共享的 workspace UI 包声明（`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts`），
  而托管版 web UI 挂的就是它——所以**槽位本身不是桌面版专属**。
- 在桌面客户端上，我们的三项注册都是 `active: true`：`autorestart-plugin-failure`（order 9）、
  `autorestart-restart-overlay`（order 55）、`autorestart-sleep-overlay`（order 60）。这一点是通
  活客户端的 Slot 检查确认的。

**在托管版 web 上，重启的阶段更少，其中一个根本不存在。** 在一个真实例上实测（0.9.5，`restartMode: command`），
每 300 毫秒采一次 `/health?state=1`，覆盖一整次重启——121 帧：

```
waiting      17 frames (~4 s)
DOWN         1 frame          old process gone
restarting    1 frame
DOWN         4 frames         process swap
back          1 frame
DOWN         3 frames
```

**没有 `snapshotting` 这一帧。** 桌面版上备份发生在旧进程退出之前，浮层报的就是它。托管版 web 正好反过来：
旧进程只走 `waiting → restarting`，备份由**新**进程在启动时写，体现在 `firstInstallBackup` 上。所以「正在备份，
含插件」这句话在 web 上**没有任何阶段可以挂靠**——它不是被藏起来了，是那里根本不做这件事。

备份本身在 web 上照样是真的、照样含插件——同一次运行里核对过：

```
manifest.json  stamp: 2026-11-09T09-41-41-335Z  atLocal: 2026-11-09T17:41:41+08:00
               includePlugins: true   profileDir: /home/fg/.dsh/profiles/web
```

**把重启浮层当成桌面客户端的功能**，别把计划建立在「浏览器里也能看到它」之上。这是「页面不是宿主」这条
性质决定的，不是插件这边能修的缺陷。重启在两个平台的 HTTP 面上都照样看得见——
`GET /__dsh_autorestart/health?state=1` 会报当前的 `restartPhase` 与已完成的 `firstInstallBackup`——
所以脚本化检查能观察到浏览器标签页看不到的东西。

## 安装

从 npm：

```
dsh plugin install dsh-autorestart
```

从源码：

```
git clone https://github.com/Eason-22/dsh-autorestart.git
cd dsh-autorestart
dsh plugin --profile desktop add /绝对路径/dsh-autorestart
```

在 DSH 里面，等价的是 `plugin_manager` 工具：

```
plugin_manager install_bundle  target = <包的绝对路径>
```

装上就能用，不需要额外配置：默认就会排队重启、每次重启前拍快照、并清掉过期 cookie。

## 卸载

把 profile 的 bundle 列表里 `dsh-autorestart` 那一行去掉 —— 用界面里的 Plugin Manager，或
`dsh plugin` 命令行：

```
dsh plugin remove dsh-autorestart
```

`~/.dsh/storages/dsh-autorestart/backups/` 下的快照是你自己的，卸载不会替你删。

## 测试

插件自带测试套件，在 `plugins/dsh-autorestart/test/`。桌面环境里 `PATH` 上没有 `node`，所以仓库自带一个脚本，
用随附的 Node 跑它：

```
pwsh -NoProfile -File plugins/dsh-autorestart/scripts/run-tests.ps1
```

Windows PowerShell 下同一条：

```
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/dsh-autorestart/scripts/run-tests.ps1
```

**别把目录交给 `node --test`。** Node 24 起把 `--test` 的位置参数当成 glob，
`node --test plugins/dsh-autorestart/test` 会以 `MODULE_NOT_FOUND` 失败；脚本传的是 glob
`plugins/dsh-autorestart/test/*.test.mjs`。

**1191** 个用例全绿（1191 通过 / 0 失败 / 0 跳过）——2026-11-11 本机用随附的 Node 实测：
`tests 1191 / pass 1191 / fail 0`，退出码 0。

## 许可

MIT
