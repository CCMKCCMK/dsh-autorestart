# dsh-autorestart

## 截图

![dsh-autorestart 图标](assets/icon-180.png)

![dsh-autorestart 截图 1](assets/screenshot-1.png)

![dsh-autorestart 截图 2](assets/screenshot-2.png)

![dsh-autorestart 截图 3](assets/screenshot-3.png)

## 它解决什么问题

**0.7.0 新增**：它会先认出自己是怎么被启动的——桌面客户端、别人的守护（脚本 / systemd / 容器 / pm2 / Windows 计划任务），还是没人管的裸跑。**有人管就只优雅退出，认不出就什么都不做**，绝不在运行中的 DSH 旁边再开一个。设置页能看到「现在备份了什么」（份数、本地时间、大小、路径），还有一个「报告问题」入口：一键复制诊断信息并打开预填好的 GitHub 问题页（诊断信息不含访问令牌、不含密钥）。

- DeepSeek Harness 在装插件、升级、崩溃、或关掉重开时，正在跑的任务会被打断。这个插件把"重启"变成一件可恢复的事，不再需要你事后补一句"继续"：
- 等所有对话都空闲了才重启：不会在你或别的会话正在跑的时候把应用关掉；
- 重启后自动接着干：被打断的会话自动恢复，目标（goal）会重新武装继续跑；
- 多个会话同时要求重启时合并成一次，且每个请求者都会被唤醒；
- 带 goal 的会话不会把重启卡死：重启前自动**解除（disarm）**它的 goal（当前那一轮照常跑完，什么都不丢），重启之后自动重新上链；
- 重启前有两道检查：宿主侧查一次，独立 helper 在杀进程前再查一次；
- 界面上能看到状态：输入框工具行左侧的"待重启 · 等待 N 个会话"小胶囊、左侧栏会话标题旁的圆点；快重启时圆点呼吸，点胶囊看详情；
- 可配置：静默窗口（默认 2 秒）、杀进程前等待（默认 2 秒）、忙碌时是否允许强制重启等。
- 同一套"等到大家都安静"的想法还做成了**收工关机**：左侧栏最底部（设置按钮旁边）一个月亮按钮 → 等所有会话收工 → 屏幕上倒数（一张浮动卡片：大字 + 鲸鱼娘）→ **关掉整台电脑**（见「收工关机」）。

场景对照：

| 场景 | 没有它 | 有它 |
| --- | --- | --- |
| Agent 正在跑长任务，DSH 被重启/崩溃 | 这一轮丢失，必须人工催"继续" | 新进程启动后自动 resume 该会话并注入续接提示，继续干活 |
| Agent 有一个持久 goal（`create_goal`）跨重启 | goal 的 activation 是进程内的，重启后变回 `disarmed`，自动续跑停止 | 启动时重新 `goals.resume()`，goal round driver 立刻开始下一轮 |
| Agent 想装/升级插件但"重启必打断" | 只能等或赌 | 调 `continuum_restart`：等所有 agent idle（当前这一轮跑完）再重启，回来自己接着做 |

## 支持范围（Supported platforms）

一句话判断：**你这台机器是不是下面四类之一？**

| 你的机器 | 是否支持 | 你需要知道什么 |
| --- | --- | --- |
| **Windows 桌面**（DeepSeek Harness 客户端） | **支持** | 不用配任何东西 —— `restartMode: app` 就是默认值 |
| **Windows 上的 `dsh web`** | **支持** | 必须自己设 `restartMode: command`，**并且**给一条真能重启这个宿主的 `restartCommand` |
| **WSL 上的 `dsh web`** | **支持** | 同上；注意那个关机按钮关的是**整台 Windows**，不是那个 WSL 发行版 |
| **Linux 上的 `dsh web`** | **支持** | 同上 |

后两行各有两种形态：**有** `systemd --user` 和**没有**。这只影响**自动回滚用哪种机制**
（systemd user 定时器，还是插件自己的脱离进程），其它能力一样。设置页永远会告诉你这台机器
拿到的是哪一种，也绝不会承诺一个它给不了的自动回滚。

### 范围外：未实测 / 不支持

下面三类**不在**支持范围内。插件装上去可能「看着能跑」，但没有任何承诺：没有真机验证，
有些能力根本给不了。

| 环境 | 状态 | 你会失去什么 |
| --- | --- | --- |
| **macOS** | **未实测 / 不支持** | 没有桌面救援快捷方式；自动回滚退化成插件自己的后台进程（机器上没有 `setsid` 时进一步退化成**完全没有自动回滚**）；关机倒数从未在真 Mac 上验过 |
| **远程 SSH 无图形环境** | **未实测 / 不支持** | 没有桌面、没有桌面救援入口，唯一出路是 `.sh` 脚本 —— 也就是说你得先能 SSH 上去；「开机自启建议」拉起的是**宿主**，不是你的 SSH 会话；会话续接只在**有人**把宿主重新拉起来之后才发生 |
| **容器**（Docker / Compose / Kubernetes） | **未实测 / 不支持** | 没有「开机自启」这回事（由编排器负责）；自动回滚退化成插件自己的后台进程（精简镜像里常常没有 `setsid` → **没有自动回滚**）；关机倒数**不认识容器** —— 它真的会去关这台主机，所以别在容器里按；容器重建后检查点与备份可能一起消失 |

如果你就在这三类环境里：当实验装、风险自负；出问题请用 `scripts/restore-profile.sh` /
`scripts/emergency-disable.sh` 自救。

完整的能力矩阵（每种能力 × 每个环境，每一格都带它依据的 `文件:行号`）见
[platform-matrix.md](platform-matrix.md)。

## 三分钟看懂（普通用户读这一节就够）

### 重启为什么不会丢活

插件把"重启"做成一件**可恢复**的事，顺序是固定的：

1. **先把会话状态落盘** —— 每个会话在做什么、哪些 goal 还带着，都先写进磁盘上的检查点；
2. **排队等所有会话空闲** —— 谁还在跑就等谁，等齐了才动手；
3. **换新进程** —— 老进程退出，新进程起来（桌面版由应用自己拉起自己；Web 托管端见下一节）；
4. **新进程自检** —— 起来之后核对四项：端口通了没、路由齐了没、插件加载了没、会话恢复完没；
5. **没起来就回滚** —— 自检没过，就从**身份为 `known-good` 的那一份**快照（配置 + 已装插件）放回去，并把这次重启的结论如实写在状态里。**没有任何一份带这种身份时，它不会拿「最新的一份」顶上**，而是如实报告「没有带身份的可还原点」。

所以"重启丢活"变成了"重启后接着干"：你不用再补一句"继续"。

### 两种运行形态，各管各的

| | 桌面客户端 | Web 托管端（`dsh web`） |
|---|---|---|
| 谁负责把它拉起来 | **应用自己**（自己关自己、自己开自己） | 先看"是谁拉起的" |
| 要不要装系统服务 | **不要**。装了反而会双开：登录时再多开一个 DSH | 只在"没人管它"的时候才可能装 |
| 已经有人管着它（守护脚本 / systemd / 容器 / pm2 / Windows 计划任务…） | 不适用 | **只优雅退出**，交给那个守护去拉起它（不自己再起一个） |
| 认不出是谁拉起的 | 不适用 | **什么都不做，也不猜命令** —— 宁可说"我认不出"，也不在第一个旁边再开一个 |

### 开机自启：插件只给建议，不替你改系统

插件**不会**改你的系统配置、**不会**替你注册任何开机项。它只在设置页把"这台机器上怎么做开机自启"讲清楚，要用的命令可以直接复制，要不要用由你决定。

| 你的情况 | 推荐做法 | 注意 |
|---|---|---|
| Windows 上的 `dsh web` | 登录时自启：优先用"计划任务"（不需要管理员）；这台机器不允许的话，就用"启动文件夹"里的一个 .cmd | 记录里跑的是**真正的 node + 守护脚本**，不是 DSH 客户端本体（否则每次登录会再开一个 DSH） |
| Linux（不是 WSL） | systemd 用户服务 | 这是**登录后自启**；要**开机自启**（不必先登录）得另外开一次 linger |
| WSL 里有 systemd | 同上：systemd 用户服务 + linger | 同上 |
| WSL 里没有 systemd | 这里没有"登录时自启"这回事。两条路：① 在 WSL 内部开启 systemd（改发行版的配置 + 重启子系统）；② 让 Windows 侧用计划任务/启动文件夹把 WSL 拉起来（更接近真正的开机自启） | 插件**不会**替你改发行版配置，也不会在 WSL 里推荐容器编排那套做法（WSL 的"编排器"是 Windows 本身） |
| 容器 / k8s | 由编排器负责（compose 的 `restart: always` 那一类） | 容器里没有"登录时自启" |

**"登录后自启"和"开机自启"不是一回事**：前者等你登录了才生效，后者是机器一开就生效（要额外开一次 linger）。插件把这句话和对应的命令一起写在设置页里。

### DSH 起不来了

插件目录的 `scripts/` 里有两个脚本，分工不一样（**Windows 用 `.cmd`，Linux/WSL 用 `.sh`**）：

- **`restore-profile.cmd` / `restore-profile.sh` —— 回到上一次好状态**：把最新的一份带 manifest 的快照放回 profile；坏掉的那份**挪走而不是删掉**，留成 `profile.broken-<时间戳>`。它**不会替你重启 DSH**，重新打开 DSH 是你自己的事。
- **`emergency-disable.cmd` / `emergency-disable.sh` —— 只把这个插件摘掉**：其余一切原样不动（只从 bundles 里拿掉这一个名字，并留一份文件备份）。

**怎么选**：「想整个回到上一个好状态」用前一个；「只怀疑这个插件」用后一个。边界（目标 profile 必须已存在、必须有带 manifest 的快照、不会自动重启、`broken-` 目录会留着）写在 [`scripts/README.md`](../scripts/README.md) 里。每个平台到底有什么、没有什么，看 [平台能力矩阵](platform-matrix.md)。

### 实测状态表（哪些真机验过，哪些只有单元测试）

| 启动方式 | 真机验过？ | 依据 |
| --- | --- | --- |
| 由 shell 守护脚本拉起（`supervise-*.sh` 之类） | **是** | 真机识别为 external，识别依据指到那个脚本进程，并且**拒绝再装第二个守护** |
| 裸跑：手起（前台） | **部分** | 真机确认它把自己认成"没人管"（mode `bare`，依据是父进程是 bash）并给出了安装计划；**真正的"装 → 跑 → 卸"是在"已有守护"的实例上真机跑通的**，裸跑实例上没做完整装卸 |
| 裸跑：后台（`nohup` / `setsid`） | **部分** | 真机确认能被认成裸跑（后台启动）；**"重拉命令脱离原 shell"这一条只有单元测试**（当时机器上返回的并不是脱离标记） |
| WSL（有 systemd） | **是** | 真装真卸 |
| Windows 登录任务 | **部分** | 真机用系统原生方式建 → 查（State=Ready、登录触发器）→ 删（无残留）成功，证明确实不需要管理员；**"被拒后降级到启动文件夹"只有单元测试** |
| 桌面客户端 | **是** | 真机确认能自己重启回来（有快照与自检记录、没有触发回滚、不会双开）；这是客户端自己的事，不在托管端的矩阵里 |
| pm2 / forever | 否，只有单元测试 | 识别与行为由单元测试钉住 |
| 容器 / compose | 否，只有单元测试 | 同上 |
| `npx` / `pnpm dlx` 包装 | 否，只有单元测试 | 同上 |
| 由别的 DSH 插件拉起 | 否，只有单元测试 | 同上 |
| tmux / screen / SSH 会话 | 否，只有单元测试 | 同上 |
| WSL 由 Windows 侧拉起 | 否，只有单元测试 | 同上（认成"认不出"，什么都不做） |

**未实测 ≠ 不支持**：这些路径的行为由单元测试钉住；「没做完整装卸」「只有单元测试」都不等于不支持。若你的环境被认错，请把状态页里的「启动方式 + 识别依据」贴给我们。

### 报告问题

设置页最下面有一组「**报告问题**」：

- 主按钮「**复制诊断信息并去 GitHub 提问题**」：点一下，诊断信息进剪贴板，同时打开一个**已经填好标题和提纲**的新 issue 页 —— 把剪贴板里的诊断信息粘贴进去就行。
- 诊断信息里**没有**你的访问令牌，也**没有**任何密钥：它只有插件版本、平台、是不是桌面客户端、启动方式（连同判断依据）、监管器、重启模式，以及上一次重启的结果（失败时还有失败的那几项自检）。
- 浏览器不让你用剪贴板时（不是安全上下文、或没给权限），插件会把诊断信息显示在一个**可以全选**的文本框里，并提示你手动复制 —— 报告不会因为浏览器说"不"就没了。
- 没有 GitHub 账号？同一组里有一行小字给出邮箱（252170229@qq.com），外加一个「复制诊断信息」按钮。

## 适合谁 / 不适合谁

适合：经常因为装插件、升级、应用崩溃而丢掉正在进行的长任务，希望重启后自动接续的人。

不适合：无法接受应用窗口关闭再重开的人；web 部署但没配 `restartMode: command` + `restartCommand`（重启功能不可用）；**macOS、远程 SSH 无图形环境、容器**（见上面「[支持范围](#支持范围supported-platforms)」：未实测、不支持）；正在跑关键任务的 profile（建议先在测试 profile 验证）。

> **包名说明**：原先的包名在公共 npm registry（npmjs.com）上已被其他作者占用，因此本包更名为 **dsh-autorestart**。

**重启不断线 / Cross-restart continuation for DeepSeek Harness (dsh).**

Agent 在 DSH 重启（插件升级、应用崩溃、用户关闭再打开）之后，可以**自动接续重启前没做完的工作**，不需要人再发一条"继续"。
This Host plugin makes a DSH restart a *resumable* event instead of a dead end: a durable checkpoint, automatic
session resume on boot, durable-goal re-arm, and an agent-callable idle-aware graceful restart.

> 目标与社区插件 [dsh-phoenix](https://github.com/StvLi/dsh-phoenix) 相同，但这一版为 **Windows + DSH Desktop** 原生实现：
> 不依赖 systemd，使用 WMI/schtasks 脱离将要被销毁的 Electron 进程树来重启应用。

---

## 占用 DSH 的哪些位置（安装前请先看一眼）

下面就是它动到的全部位置，没有别的：

| 类型 | 具体占用 |
| --- | --- |
| Agent 工具（6 个） | `continuum_restart`、`continuum_status`、`continuum_cancel_restart`、`continuum_park_goal`、`continuum_recover_now`、`continuum_handoff` |
| HTTP 路由（7 条） | `<healthPath>`（默认 `/__dsh_autorestart`）下的 `GET /health`（另有 `?state=1`、`?gate=1`、`?probeIndex=1`）、`POST /park`、`POST /recover`、`POST /handoff`、`GET /sleep`、`POST /sleep`（收工关机——桌面端和 web 端走的是同一条路由）、`GET /announcements`、`POST /announcements`（一次性新功能公告）；只接受本机回环或已认证的浏览器 |
| 前端槽位（6 个） | `conversation.input.left`（待重启小胶囊，id `autorestart-restart-pill`）、`sidebar.session.row.leading`（侧栏状态圆点，id `autorestart-restart-dot`）、`conversation.input.dock`（一次性安装提问，id `autorestart-backup-choice`；一次性新功能公告，id `autorestart-feature-announcement`）、`sidebar.footer.action`（收工关机的月亮按钮，id `autorestart-sleep-button`）、`shell.overlay`（倒数浮动卡片，以及**主界面居中的重启阶段浮层**：`autorestart-sleep-overlay`、`autorestart-restart-overlay`）、`settings.section`（设置页里的「自动重启与关机」分区，id `dsh-autorestart`；保存回执也渲染在这个面板**内部**，不占窗口级浮层） |
| 系统提示词 | 一段「重启政策」说明，告诉 agent 怎么请求重启、插件会做什么 |
| 宿主事件 | `agent/status`（跟踪哪些会话在忙）、`tools/pre-execute`（拦下"手动杀/重启 DSH"的 shell 命令）、启动时的恢复流程 |
| profile 行 | 一条 bundle 行：`dsh-autorestart` |
| 写文件 | 只在 `<DSH_HOME>/storages/dsh-autorestart/` 下写：`state.json`（检查点）、`backups/`（重启前快照）、`restart-<代次>.cmd` / `restart-<代次>-watch.ps1`（脱离进程的重启 helper）、`last-rollback.json`（回退报告）、`restart-outcome.json`（插件自己判定的那次重启的结论）、`access.json`（当前实例的带 token 访问链接，权限 `0600`）。唯一会写进 profile 的时机是**回退**：把快照里的 `cordis.patch.yml`、`package.json`、`pnpm-lock.yaml` 和 `node_modules` 拷回去 |

## 重启前备份与自动回退

- **每次重启前**先给 profile 拍快照：`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`，以及（默认开启）已安装插件目录 `node_modules`。本机实测：**2.76 秒 / 117.6 MB / 5,562 个文件**。
- 快照放在 `storages/dsh-autorestart/backups/<时间戳>/`，带 `manifest.json`；**只保留最新 2 份**，写新快照时自动删旧的。
- **链接安装的插件现在也进备份**（2026-10-30 实测缺口）：本机有 5 个插件是用 `link:` / 联接装的（`dsh-autorestart` 自己就在里面），旧逻辑只把**链接**拷进快照、链接背后的内容一个字节都没有 —— 于是「负责救命的那个插件」自己也救不回来。现在 `manifest.json` 多了 `links: [{name, target, kind, exists, readable, copied, files, bytes}]`（外加 `linkFiles` / `linkBytes`），每个**已启用**链接插件的内容另存 `node_modules-link/<name>/`（本机这五个：**1,216 个文件 / 69.5 MB**）。还原时逐个插件给一行结论：`kept`（目标还在，链接保留，开发目录照旧「改完即生效」）、`replaced`（用备份内容顶替）、`target-missing`、`no-backup`；`restore-profile.ps1 -ForceLinkPlugins` 可以无条件全顶替；看门狗用同一套判定（`decideLinkRestore`），但**只给链接一次机会**（`attempts >= 2` 就顶替）。
- 看护脚本跑在**宿主进程之外**（所以宿主被杀它也活着），等**新实例**最多 **90 秒**（`rollbackTimeoutMs`）：新实例把自己的端口和 boot id 写进 `access.json`，看护脚本据此找到**新实例**的健康端点（桌面版每次 `--port 0` 端口随机，旧端口没有意义）。正常回答就静默退出，**什么都不动**。
- 宿主**一直不回应**时：把快照拷回去 → 写 `last-rollback.json`（含"本次重启之后"的崩溃日志尾部，旧日志不会被误当证据）→ **不会再拉起第二个宿主**（已经起来的那一个由它自己继续，回退分支绝不 `Start-Process` 第二个 app）。
- 拷回本身也有**时间上限**（`rollbackCopyTimeoutMs`，默认 120 秒/步）：拷不完就放弃，并把原因写进报告。
- **托管模式（`restartMode: command`）也有同一张安全网**：重启命令通常会把插件自己所在的进程一起杀掉，所以看护脚本在命令**之前**就启动了，由它来确认新实例有没有起来。命令起不来或以非零码退出时，插件**如实报错**（带退出码和输出）并把快照拷回去，绝不静默当成功。
- 下次启动时 `continuum_status` 会报 `lastRollback`（时间、等了多久、是否回滚、**失败原因**、快照路径、崩溃日志名与尾部摘要）。
- **回滚目标是「有一次启动跟在它后面的那份」，不是「最新的一份」**（用户决定，2026-10-30）。每份备份旁边有一张 `meta.json`，**它只记事实**：什么时候拍的（`takenAt` / `at`）、由什么动作触发（`trigger`——`first-install` / `pre-restart` / `manual-rollback`）、这份是多少版本（`version`）、内容指纹（`contentFingerprint`）、以及那次启动的结果（`boot`：`started` 主机起来没有、`contentMatched` 跑的是不是这份内容、`loadFailures` 有没有插件加载失败）。**身份不写在磁盘上**：`known-good` / `snapshot` / `unknown` 是宿主**读取时按这些事实派生**的——有启动记录（或它是首装那份）→ `known-good`；后面还没有任何一次启动 → `snapshot`；读不到 `meta.json`、旧记录里也没有可用的启动记录 → `unknown`。**名字和「能不能被自动还原」是两道判据**：名字只看有没有启动记录；能不能被自动还原是更窄的第二道——那次启动**起来了**（`started`）**且跑的就是这份内容**（`contentMatched`），所以叫 `known-good` 不等于能自动还回去。这个身份记的是「拍完之后发生了什么」，**不是**对里面插件能不能用的评价。**这次重启前拍的那份永远不是回滚目标**，因为它可能正是坏掉的那一份（「改坏了插件再点重启」就是这个场景），要等后面那次启动证明过它才算数。第一次安装时会种子一份首装副本（`trigger: first-install`）；每次启动后（四项自检全过，或托管模式探活答了、且跑的就是这份内容）把那次重启前的快照记上 `boot`。
- **没有可回滚的身份就一份都不还原**：找不到最新的 `known-good`（即上一次启动成功之后回写的那份）时，回滚什么都不做，报告里写 `no-known-good: <原因>`，profile 保持失败重启后的原样，看门狗也**不挂**（没有可还原的目标，挂上去只会再把坏配置写一遍）。
- **可以手动回退到任意一份备份**（含更早、后面没有启动记录的那份，用户决定 2026-10-30）：设置页每行都有「回退到这一份」，点了先弹**二次确认**（写清还原哪一份、当前状态会被覆盖、还原后会自动重启），确认后才动，取消则什么都不发。服务端 `POST /__dsh_autorestart/rollback-to` 只收**备份目录名**（必须是本机列表里的那一份，路径 / 路径穿越直接拒绝），顺序是先存一份当前快照（`reason: before-manual-rollback`，所以这次回退本身还能再退回来）→ 再还原选中的那份 → 写 `last-manual-rollback.json` 回执 → 走既有重启流程请求重启（插件自己绝不 kill 进程）；当前状态存不下来、或看门狗正持有回滚锁时直接拒绝（409），不会出现还原了一半。
- 开关：`backupOnRestart`（默认 `true`）、`backupIncludePlugins`（默认 `true`，关掉就只备配置文件）、`maxBackups`（默认 `3`：当前一份 + 之前两份；身份为 `known-good` 的那一份永远不删）、`rollbackTimeoutMs`（默认 `90000`）、`restartCommandTimeoutMs`（默认 `30000`）、`rollbackCopyTimeoutMs`（默认 `120000`）。

### 这台电脑不让建计划任务时（自动回滚就没了）

上面那张安全网挂在一个**一次性计划任务**上：把宿主拉回来的看护脚本，是一分钟后才触发的一次性任务。有的机器**建不了**这种任务（公司策略、锁死的账号、没有权限），那么这张网就是**悄悄没有**的。

所以插件**只查一次**（第一次在这台机器上跑的时候），然后在设置页里如实说：

- `自动回滚：可用` —— 网在。
- `自动回滚：**不可用**` —— 并且说清**会丢什么**：*重启后 DSH 起不来时不会自动恢复*。这一行直接指向「出事了怎么办」里的还原脚本，那就是出路。

**这里有意不做的事：**

- **不做降级链路**：没有「那改用启动文件夹」「那改用 systemd timer」这类备用机制，也没有"第一个不行就试第二个"。
- **不绕过策略**：插件不会去找"别的办法绕过去"。机器说不行，就是不行，答案只有"不可用"这一句。

**检测失败绝不等于安装失败**：插件照常工作，缺的只是那张安全网。检测本身是无害的：注册一个两分钟后触发、什么都不干的任务（`cmd /c exit 0`），回读校验，删掉，再回读一次确认它真的没了。它**只跑一次**（不是每次打开设置页都跑），而且**不留任何任务**（哪怕中间某一步失败也会清理干净）。

### 重启后的访问链接（token 是一次性的）

`dsh web` 的 boot token **每个进程都不一样**，重启后浏览器手里那条旧链接会 401，用户就被挡在门外。所以插件把当前实例的访问链接写进 `storages/dsh-autorestart/access.json`（权限 `0600`，里面是密钥），并在 `continuum_status` 与日志里报出来；前端发现手里那条链接过期时，会自己跟到新链接上。

### 看门狗：三种触发方式

上面的回滚需要有人**等**：宿主被重启了，得有个一次性的东西发现新宿主一直没起来。那个东西就是**看门狗**（`scripts/watchdog.mjs`）。而"怎么让它稍后跑起来"是各台机器最不一样的地方，所以插件挑这台机器有的最好方式，并且**说清楚挑的是哪一种**：

| 档 | 机制 | 用在哪 |
|---|---|---|
| `scheduled-task` | 一次性 Windows 计划任务（建完**回读校验**，之后**完全删掉**） | 桌面客户端、Windows 上的 `dsh web` |
| `systemd-run` | systemd 用户定时器（`systemd-run --user --on-active=…`），结束后 `reset-failed` 清掉 | Linux 上的 `dsh web`、有 systemd 的 WSL |
| `detached-process` | 自建后台进程（`setsid nohup sh -c 'sleep …; …'`），pid 写在 stateDir 里 | 容器、没有 systemd 的 WSL |
| `none` | 这台机器上什么都没有 | 那就**没有自动回滚**，设置页会明说 |

**由一个函数决定**（`lib/watchdog-tier.js`），设置页、diagnostics 和看门狗自己问的都是这同一个函数 —— 所以"这台机器没有自动回滚"这句警告**不可能**和插件实际做的事对不上。

三档跑的是**同一套**流程（`lib/watchdog.js`）：等新宿主写下 ready 标记 → **再问一次**（起得慢不等于死了）→ 有实例活着吗（活着就没什么好还原的）→ **直接问宿主自己的 health 路由**（只要它在应答就绝不还原；一个端口都问不到时，再等一轮、复查标记，仍然没动静才允许还原）→ 抢共用的锁（`rollback.lock`，保证只有一个在还原）→ **这一轮的顺序是固定的：还原快照 → 清掉过期的 `dsh-auth-*` 通行证 cookie → 再拉起宿主 → 等 ready**。

每一轮最多试 **`maxAttempts` 次**（默认 3 次，代码里有硬上限，**不会无限重试**）：一轮没起来就先退避（5s / 10s / 20s，封顶），然后在**下一轮开始前重新问那三个问题**——宿主可能只是起得慢（那就 `not-needed`，绝不再拉一次），也可能已经有实例活着（那就 `abandoned`，绝不造成双开）。快照只在**第一次**还原（同一个快照再拷一遍不会改变任何事），**但每次都先清通行证再拉起**：带着过期 cookie 拉起来就是再死一次（71 个 cookie 就够把 Cookie 头撑过 16 KB）。

**失败也一定留报告**：无论成功失败、早退还是放弃，每一轮都会写进 `<stateDir>/last-watchdog-report.json`（用的是哪一档、`healthCheck` 是什么、试了几次、每次的 `restored` / `cookieClear` / `relaunched` / `ready` / 退避时间、以及为什么）。**报告不落盘就等于没发生** —— 这是 0.8.6 修掉的三个毛病之一（"只许跑一次"、"拉起前不通行证"、"报告不落盘"）。


**撤销看门狗是宿主的责任，而且开机就做。** 插件一加载就会写下 ready 标记、删掉 `watchdog-pending.json`、并把自己注册的调度项删掉（带退避重试，删完回查计划任务，过程写进 `<stateDir>/watchdog-disarm.json`）。它**不等任何人来打 health 接口** —— 没人开界面时看门狗也必须被撤掉；撤销失败会出现在 `health`、诊断文本和那份记录里，而不是悄悄消失。这就是 0.8.2 修的那个线上缺陷：一个被 health 路由吞掉的异常，让一个健康宿主背后留着一只看门狗。

**同一时刻只有一个监护者。** 插件里还有一版旧的看门狗（只还原快照、**不拉起**宿主）。两者抢同一把锁，同时开反而更糟：抢不到锁的那个会放弃 —— 要是新版抢输了，结果就是**配置还原了，但没有任何东西在跑**。所以插件只在一个地方做这个决定（`lib/watchdog-arbiter.js`）：**新版能用就是新版接管**（v2），新版用不了（这台机器没有档位、看门狗被关掉、或者注册失败）才**回落旧版**（v1）。报告里写着当时是谁在监护（`arbiter: "v2"` 或 `"v1"`），一眼就能看出来。

`watchdogEnabled: false` 可以整个关掉它。

### 看门狗**不覆盖**什么（重要，别指望错）

这套东西是一个**窗口**，不是常驻保安：

- 看门狗只在**我们自己要重启宿主**的那一刻才布防：它是被杀掉之前注册的一个一次性项，宿主起来后还会把它撤掉（删 `watchdog-pending.json`、写 ready 标记、删调度项）；
- **窗口之外没有任何人看着。** 凌晨被系统杀掉的宿主、手动双击启动即崩的客户端、早上来了发现 0 个进程 —— 这些时候**没有看门狗会把它拉回来**：插件本身已经随着宿主死了，也没有任何一次性项被注册过。这种情况只剩 `scripts/restore-profile.cmd`（自己双击）能用；要是连 profile 都被官方清空了，那就什么都没有；
- 看门狗只**还原一份快照 + 把宿主拉起来**，它修不了宿主自己的 bug：每次都因为同一个原因死的宿主，最后就是 `failed` 加一份写明试了几次的报告；
- `watchdogEnabled: false`、或者这台机器没有档位（`none`），就**完全没有自动回滚**，设置页会明说。

### 报错型故障：插件没加载成功时，只提示，不自动修

「坏法」有两种，**两种由两个机制分别负责，互不插手**：

| 故障 | 谁负责 |
|---|---|
| **进程级**：宿主根本起不来（端口冲突、启动即崩） | 重启前快照 + 看门狗：回滚一份快照、把宿主拉起来 |
| **报错型**：宿主起来了，但某个插件 entry **静默没激活**（功能直接 404） | 本节：检测 → **只提示** → 用户点一下才恢复**那一个**插件 → 写报告 |

启动日志里其实写着答案（`<plugin>: failed to import: <错误>`、`<plugin>: import failed …`、`- <plugin>: loading`，以及总括行 `dsh: warning: N entry did not activate`），原来没有任何人读它。现在每次启动、写 ready 标记**之前**都会读**上一次启动**那份日志：

- **只检测，绝不自动改文件、绝不自动重启。** 实测证明 DSH 自己就会剔除坏插件并照常起来（桌面版 22 秒正常启动、坏插件路由 404、配置不动；WSL 托管版 2.0–2.6 秒起来、`package.json` md5 五次一致、守护脚本 62.9 秒内只 +1 次启动）。所以启动路径上**不调用**恢复、**不请求**重启：它只读日志、只写自己的报告。单测钉住了这件事：恢复前后 profile 里每个文件的 sha256 不变、没有任何 `<plugin>.broken-*` 证据目录、`state.restart` 仍是空。
- **报告**：`<stateDir>/last-plugin-recovery.json`（`{ at, atIso, failures[], actions[]（恒为空：什么都没做）, restartRequested: false, needsHuman: false, backupKind, restoredAt }`），其中 `restoredAt` / `backupKind` **取自备份自己的 `meta.json`**——那张文件只记事实（何时拍的、什么动作触发的、内容指纹、那次启动的结果），`backupKind` 是宿主按这些事实**派生**出来的身份，磁盘上并没有这个字段——回答"有没有备份可恢复、恢复到哪个时点"。同一个对象也出现在 health 路由的 `pluginRecovery` 字段和 `continuum_status` 工具里（没发生过就是 `null` / 不返回）。
- **前台弹窗**：界面上直接说「有插件没加载成功」，列出是哪个插件、报了什么错（最多 3 条，其余只报数量），并给**一个**按钮「只恢复 <plugin>」。没有可用备份时按钮不出现，直接说只能手动处理。
- **按需恢复只动那一个插件**（`POST /__dsh_autorestart/plugin-restore`，body `{ "plugin": "<name>" }`）：备份里有 `node_modules/<name>` 真副本 → `overwrite`：现场目录**改名**成 `<name>.broken-<ts>`（**留证据，不删任何文件**），副本拷回去；备份里只有 `node_modules-link/<name>`（链接安装的内容）→ `replace-link`：现场软链同样改名留证据、备份内容顶替。别的插件、以及 profile 的 `package.json` / `cordis.patch.yml` **一个字节都不动**（单测逐字节钉住）。
- **幂等**：现场已经等于备份 → `already-consistent`，**不写任何文件、不要求重启**；按钮点两次是安全的。
- **失败也是个答案**：没有备份 / 拷不进去 → `ok:false` + 原因，而且 **HTTP 200**（JSON 报错体）。用 500 会让浏览器分不清"没有备份"和"宿主崩了"。
- **历史**：每次尝试写 `<stateDir>/plugin-restore-history.json`（最近 20 条，最新在前）；health 的 `pluginRestore` 字段带最近一条，所以弹窗能说"已经恢复过、重启后生效"。

### 开机自启：插件自带的守护

手动启动的托管实例（`dsh web`）挂掉之后不会自己回来——没人拉起来的重启，就等于要用户自己再启动一次。插件可以装一个**守护**：一个独立的小进程，负责拉起宿主、看住它、它掉了再拉起。

- **它是独立进程**：插件活在宿主里，宿主一死插件也没了，所以插件不可能是"把宿主拉回来"的那个东西。守护是随包发布的零依赖 Node 脚本（`supervisor/supervisor.js`），安装时被复制到 `storages/dsh-autorestart/supervisor/`。
- **它做什么**：用 `supervisor.json` 里的命令拉起宿主 → 等它退出 → 退避（1 秒起，每次翻倍，30 秒封顶；**只有真正起来过一次才清零**）→ 再拉起。宿主完全起不来时，把上次重启的快照恢复回去。
- **怎么登记自启（都不需要管理员）**：
  - **Windows**：计划任务 `dsh-autorestart-web`（`/SC ONLOGON /RL LIMITED`）。若该机策略不允许普通用户建计划任务，会自动降级到「启动文件夹」里的一个 `.cmd`（同样零权限、同样是"登录时"）。
  - **Linux / WSL**：systemd **用户**单元（`~/.config/systemd/user/dsh-autorestart-web.service`）。没有系统服务管理器的机器（容器、没开 systemd 的 WSL）根本没有"开机自启"这回事——插件会明说，并把启动命令交给用户。
- **每个平台各有一份「开机自启怎么做」的引导**（设置页会显示，连带可复制的命令）：

  | 托管平台 | 插件怎么做 |
  |---|---|
  | **Windows** | 计划任务（`/SC ONLOGON /RL LIMITED`，不要管理员）；这台机器拒绝时降级为「启动文件夹」里的 `.cmd`。注册的命令是**真 node** + `supervisor.js`，绝不是 DSH 客户端本体。 |
  | **Linux（非 WSL）** | systemd **用户**服务；并提示 `loginctl enable-linger <user>`——**不开 linger 就只是"登录后自启"，不是"开机自启"**。 |
  | **WSL（有 systemd）** | 同样的用户单元 + linger 提示。 |
  | **WSL（无 systemd）** | 这里根本没有"登录时自启"：两条路 —— ① 在 WSL 内部开启 systemd（`/etc/wsl.conf` → `[boot] systemd=true` + `wsl --shutdown`；**这是系统配置改动**）；② 在 Windows 侧用计划任务/启动文件夹拉起 WSL（`wsl.exe -d <distro> -e <命令>`；**需要 Windows 侧操作，但更接近真正的开机自启**）。WSL 里**永不**建议容器编排那套做法 —— WSL 的编排器是 Windows 本身。 |
  | **容器 / k8s** | 不承诺开机自启：由编排器负责（compose 的 `restart: always`）。 |
  | **认不出** | 不装任何东西、不猜命令：说明原因，让用户自己选。 |

  只**猜成** WSL（仅凭挂载的 Windows 盘）时，插件**什么都不替你做**：只提示"没把握，建议手动选一条"。
- **装多少次都只有一个**：任务/单元名是固定的，计划任务用 `/F` 覆盖，守护自己还持一把独占锁——两个守护不可能并存。
- **装到一半失败不会留残骸**：某一步失败时，已经写下的 unit（或计划任务）会被撤掉，回滚过程也报在步骤列表里——半装的守护会在下次登录拉起一个过期的。
- **命令名不会被拼两次**：一步里程序名放在 `file`、参数放在 `args`，所以跑的是 `systemctl --user enable --now …`，而不是 `systemctl systemctl …`（那会让 systemd 回一句 "Unknown command verb systemctl"）。
- **随时可以还原**：安装前先把原来的 `restartMode` / `restartCommand` 存下来，卸载时写回去。设置页有「开机自启 → 卸载」一个按钮，手动收尾的命令也印在卡片和日志里；卸载哪一步没做完，会把待办**写下来**（`UNINSTALL-PENDING.json`，放在守护目录**旁边**的 `<stateDir>/` 下，所以写它不会把守护目录又拽回来），而且**只有真的还有残留时**才写。
- **第一次会问一次**：托管实例第一次出现时问一句"要不要装守护"。卡片写清**会改什么 / 需要什么权限 / 怎么卸**。选「保持我现在的启动方式」什么都不改——插件只记录"你已经自己有守护了"（于是永远不会装第二个）。

桌面版**不问**：它自己就能把自己拉起来（`restartMode: app`），问了是噪声。桌面版**也装不了**守护：登录自启记录会去跑 Electron 客户端本体，那等于**每次登录再开一个 DSH**（双开）。所以桌面版上 `plan` / `install` 直接回 `ok: false`、`error: "desktop-manages-itself"`、步骤列表为空；设置页显示 `mode: "app"`（`restartCapable: true`），不会再吓唬用户"重启能力不可用"。

守护的启动命令**必须指向一个真正的 Node**：进程本身就是 node 时用它，否则去安装目录里找 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`，再退到 PATH 里的 `node`。**绝不拿应用 exe 冒充 node**；一个都找不到就拒绝安装并说清原因。

### 这个宿主是怎么被拉起来的（启动方式矩阵）

Web 端的启动方式有十几种，插件必须**每一种都适配对**。分类器是一个**纯函数**（`lib/startup-mode.js`）：输入是父进程链 / 环境标记 / 容器标记 / 平台，输出是 `{mode, kind, evidence, selfReplay, canInstallSupervisor, suggestion}`。

| 启动方式 | `mode` | 插件怎么做 |
|---|---|---|
| 裸终端 `dsh web`（前台） | `bare` | **可以**装自家守护；不装则给出推导命令 + 确认 |
| `nohup … &` / `setsid` 后台 | `bare` | 同上，但重拉命令**脱离shell**（`setsid nohup …`），不随启动它的 shell 退出而死 |
| shell 守护脚本（`supervise-*.sh`） | `external` | 只优雅退出（`selfReplay: refused`）——脚本会把它拉回来 |
| systemd（user / system 单元） | `external` | 只优雅退出（依据：`INVOCATION_ID` 或父进程链） |
| pm2 / forever | `external` | 只优雅退出 |
| docker / compose / k8s | `container` | **不承诺开机自启**：给 compose `restart: always` 片段；容器里不装 systemd |
| Windows 计划任务 / NSSM 服务 | `external` | 只优雅退出 |
| WSL 里由 Windows 侧拉起 | `unknown` | **什么都不写**：父进程在 WSL 内看不见——建议选「裸终端装自家守护」，或者自己写一条启动命令（可选） |
| `npx` / `pnpm dlx` 包装 | `bare`（可用）或 `unknown` | `argv[1]` 是解析后的脚本路径就能用；否则拒绝，绝不猜 |
| 别的 DSH 插件拉起 | `external` | 只优雅退出——**绝不双开** |
| tmux / screen / SSH 会话 | `bare` | 走「命令重放」分支，且命令**脱离会话**（优雅退出会断开会话） |

**比表格更重要的两条规矩**：只有 `bare` 的宿主才允许写自重放命令、才允许装自家守护；`unknown` 一律 `selfReplay: 'unknown'` 并且**什么都不装**——插件宁可说"我认不出"，也不在第一个宿主旁边再开一个。

设置页会把判定和**依据**一起显示出来（「当前由 … — ancestor:1234: systemd」），让人看得懂插件为什么这么说。

### 「保持我现在的启动方式」之后：推导重启命令（E）与干跑确认（B）

用户选择保持现状时，插件仍然可以写下一条"能把它拉起来"的命令——但**只能靠推导，绝不猜**。猜错的命令比没有命令更糟：它看起来像重启成功了，实际留下一个起不来的宿主。

候选命令来自进程自己知道的事实：`[process.execPath, ...process.execArgv, ...process.argv.slice(1)]` 加上工作目录。**优先级**决定接下来怎么办：

| 级 | 情形 | 写什么 |
|---|---|---|
| **E0** | 是插件自己的守护把这个实例拉起来的 | **什么都不写**——重启直接问守护（插件先写回滚请求，让守护去杀进程、重新拉起）。 |
| **E1** | 有**外部**监管器（systemd / 用户自己的脚本 / pm2） | **不写**自重放命令：`restartCommand` 变成**优雅退出**（`kill -TERM <pid>` / `taskkill /PID <pid>`），因为是那个监管器负责再拉起我们。装第二个守护会抢同一个端口。 |
| **E2** | 没有守护、也没有 init（容器） | 给出命令 + 一段 compose 片段（`restart: always`），**不承诺**开机自启。 |
| **E3** | 没有守护、有 init（Windows / systemd 可用） | 推导出的命令——但**要用户确认干跑之后**才写。 |

**拒绝**的情形（每种都有代码，也都指出路）：桌面版（它自己会重启）、没有 web 服务端的宿主、读不回命令行、已有外部监管器、没有 init 的容器、以及**端口每次都变**（浏览器的 cookie 会跟着 authority 一起死——端口必须固定）。

**干跑（B）是一个承诺**：命令、工作目录、端口、健康检查 URL 在**写任何东西之前**原样展示。只有明确的确认才会把命令写进 profile 配置；写之前的原值被记下来，设置页一键就能改回去。

- 干跑：`POST /__dsh_autorestart/supervisor` 带 `{ "action": "dry-run" }`（或工具 `continuum_supervisor` 的 `action: "dry-run"`）——**什么都不写**。
- 确认：`{ "action": "apply", "confirmed": true }`——没有 `confirmed` 宿主回 `400 confirmation-required`，同样什么都不写。
- 撤销：`{ "action": "revert", "confirmed": true }`——把原来的 `restartMode` / `restartCommand` 写回去。

### 首次安装只问一次：备份要不要连已装插件一起备

第一次用这个插件时，输入框上方会出现**一条非模态提示**（不是弹窗，不挡输入框，也不会自己消失），问一句：

- **「配置 + 已安装插件」** —— 每次重启多约 3 秒、约 117 MB；插件把启动搞坏时也能一起回退。
- **「只备份配置」** —— 瞬间完成、约 66 KB；插件问题无法回退，需要手动重装。

两个选项共享同一个基底：**配置一定会被备份**，插件只是"要不要额外带上"，不是二选一。

- **只问一次**：只有 `localStorage['dsh-autorestart:backup-choice-v1']` 缺失时才渲染；点任一项都会写下这个键，之后不再出现。
- **关掉也算作答**：按 `×` 或 `Esc` 与点选项写的是同一个「已作答」标记，这个浏览器此后**不会再被问**；关掉等于保留默认（配置 + 已安装插件）。
- **不打扰**：面板是 `role="status"` 的普通块，放在输入框下方的 dock 里；可聚焦、键盘可达、`Esc` 关闭。
- **答案存在哪**：宿主用官方 `configEditor` Service 写进 profile 配置（就是设置分区里那个 `backupIncludePlugins` 键，**只有一份真相**）。万一这个服务不可用，才退化到写 `<DSH_HOME>/storages/dsh-autorestart/install-choice.json` 并在日志里 `warn`。**托管 profile 如果自己没有声明 `dsh-autorestart` 行**，就没有行可写，答案同样落在这个文件里而不是 profile 里 —— 声明那一行（见「平台与部署」）才能让 profile 配置保持唯一真相。
- **想改主意**：设置 → 自动重启与关机 → `backupIncludePlugins`。`continuum_status` 里随时能看到当前生效值（`backupIncludePlugins: true | false`）。

### 升级也会被告知一次：从旧版升级会看到一次新功能公告

**它补的漏洞**：上面那两个安装提问只在**首次安装**时出现一次。已经装好的老用户升级之后，**新功能对他们等于不存在** —— 新做的「收工关机」月亮按钮，老用户根本不会知道。所以从 **0.5.0** 起，每加一个新功能，都会在同一个位置（输入框下方的 dock）弹**一次**公告卡片：

> **新功能：收工关机**
> 左侧栏最底部多了一个 🌙「收工关机」按钮。
> 点一下 → 所有会话收工后倒数 **N 秒**关机。
> 想改行为，去「设置 → 自动重启与关机」。
> **知道了**

- **只有升级才会看到**：宿主把「这个功能的版本」和「已经展示过的版本」比一比（记在检查点文件的 `seenFeatureVersions` 里）。**新装**的用户不会看到这张卡 —— 安装提问已经把功能讲清楚了，答完就等于"已看过"。
- **「看过」= 记录版本不低于当前功能版本，不是「等于」**：记录的版本只要**不低于**当前的功能版本就算看过 —— 功能停在 `0.5.0` 时，记录是 `0.6.0` 也算看过。**为什么不按等值判**：记录里写的是「当时公告带的版本」，而 0.6.0 之前公告带的是**包版本**，所以按等值判就会告诉一个早就点过「知道了」的用户「你还没见过」；那条记录只说明他在哪个版本上点过，不说明他没看过这个功能。记录根本不是版本号（比如坏记录）时也算看过 —— 宁可少打扰，也不要因为一条坏记录天天弹卡片。
- **每个功能版本只弹一次**：点「知道了」→ 宿主记下版本 → 卡片立刻消失 → **以后再也不出现**（重启宿主不会，升级发下一个版本也不会 —— 除非功能的版本比记录的更新，那时才再公告一次）。
- **公告跟的是「功能」，不是「发版」**：公告带的版本号是源码里的常量 `SLEEP_FEATURE_VERSION`（`index.js`），**不是** `package.json` 里的包版本 —— 所以发版不会把老用户已经点过「知道了」的卡片再弹回来。（0.6.0 之前公告带的是包版本，于是 0.5.0 → 0.6.0 每发一次版，「收工关机」就重弹一次。）
- **想主动再公告一次**：把 `SLEEP_FEATURE_VERSION` 调到**比最后记录的版本更新**的数即可 —— 卡片就再出现一次。但**只在功能本身变化大到必须再讲一遍时**才调（比如关机改成了完全不同的用法、按钮换了位置）；**发版、修 bug、加小功能都不要动它** —— 那正是这个常量要防的坑。
- **没点不会静默吞掉**：卡片一直挂在那里等你回答；不回答，下次启动还会再出现一次。
- **秒数是读出来的，不是写死的**：卡片里的秒数就是当前生效的 `sleepCountdownSeconds`；月亮按钮被关掉时，卡片还会补一句「按钮目前关闭，可在设置里打开。」
- **状态存在哪**：`<DSH_HOME>/storages/dsh-autorestart/state.json`（和插件的检查点同一个文件）。宿主用 `GET /announcements` 报（`{ ok, pending: [{ feature, version }] }`），用 `POST /announcements`（body `{ feature }`）记。里面的 `version` 就是功能版本，跟 `SLEEP_FEATURE_VERSION` 是同一个数。

## 工作方式

```
agent/status(running) ──► 写 checkpoint（<DSH_HOME>\storages\dsh-autorestart\state.json，原子写）
        │
        ├─ continuum_restart 工具：checkpoint 标记 pendingResume + generation+1，轮询等 idle
        │        ├─ goal 驱动的会话：判定"被阻塞"之前先 goals.disarm() 解除 → 当前轮跑完、会话变 idle（disarmed 记录落盘）
        │        └─ 全空闲 ──► WMI 创建脱离进程树的 cmd：ping 延迟 → taskkill 整个应用 → 重新启动 exe
        │
        └─ 进程意外死亡 ──► 下一次启动时，旧 bootPid 记录里 running=true 的会话被判定为“中断”
                                   │
新进程 boot ──► apply()：beginBoot()（新 pid ⇒ 新 bootId）──► recoveryDelayMs 后恢复
                                   │
                    ┌──────────────┴──────────────┐
            session 有 active+disarmed 的 goal     无 goal（或 goal 不可续）
                    │                              │
          ctx.goals.resume(agent, ref)    agent.followup(<续接消息>)
                    │                              │
       goal round driver 自动开下一轮      一条带 <continuum_resume> 标记的续接消息
```

- **恢复是"至多一次/每次启动"的**：恢复尝试先原子落盘 `resumeAttempts`，再执行副作用；同一 bootId 内的热重载（HMR）不会重复恢复；
  未变化的 pid 不会被误判为重启（`bootPid` + `bootId`）。
- **冷会话用官方入口恢复**：`ctx.sessionController.resolveAgent(sessionId)`（会做 agent preset 组装）；
  续接消息通过 `agent.followup(...)` 进入该会话的 next-turn 队列 —— 不用 `sessionController.prompt`，
  因为它的进程内签名是 `prompt(request, signal)` 且会硬编码 human `user` source。
- **续接消息是普通 user message**，`source.kind='continuum'`（非 human authority）、内容明确标记
  `<continuum_resume>`，模型能看到完整历史后自行判断中断点。

## 对宿主版本的要求

**需要 DSH ≥ `0.1.6-alpha.2`。**

从 `0.1.6-alpha.2` 起，宿主把「有插件没起来」分成两类处理：

- **普通插件**（你自己写的、从 npm 装进来的）加载失败**不会阻断启动**：宿主照常起来，只记一条 `warning: N entry did not activate`，其余插件继续运行。本插件的「这些功能这次没起来」提示，读的就是这条日志。
- **必需插件**（宿主自己的零件，例如网页服务）加载失败**仍然会让启动失败**：日志是 `startup failed: N required plugins did not activate`。看门狗负责的正是这一种 —— 宿主起不来时，用一份身份为 `known-good` 的备份还原，再把宿主拉起来。

`0.1.6-alpha.1` 及更早的版本没有这个区分：任何一个插件加载失败都会直接抛错、宿主起不来，本插件依赖的那条检测信号在那类宿主上根本不存在。

**这条结论是怎么来的（如实说明）**：逐版核对 DSH 官方 npm 包 `@deepseek-ai/dsh-app-boot` 的实现得出，对比了 `0.1.0-rc.2` / `0.1.3-alpha.2` / `0.1.5-rc.3` / `0.1.6-alpha.1` / `0.1.6-alpha.2` / `0.1.7-rc.2` / `0.2.0-rc.1` / `0.2.1-rc.3` / `0.2.2-alpha.2`，分界落在 `0.1.6-alpha.2`。**DSH 官方发布说明里没有一条明写这件事** —— `0.1.6-alpha.2` 的相关条目只说「启动失败时分类显示错误和等待中的服务，并将完整诊断保存到日志文件」。所以这不是官方声明，是源码核对加本机实测。

## 安装

当前版本：**0.8.6**。

```powershell
# 在 dsh 里（或对 Agent 说）：把工作区里的这个包安装为 profile bundle
#   plugin_manager install_bundle  target = <本目录绝对路径>
# 等价命令行（需要 dsh CLI）：
dsh plugin --profile desktop add C:\path\to\dsh-autorestart
```

安装后行 id 为 `dsh-autorestart`。本机已经装好并处于 `active`。

## 起不来怎么办（装了插件之后 DSH 打不开）

**先分清是哪种情况**：整个环境坏了（改了配置、装了别的插件、升级崩了）→ 先回到上一次好状态；**只有这个插件可疑** → 直接走下面三步，把这个插件摘掉就够了。（两个脚本各自的边界见 [`scripts/README.md`](../scripts/README.md)。）

**用你自己平台的脚本** —— Linux 机器上没有 `.cmd`，Windows 机器上也没有 `.sh`：

| 你的机器 | 回到上一次好状态 | 摘掉本插件 |
|---|---|---|
| **Windows**（桌面客户端、Windows 上的 `dsh web`） | 双击 `scripts\restore-profile.cmd` | 双击 `scripts\emergency-disable.cmd` |
| **Linux / WSL / macOS**（托管端） | `sh scripts/restore-profile.sh` | `sh scripts/emergency-disable.sh` |

每个平台到底有什么、没有什么，看 [平台能力矩阵](platform-matrix.md)；设置页的「出事了怎么办」只显示**你这台机器上真有的**那两个路径。

**不用等 DSH 跑起来**就能把这个插件摘掉 —— 插件目录里带了一个一键开关：

1. **Windows**：双击 `scripts\emergency-disable.cmd`；**Linux/WSL**：`sh scripts/emergency-disable.sh` —— 它会写清楚做了什么；
2. **重启 DSH**（关掉再打开）——这次没有这个插件，DSH 就起得来；
3. 以后想再试它：Windows 用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\emergency-toggle.ps1 -Action enable`，Linux/WSL 用 `sh scripts/emergency-disable.sh --action enable`，然后再重启 DSH。

它只动**一个文件**里**一个数组**：profile 的 `package.json` 里的 `dsh.profile.bundles`（就是「插件启用列表」那几行）。写之前先备份成 `package.json.bak-emergency-<时间戳>`，写完重新解析一遍 JSON 校验；校验不过就用备份回滚，并如实报错。**重复运行没有副作用**：本来就没启用时只会告诉你「已经禁用」，不会失败。

## 配置

设置页里关于「备份」「回执」和「启动方式」的几块，先说清楚它们看的是什么：

- **现在备份了什么**（在两个备份勾选的下面）：宿主真的去读 `<DSH_HOME>/storages/dsh-autorestart/backups/`，所以份数、每份的**本地时间**、这些备份**总共占多少磁盘**、以及存放路径都是真的。只有目录元信息被读，备份里的内容**不遍历**（一份就可能 150 MB）。没有备份时写的是「还没有备份；每次重启前会自动生成一份」。每份备份就是一行，只带两样东西：它的**备份时间**，和这一行唯一能做的那件事（「回退到这一份」）。**行上没有大小**——总占用只在列表上方出现一次，写作「实际占用 156 MB，当前 2 份」。列表**不判定哪一份安全**——插件不再替读者下这个结论（用户决定，2026-11-02）：一行就是一个时间和一个按钮，判断权在使用者：

  ```
  实际占用 156 MB，当前 2 份

  备份时间 2026-10-29 22:08   [回退到这一份]
  备份时间 2026-10-29 21:44   [回退到这一份]
  ```

  某一行还可能多出一句中性说明，它不是结论：**最近一次启动时拍的那一份**会写「这是最近一次启动时的状态。DSH 能启动不代表插件都正常——坏掉的插件会被排除，主机照样起来。要回退到哪一份，请自己判断。」这句话按该份自己的记录挂上去，不按它在列表里的位置。

  身份仍然存在，但**磁盘上不存**：每份旁边的 `meta.json` 只记事实——`at` / `takenAt` / `trigger` / `version` / `contentFingerprint` / `boot`（那次启动起来没有、跑的是不是这份内容、有没有插件加载失败），而 `kind` / `certifiedBy` / `certificationEvidence` 这些身份字段是宿主**读取时按这些事实派生**出来的，写盘时不再出现。派生出来的身份有三种取值——`known-good`（有一次启动跟在它后面，或者它是首装那份）、`snapshot`（每次重启前刚拍的，后面还没有任何一次启动）、`unknown`（身份层之前的旧拷贝，或者没有身份文件，不参与自动回滚）。**名字叫 `known-good` 不等于能自动还回去**：能不能被自动还原是更窄的第二道判据——那次启动**起来了**（`started`）**且跑的就是这份内容**（`contentMatched`）。这个取值记的是「拍完之后发生了什么」，**不是**对里面插件能不能用的评价；浏览器读不到 `meta.json`，宿主给的 `backups.items[].kind` 仍是它派生后递过来的值，行上不打印任何身份。

  时间就是拍快照那台机器的本地时间，**精确到分、不带时区偏移**（`+08:00` 只会添乱——看的人本来就看自己的钟）。整个备份目录的占用自动选单位（`92 KB` / `156 MB`），只在有意义时保留一位小数（`117.7 MB`，永远不写 `156.0 MB`）；它只在列表上方那段汇总里出现一次，**不在任何一行上**，也不带「（含已装插件）」这类括注。两份备份就是两组，组与组之间留空隙。
- **设置改动有回执**：每个开关/下拉都是改了就写，所以面板必须说清写没写进去——宿主回 `ok: true` 之后，**设置面板内部顶部**（面板自己的 `sticky` 条，往下滚动也一直可见）出现绿色**「已生效」** + 小字时间（`已生效 21:40:12`），3 秒后淡出；被拒绝时是红色**「没保存成功」** + 宿主给的原因，不自动消失，直到下一次改动成功或你自己点 × 关掉。**宿主没回话之前一律不显示**：首次渲染、轮询刷新、点控件都不会亮。
- **启动方式**（Web 托管端才有）：默认只给**一行大白话**（例如「我记下的启动方式：由你的脚本拉起（重启交给它，我不插手）」）加两个小动作（重新检测 / 撤销）；命令原文收在**「技术细节」**折叠里，默认收起，展开才出现。**桌面客户端这一整块不渲染** —— 它自己拉起自己，也不该写 `restartCommand`。宿主说不清是哪一端时，宁可整块不显示。

所有键都有默认值，写在 `cordis.patch.yml` 的 insert 行里；要覆盖就在 profile 的
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里加同名 `- id: dsh-autorestart` 行（**整段替换 config**）。
插件同时导出真实的 `Config` schema（schemastery），所以 Plugin Manager / 配置编辑器里能看到键名、类型与默认值
（见 `GET /__dsh_autorestart/health` 的 `configSchema: true`）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉整个插件 |
| `stateFile` | `''` | 检查点路径；空 = `<DSH_HOME>/storages/dsh-autorestart/state.json` |
| `resumeOnBoot` | `true` | 启动时是否自动恢复 |
| `recoveryDelayMs` | `6000` | 启动后等多久再恢复（给 session store / model 就绪留时间） |
| `maxSessions` | `4` | 一次启动最多恢复几个会话 |
| `maxResumeAttempts` | `2` | 每个会话最多尝试恢复几次（跨启动累计，防重启循环） |
| `deferPollMs` | `3000` | 等 idle 的轮询间隔 |
| `deferSoftMs` | `300000` | **已弃用——读入但完全无效。** 重启等待没有截止时间；仅为兼容旧配置文件保留 |
| `deferHardMs` | `900000` | **已弃用——读入但完全无效。** 重启等待不会放弃；仅为兼容旧配置文件保留 |
| `deferPolicy` | `auto` | 仅为兼容旧配置保留：无论取什么值，等待行为都一样——一直等闸门放行，没有截止时间 |
| `forceRestartWhenBusy` | `false` | 是否允许**打断正在运行的会话**强行重启；默认 `false` = 不打断任何会话，一直等到其他会话结束。这不是截止时间 |
| `restartMode` | `app` | `app` = 重启 DeepSeek Harness 桌面应用；`command` = 跑 `restartCommand` |
| `restartCommand` | `''` | 自定义重启命令，支持 `{pid}` `{ppid}` `{app}` 占位符 |
| `relaunchDelaySeconds` | `2` | 脱离的 helper 在杀掉应用**之前**等几秒（`ping -n 3`，约 2 秒） |
| `settleMs` | `2000` | 静默窗口（ms）：最后一次会话活动之后，宿主要安静这么久，重启才允许开始 |
| `restartGraceMs` | `0` | **重启前等待**（ms）：最后一个会话收工后，再等这么久才真正重启——**下拉框：0 / 5 / 10 / 20 / 30 / 60 秒**，默认 0（不额外等）。重启是日常操作，所以默认不预留 |
| `queuedGraceMs` | `60000` | **排队消息的上限**（ms）：一条没人认领的 inbox 消息最多挡多久的重启；超过就算卡住，不再挡路（并在日志里点名那个会话）。`0` = 没有上限（0.6.2 之前的行为）。**正在跑的会话在任何设置下都照样挡路** |
| `autoReloadPage` | `true` | `dsh web`：host 重启（bootId 变化）后让页面自动 reload |
| `blockManualRestart` | `true` | 硬拦截 agent 用 shell 命令手动杀掉/重启 DSH，并引导到 `continuum_restart` |
| `healthPath` | `/__dsh_autorestart/health` | 健康检查路由（返回 bootId/pid/phase/自检标志） |
| `continuationText` | `''` | 覆盖默认续接提示文本 |
| `backupOnRestart` | `true` | 每次重启前给 profile 拍快照；重启后起不来时能自动回退 |
| `backupIncludePlugins` | `true` | 快照里是否带上已安装插件目录（本机约 117 MB、多约 3 秒）；关掉就只备配置文件 |
| `maxBackups` | `3` | 保留几份快照（当前一份 + 之前两份）；写新的时自动删旧的——但身份为 `known-good` 的那一份永远不删 |
| `rollbackTimeoutMs` | `90000` | 看护脚本等新宿主多久（毫秒），超时就回退快照（**不会再拉起第二个宿主**） |
| `restartCommandTimeoutMs` | `30000` | 重启命令最多让插件等多久（毫秒）。前台跑着宿主的命令永远不返回——那会报「还在运行」，不算失败 |
| `rollbackCopyTimeoutMs` | `120000` | 拷回快照的**每一步**最多花多久（毫秒）：拷不完就放弃，并把原因写进回退报告 |
| `showSleepButton` | `true` | 收工关机的月亮按钮是否显示在左侧栏最底部、设置按钮旁边 |
| `sleepCountdownSeconds` | `20` | **关机倒数秒数**：收工关机在真正关机前倒数几秒——**下拉框：0 / 10 / 20 / 30 / 60 秒**，默认 20；`0` 表示**不倒数、立即关机**（仍会先等所有会话收工）。**这段看得见的倒数就是关机前的那段等待** —— 关机没有第二个看不见的预留 |
| `sleepCommand` | `''` | 收工关机的自定义关机命令；留空 = 自动识别宿主（Windows 用 `cmd.exe /c …`，其它平台用 `/bin/sh -c …`） |

### 为什么收工后还要多等几秒

**我们只看得到 DSH 的会话。** 这个插件知道的是：某个会话还在不在跑、有没有排队的 inbox 消息、最后一个是什么时候闲下来的。它**看不到别的插件用定时器排队的活** —— 比如记忆插件在会话结束后过几秒才把这次对话写进记忆、比如一次总结、一次 MCP 回调、一次日志落盘。对我们来说这些活是不存在的，所以「所有 agent 都闲了」并不等于「现在真的没有事情在发生」。

**只有一个预留窗口，给重启。** 重启没有倒数环节：会话一收工就该赶紧重启。`restartGraceMs` 是留给别的插件延迟落盘的那一小段等待 —— 也是**唯一**的一个：

| 配置 | 管什么 | 默认 | 档位 |
| --- | --- | --- | --- |
| `restartGraceMs` | **重启**前等待 | `0`（不额外等） | 0 / 5 / 10 / 20 / 30 / 60 秒 |
| `sleepCountdownSeconds` | **关机**（看得见的）倒数 | `20`（20 秒） | 0 / 10 / 20 / 30 / 60 秒 |

- **重启闸门只听 `restartGraceMs`**：它等的是 `max(settleMs, restartGraceMs)` 的安静。默认（0）就是只等静默窗口本身 —— 会话一收工就重启。
- **收工关机没有看不见的预留**：关机前的那段等待**就是屏幕上的那段倒数** —— 秒数看得见，用户可以盯着它、也可以点「不关了」取消。再加一个看不见的窗口只是把同一件事说两遍，所以没有了：所有会话一收工，倒数立刻开始。
- **等待期间又有活，重新计时**：预留永远跟着「最后一次活动」走 —— 会话又开始干活，就从那一刻重新等。
- **在哪改**：设置 → 自动重启与关机，分成两个带标题的框 ——「重启相关设置」（重启前等待 + 两个备份开关）在前，「关机相关设置」（关机倒数秒数）在后。
- **怎么排障**：状态接口都带着它们 —— `GET /health?state=1`、`GET /health?gate=1`、`continuum_status` 报 `graceMs`（重启预留）和 `effectiveSettleMs`（闸门真正在等的窗口）；`GET /sleep` 报 `restartGraceMs` 和 `countdownSeconds`（正在走的倒数）；都还带 `quietForMs`（已经安静了多久）。

### 为什么「排队的消息」不能永远挡着重启

**死锁是怎么来的。** 一个会话的 inbox 里躺着一条**没人认领**的消息时，它在重启闸门眼里就算「忙」。消息马上要被领走时这是对的 —— agent 一两秒就来领了；但**没人会领**的时候就是死锁。真实现场就是：UI 里新开的一个**空会话**（一个轮次都没跑过），inbox 里有条没人认领的消息 → 闸门永远关着 → 硬期限到了也只是记一条告警 → **重启永远不触发**。

**上限就是为这件事留的。** `queuedGraceMs`（默认 **60000** 毫秒）是一条没人认领的消息最多能挡多久的重启：

- **窗口内被认领 → 照样挡**：正常情况完全没变，agent 把消息领走，重启继续等它。
- **超过窗口还没人领 → 卡住了**：它**不再挡路**，日志里点名那个占着队列的会话（`the queued message of session <id> has been waiting 61s and nobody claimed it; it no longer blocks the restart`），重启照常往下走。
- **正在跑的会话在任何设置下都照样挡**：这个上限只管**排队**的活，**在跑的轮次永远不放宽**，也没有任何配置能让插件去杀掉一个正在跑的会话。
- **计时跟着活走**：会话开始干活 → 排队计时清掉；之后再排队 → 从零重新计。
- **`0` 就是「和以前一样」**：`queuedGraceMs: 0` 时，没人认领的消息永远挡着重启，和 0.6.2 之前完全一致。
- **在哪看**：`GET /health?state=1`、`GET /health?gate=1`、`continuum_status` 都会报 `queuedGraceMs`。

### 等待的时候，用户看到什么

重启只等一件事：**所有会话把活干完**。没有截止时间、没有任何东西会过期——等多久都等；只有两种情况会结束它：闸门放行（重启执行），或者你自己撤回请求。

等待从第一秒就看得见（不是过了某个阈值才肯说）：

- **请求留着**：待重启仍然是待重启，请求方的会话仍然记在检查点里，闸门一 quiet 就照常重启。**不会在用户背后把请求悄悄丢掉**（不 cancel、不 releaseRequesters）。
- **等待变得看得见**：日志每分钟最多一条（不是每 3 秒刷屏）——「已等待 17 分钟，XXX 一直占着；可以取消或等它收工」；`GET /health?state=1` 里多一个 `longWait` 对象（`since` / `reason` / `blockedBy`）。
- **气泡里也说一句**：待重启的胶囊多显示一行「已等 17 分：XXX 一直占着」（英文：`waiting for 17m: XXX keeps holding it`）。

**不会**为了重启去强杀任何会话：`forceRestartWhenBusy` 默认仍然是关的，这个插件也不会去打开它。

### 安静窗口到底在量什么

重启闸门有两层：**没有会话在忙** + **一段安静窗口**（`max(settleMs, restartGraceMs)`）。

安静窗口只回答一个问题：**距上一次「真的有活」过了多久。** 它从下面两个标记里**较晚的那个**开始算：

- **最后一次真正的活动信号** —— 一轮开始或结束（`agent/status`）、一条消息被排队（`agent/inbox/inserted`）、或者一个说明「确实在干活」的会话事件（消息、工具调用、轮次）；
- **最后一次看见会话在忙** —— 正在跑的轮次，或者排队的消息（`busyAgents()`）。

**例行的会话事件不算活动。** 宿主在界面轮询/状态同步时会持续产生会话事件（标题、投影、请求上下文、已结算的任务），实测每 2~3 秒一个。以前这些都算活动，于是安静窗口每两三秒就被清零 —— **只要窗口比事件间隔长，它就永远凑不满，重启永远不会触发**（这就是 0.6.0 把宽限期从 2 秒抬到 10 秒之后「昨晚正常、今天不动」的原因）。

这条规则是**单边**的：**读不出类型的事件一律不算活动** —— 拿不准的时候宁可早重启，也不要永远不重启。

**正在跑的会话永远挡路。** 安静窗口只决定「什么时候可以重启」；「有没有会话在忙」是硬保证，任何配置都放松不了它。

**重启不动的时候去哪儿看。** 状态接口会把闸门的原因和阻塞者一起报出来（`GET /health?state=1` 里的 `reason`：`conversation-active` = 有会话在忙，`settling` = 只是安静窗口还没凑满，`quiet` = 可以走了）；待重启期间日志里每分钟会写一条诊断行：

```
restart gate: action=wait reason=agents-busy-within-soft-window busyCount=1 quietForMs=1432 effectiveSettleMs=10000
```

`action` 是这次决策做了什么（`wait` / `restart` / `long-wait` …），`reason` 是为什么，`busyCount` 是几个会话在挡，`quietForMs` 是已经安静了多久，`effectiveSettleMs` 是要凑满的窗口。

## Agent 工具与"它怎么知道该用插件"

| 工具 | 作用 |
| --- | --- |
| `continuum_restart` | 请求**优雅重启**：等所有 agent idle 后重启应用，回来自动续接本会话。参数 `reason` / `resume` / `defer_seconds` / `parkGoals`（现在表示"重启前解除 goal 驱动的阻塞"） |
| `continuum_park_goal` | **解除（disarm）**某个会话的 goal，让待重启不再被 goal 卡住；当前那一轮照常跑完，重启之后自动重新上链。参数 `sessionId`（省略 = 调用方自己的会话） |
| `continuum_recover_now` | **立刻重跑恢复**（不用等下一次重启）：重试卡住的会话，返回每个会话的动作 + 原因。参数 `sessionId`（省略 = 所有待恢复会话） |
| `continuum_handoff` | **会话接力**：把一个已经超出模型 context window 的会话交给一个**全新的会话**继续（带去 goal 目标、检查点里记录的接手原因和一段有界的对话尾部），旧会话保留成存档、goal 被解除。参数 `sessionId`（省略 = 调用方自己的会话）/ `maxChars`（默认 `20000`） |
| `continuum_status` | 只读：phase、generation、是否有待重启、检查点路径、识别的重启环境、被记录的会话、每个阻塞会话的阻塞原因、被停泊的 goal |
| `continuum_cancel_restart` | 撤回待重启请求。默认**只撤调用方自己那一份**（`scope: "mine"`），别的会话排队的重启不受影响；`scope: "all"` 才是"所有人都别重启了"。参数 `scope`（`mine`（默认）/ `all`）/ `reason`（写进日志） |

除了工具本身（模型在工具表里能看到名字/描述），插件还有两层保证：

1. **system prompt 段落**（`systemPrompt.section('dsh-autorestart:restart-policy')`，全局、随插件上下线）：
   要重启 DSH 就调用 `continuum_restart`，不要自己 `taskkill`/`Stop-Process`；重启前把进度写进工作区/todo/goal；
   用 `continuum_status` / `continuum_cancel_restart` 查看与取消；**不要求 goal**。
2. **硬拦截工具守卫**（`ctx.tools.guard(...)`，`blockManualRestart` 默认开启）：当 agent 试图通过命令类工具
   （`pwsh` / `bash` / 终端 / `run_code` 等）执行"杀掉或重启 DeepSeek Harness"的命令时，**在 dispatch 之前直接拒绝**，
   返回一段说明并引导改用 `continuum_restart`。命中规则包括：
   - 杀进程类动词：`taskkill` / `Stop-Process` / `pkill` / `kill` / `terminate` / `wmic … delete|terminate` / `kill-port`，
     且命令文本里出现 `DeepSeek Harness`、`DeepSeek*`、`Deep*Harness*` 等进程选择形式；
   - 针对**本 host 进程 pid / 父进程（Electron 主进程）pid** 的 kill；
   - 针对**当前 web 端口**的 `kill-port`（端口从 `webServer.getOrigin()` 读取）；
   - `schtasks /run|/create` 且指向 dsh/deepseek/continuum；
   - **系统级关机/重启**：`shutdown /r|/s|/p|-r|-s`、`Restart-Computer`、`Stop-Computer`（一定会连带杀掉 DSH）。
   普通命令（如 `echo`、`git status`、`git commit -m "…taskkill…"` 不含 DSH 字样、`kill 777`、`npx kill-port 3000`、
   写文件/读文件/网页抓取里提到这些词）不受影响。拒绝次数可在健康路由的 `manualRestartBlocks` 看到。

**残差（诚实说明）**：这是**字符串模式匹配**，不是安全沙箱。编码混淆（`-EncodedCommand`）、按 `node.exe` 镜像名杀进程、
以及命令文本超过 200KB / 嵌套超过 4 层的参数扫描不到；用别的路径（GUI 菜单、外部脚本、系统重启）绕开也不受它管。
它要解决的是"agent 顺手 `taskkill` 自己"，不是防止恶意绕过。

所以**不需要改 AGENTS.md**——这是 Host 插件钩子（工具注册 + system prompt section + tools.guard），对 profile 内所有 agent 生效；
你当然也可以额外在 AGENTS.md 里写一条团队规范，但它只是重复。

### 取消重启：只撤自己 vs 全撤

重启请求是**合并**的：好几个会话可以同时请求同一次重启，插件把每个请求者都记在 `restart.requesters` 里，
重启成功后**一起**被唤醒。所以"取消"必须说清楚**撤的是谁的请求**：

| scope | 会发生什么 |
| --- | --- |
| `mine`（默认） | 只撤掉**调用方自己**那一份。别的会话还在等这次重启 → 重启请求**保留**，`restart.bySessionId` 改指向剩下的第一个请求者；调用方是**最后一个**请求者时，重启才真的消失：phase 回到 `idle`，这个会话被释放。 |
| `all` | 为**所有人**取消：所有请求者都被释放，待重启请求消失。也就是"所有人都别重启了"。 |

有两种调用会被**拒绝**，而且**不改动任何状态**——"顺手全撤"永远不是兜底行为：

- 不知道调用方是哪个会话（调用时没有会话）→ 拒绝；
- 调用方**并没有**请求这次重启（只是在别人的会话名下）→ 拒绝。

工具会回报结果：`cancelled`（重启请求本身是否真的没了）、`remainingRequesters`（还有几个会话在等）、
`scope`、`phase`。例如只撤自己、别人的请求还在时：

```json
{ "ok": true, "cancelled": false, "scope": "mine", "remainingRequesters": 1, "sessionId": "sess-a", "phase": "deferred" }
```

### 小胶囊：点它看详情，也从这儿自己撤掉

输入框那排的小胶囊只有 22px 高、一行宽，所以它**只放一句短话**（`待重启 · 空闲后自动重启` / `待重启 · 等待 2 个会话`，≤12 字）——不放名字，也不放「双击可以取消」之类的提示（没地方放）。细节都下沉一层：长句只做 tooltip，**阶段**（备份中 / 重启中 / 已回来）显示在**主界面居中的浮层卡片**上，数量和「怎么撤」在点开的小面板里。**单击**它（或聚焦后按 Enter / 空格）会在上方
弹出一个小面板：

- 这次重启还在等几个会话；
- 还有几个**别的**会话也在等同一次重启；
- 一个按钮：「取消我的这次重启」。

按钮按下去弹出的是**确认框**（没有时限，也不倒计时）：「取消你的这次重启？」，并说清现在取消意味着什么
（只有你，还是你退出、别人照样重启）。**只有确认框里的「确认取消」才真的发请求**；按 Esc、点面板外面、
或者按「再想想」都只是关掉，什么都不做。

这个请求只撤**本会话自己**那一份（`POST /__dsh_autorestart/cancel`，body 是
`{ "sessionId": "…", "scope": "mine" }`）：别的会话照样重启。面板里**没有**"全撤"——那种操作只留给
工具显式调用（`continuum_cancel_restart` 带 `scope: "all"`）。

**浮层不会悬停，也不说假话**：重启被新会话打断时，浮层立刻从「正在重启…」换成「**有新会话在跑，重启已暂缓**」，第二行小字「等它结束会自动继续 · 已等 N 个会话」——这时候说「正在重启」就是假话。宿主每 350ms 复查一次空闲门，那句假话最多只存在一个心跳；备份一结束、进入「正在重启」阶段之前也会当场复查一次，被挡就在同一次 tick 退回等待。阶段超过 15 秒无更新视为过期，不再显示，胶囊仍显示等待数。

## 0.8.6：备份了什么、三层信号能说明什么、自动救援的边界（中文）

> 本章是 0.8.6 发版口径的中文原文，英文对照见 [README.md](../README.md)。它只回答普通用户会问的
> 四个问题：**备份什么、信号有几层、自动救援能救什么、出事之后按什么顺序做**。实现细节在上面各节。

### ① 备份什么、不备份什么

| | 进不进备份 | 为什么 |
|---|---|---|
| **备份** | profile 配置（`cordis.patch.yml` / `package.json` / `pnpm-lock.yaml`）+ **你自己开发的、以链接（`link:`）方式安装的插件**（内容另存在 `node_modules-link/<name>/`；**不含 `.git`** —— 历史能从远端重建，而它才是体积主因：单个链接插件就 962 个文件 / 约 74 MB。另外每轮会清掉「既无 manifest 又无配置文件」的空壳目录，单次上限 32 个 / 2 GB，清掉了什么都会写进日志与返回结果。不完整的备份**根本不会挂上正式名字**：先写成 `.staging-<stamp>`，只有 manifest 与配置都落盘后才改名，所以任何中断只留下一个暂存目录，而不是一个「看起来能还原」的目录；**这类 `.staging-*` 残留不会被启动清扫掉**（启动清扫按设计跳过所有 `.` 开头的目录，以免删到正在写入的那一份），它们既不会被列出、也不会被拿来还原，手动删掉是安全的；而老版本留在盘上那些「长得像备份、其实没有 manifest / 配置」的目录，启动时会被扫掉 | 自己写的插件**没有确定的来源和版本**：删掉就找不回来，只能靠备份 |
| **不备份** | **第三方插件**（从 npm 装的） | 第三方**有确定的来源和版本**：`pnpm-lock.yaml` 把每个包的版本和完整性哈希都钉住了，重装装回来的是**备份时那个版本，不是最新版**——所以备份是多余的，重装比备份可靠 |

- 实测（2026-11-01 起，精简备份是默认行为）：一次备份从 308 MB 降到约 100 MB。
- `backupIncludePlugins: false` → 只备份配置（约 66 KB，瞬间完成）：这种配置下**插件出问题无法回退，只能手动重装**，设置页会直说。
- 想回到老的全量备份行为，用 `slimBackup: false`。

### ② 三层检测信号：两层「确定」、一层只是「线索」

每次启动，插件在启动路径上把三层清单跟前一次启动记下的清单（`plugin-watch.json`）比一次：

- **工具名**（`tools`）—— 提供工具的插件（codekg、vault、release-board 这类）；
- **界面模块**（`clientModules`）—— 在界面上画东西的插件；
- **注册的包**（`packages`）—— 注册了 schema 的包。

| 信号 | 强度 | 能说明什么 | 不能说明什么 |
|---|---|---|---|
| **工具名消失** | **确定** | 这些功能这次真的没起来 | 是哪个插件导致的 |
| **注册的包消失** | **确定** | 这个包这次没加载 | 是文件坏了，还是配置把它禁用了 |
| **插件文件跟备份不一样** | **线索** | 这个插件可能被改过（也可能就是你刚改的、或者升级过） | **不等于坏了** —— 文件全对、加载时才报错的插件，这一层看不到 |

还有三条边界，一起写在这里：

- **界面模块里对不上任何已安装插件的那些**，单独计数并单独说（「另外有 N 个界面模块这次没出现」），
  **不硬塞给某个插件** —— 认不出主人，就不猜主人。
- **一层读不到，就记作「没有消息」，绝不记作「消失了」**：升级宿主让某个接口变了形状，
  结果只能是「这次看不到这一层」，不能变成「你的插件没了」。
- **文件比对只比「相对路径集合 + 每个文件大小」**，不哈希整棵树（真实 profile 约 150 MB）。
  所以它找得到「文件被改了 / 删了 / 备份里没有」，**找不到「文件全对但加载失败」的插件**（缺 peer 依赖、
  初始化抛错、宿主拒绝某个版本）。

### ③ 「不一致 ≠ 坏了」—— 面板文案的硬口径

浮窗和设置页只允许出现两种话：

- 「**这些功能这次没起来**」（确定的事，已经发生，不是猜测）；
- 「**这些插件的文件跟备份不一样**」（只是差异清单，不下结论）。

**不许写「插件坏了」**：跟备份不一样，可能只是你刚改过、或者升级过。设置页每行的状态字只有
`正常` / `跟备份不一样` / `备份里没有` / `没装` / `没法判断（没有可比对的备份）`，没有「坏」这个状态。

### ④ 自动救援（看门狗）：它做什么

- **可配置**：`watchdogEnabled`，**默认开**；关掉之后新版本起不来就要自己处理。
- **只在一个窗口里值班**：这次重启是**本插件**发起的。宿主被换掉之后，它等新实例、问**新实例自己的**
  health 路由（不等旧实例、不看旧端口），然后按固定顺序做：**还原最近一份身份为 `known-good` 的备份
  → 清掉过期的 `dsh-auth-*` 握手 cookie → 再把宿主拉起来 → 等 ready 标记**。
- **三种触发方式，按这台机器的能力选一种，并如实告诉你选了哪种**：Windows 计划任务 /
  systemd user timer / 自建后台进程；**三种都没有 → 这台机器没有自动回滚**，设置页直接写「不可用」。
- **有上限地重试**：默认 3 次（硬顶 10 次），两轮之间退避，每轮开始前重新问那三个问题
  （起没起来 / 有没有实例活着 / health 答不答）。
- **每次尝试都落盘**：`<stateDir>/last-watchdog-report.json` —— 哪一档、试了几次、每轮的
  还原 / 清 cookie / 拉起 / ready、以及为什么停。没写进盘的报告等于没发生。
- **顺顺利利的重启也要写结局**：新宿主起来了、看门狗撤防了，报告会被补写成这个结局
  （`result` / `stage` / `outcome: 'disarmed'`、`hostReady`、`disarmed`、`disarmedAt`，以及一段
  `disarm` 明细）。在这之前，报告会一直停在 `armed`——一次早就结束了的重启，却写着自己还在待命，
  而 health 明明答的是 `ready:true`。原有字段一个不动，`previousResult` 还留着"它之前说的是什么"。
- **能力探测留下的计划任务会被清掉**：要证明这台机器能建一次性计划任务，就得真建一个——探测的最后
  一步是删掉它，而崩溃正好会把它留下（真机上就翻到 2 个）。现在开机撤防会清掉所有名字以本插件自己
  探测前缀（`dsh-autorestart-capability-probe-`）开头的任务，**绝不匹配别的任务**；根目录下的任务在
  `schtasks` 输出里名字前面会带一个 `\`（形如 `\任务名`），所以比对前先剥掉**一个**前导反斜杠——剥完
  还带 `\` 的说明它在子文件夹里，一律拒绝、绝不删除；清了哪些、哪些没
  清掉，都写进撤防记录与日志，清不掉也绝不影响宿主起来。

### ⑤ 自动救援的盲区（必须明说，别指望错）

**它能救的**：**插件自己出了问题、导致 DSH 起不来** —— 还原一份快照，再把宿主拉起来。

**它救不了的**（这一条比上一段更重要）：

- **DSH 本体或系统环境出问题** —— （宿主升级坏了、环境依赖缺了）。它不修宿主的 bug，
  同一个原因每次都死，结果只会是 `failed` 加一份点明尝试次数的报告；
- **第三方插件的问题** —— 它只看自己那一份快照，既不诊断是哪个插件引起的，也不会去修第三方插件的 bug；
- **磁盘满、权限问题、系统更新**带来的变化 —— 还原快照解决不了这些；
- **重启窗口之外的一切** —— 凌晨被系统杀掉、手动双击起不来的客户端、早上发现 0 个进程：
  那个时刻**没有人值班**（插件随宿主一起死了，一次性任务根本没注册过），这时只剩
  `scripts/restore-profile.cmd` 可以手动双击；
- **`watchdogEnabled: false`，或这台机器的档位是 `none`** → 没有自动回滚，设置页会这么写。

### ⑥ 出问题之后的四步

1. **看浮窗** —— 重启后自动出现，它会分成两段说：哪些功能这次没起来、哪些插件的文件跟备份不一样；
2. **或者去设置页的「插件」里点「立即检查」** —— 列出每个插件现在的状态
   （`正常` / `跟备份不一样` / `备份里没有` / `没装` / `没法判断`）；
3. **自己开发的插件 → 点「恢复」** —— 只把点名的**那一个**插件换回备份里的版本：现场目录改名成
   `<name>.broken-<ts>` 留证据（`broken` 只是这个证据目录的名字，不是结论），**绝不删除**；
   其他插件和 `package.json` / `cordis.patch.yml` 一个字节都不动；
4. **第三方插件 → 按提示的版本号重装** —— 面板会给出那条命令，装回来的是**备份时记下的那个版本
   （不是最新版）**；备份里没记版本时，面板会如实说「只能按插件名重装」。

四步之外还有一个前提：**没有可用备份时，插件什么都不会替你改** —— 它会直说「只能手动处理」，
而不是装作恢复过。

## 收工关机（Graceful shutdown）

**它干什么。** 左侧栏最底部一个月亮按钮：点一下 → 等**所有**会话都收工 → 屏幕上倒数（一个巨大的数字 + 一只蓝色小鲸鱼，每秒换一句中文）→ **关掉整台电脑**。倒数期间随时可以取消：卡片上有按钮，月亮按钮本身在关机期间也变成了"再点一下 = 取消"。倒数期间要是有会话又开始干活，倒计时会退回"等待"，**绝不关机**。

**按钮在哪。** 月亮按钮在**左侧栏最底部、设置按钮旁边**（`sidebar.footer.action` 槽位）。这个槽位是 **root 作用域**的，所以**没有会话、切换任何页面时它也都在**。侧栏收成窄轨（折叠态）时按钮只显示月亮图标（`title` 和 `aria-label` 仍然说明它是干什么的），不会把窄轨撑变形。

**倒计时不遮界面。** 倒数是角落里的一张**浮动卡片**，不是全屏遮罩：它不压暗页面、不锁滚动、也不吃掉任何点击——卡片外面照常能读正文、能滚动、能点侧栏切会话，卡片自己**只有那个「算了，别关」按钮能点**。切换会话或切换页面也**不会打断或重置**倒数：秒数来自宿主的轮询，不是来自当前打开的那个视图。

**倒数多长由设置分区决定。** `sleepCountdownSeconds` 是一个**下拉框**：0 / 10 / 20 / 30 / 60 秒，默认 20 秒。`0` = **不倒数、立即关机**：所有会话一收工、闸门一开就直接关机（忙着的会话照样挡住它），屏幕上**不会出现倒计时卡片**。配置里还留着下拉框之外的老数值（15、45…）时，会自动吸附到最近的一档（15→20、45→60），不会把插件弄坏。这个下拉框在**设置 → 自动重启与关机 →「关机相关设置」**里。**这段看得见的倒数就是关机前的那段等待** —— 关机没有第二个看不见的预留。

**点一下就够了。** 月亮按钮按下就武装：宿主等所有忙会话收工，在角落里倒数 **20 秒**（浮动卡片，不遮挡界面），然后关掉整台机器。**再点一下**（或点卡片上的「算了，别关」）就取消。除此之外什么都不用用户做：没有确认框、不用点第二次。

### 关机：关掉的是哪台机器？

插件会先看自己跑在哪台机器上，然后关掉**那台机器**；设置页里那行字（`host.label`）写的就是它，不会让人猜：

| DSH 跑在哪 | 关机按下去会关掉什么 | 界面上的原话 |
|---|---|---|
| Windows 桌面客户端 | 这台 Windows 电脑 | 「关掉这台 Windows 电脑」 |
| Windows 上的 `dsh web` | 这台 Windows 电脑 | 「关掉这台 Windows 电脑」 |
| Linux 主机上的 `dsh web` | 那台 Linux 主机 | 「关闭这台 Linux 主机」 |
| **WSL 里的 `dsh web`** | **整台 Windows 主机**（不是那个 WSL 小环境！） | 「WSL 里的 DSH → 关掉整台 Windows」 |
| 容器 | 什么都不会（命令是空的） | 「这台机器没有可靠的关机方式」 |

> ⚠️ **在 WSL 里看到关机倒数，意味着你的整台机器会关机** —— 不是只停那个 Web 服务。
> WSL 是 Windows 里的一个 Linux 小环境，关掉它只会停掉那个发行版；要让**主机**关机，
> 插件走的是挂载盘里的 `shutdown.exe`（`/mnt/c/Windows/System32/shutdown.exe /s /f /t 0`），
> 备选是 `powershell.exe -Command "Stop-Computer -Force"` 与
> `cmd.exe /c shutdown.exe /s /f /t 0`。也就是说：**关的是主机**。

**验到什么程度**：**计划层**每个平台都验过了（`test/sleep-plan-posix.test.mjs`：WSL 的
计划必须走「关整台 Windows」那条分支；纯 Linux 的计划里不许出现任何 Windows 命令；
不支持的平台命令为空、**什么都不执行**）。**Windows 真关电已验**；**POSIX 有意没有真关电**
—— 为一条常识证据把所有人的会话都断掉不划算。

每个平台的完整能力见 [平台能力矩阵](platform-matrix.md)。

### 关机和重启谁先谁后

**一句话版本。** 点月亮按钮的意思是「**等活干完了再关电脑**」，不是「现在就算还有别的在跑也关掉」。所以：

1. **有待重启时，关机先让路。** 队列里还有一次重启没执行时，**不会关机** —— 卡片上写的是「等这次重启完成后再关机」。先重启，会话跟着回来继续干活，等它们都收工了，机器才关。
2. **重启之后活还在继续。** 跟着重启回来的会话是在干活的：只要还有会话在忙，关机就一直等；**所有**会话都空了才关。
3. **关机的意图跨重启保留。** 你只按了**一次**按钮。重启不会把这个请求吃掉：它被写进检查点文件，新进程启动后接着等那些活 —— **你不需要再点一次**。
4. **随时可以反悔。** 等待卡片上有「不关了」按钮（再点一次月亮按钮也行）：一按，这个意图就彻底没了。

**意图存在哪。** 检查点文件（`<DSH_HOME>/storages/dsh-autorestart/state.json`）里的 `sleep: { armed, armedAt, countdownSeconds }`。机器关掉、关机命令没跑起来、或者你点了「不关了」，它都会被清掉。**记录坏掉就直接丢弃** —— 宁可让你再点一次，也不能因为半截文件让机器永远自己关自己。

**排障用。** `GET /sleep` 会报 `armedAt`（什么时候点的关机），旁边还有 `phase`、`blockers`、`countdownSeconds`（正在走的倒数）和 `restartGraceMs`（重启前等待）。

### 故障排查：点了没关机

**下面是真实宿主返回的东西**（文案是中文，字段名不是）：

```
POST /__dsh_autorestart/sleep {"action":"arm"}   # 有 3 个会话在干活
→ phase=waiting  armed=true  remainingMs=20000（满值＝没开始倒数）
  message: 等 3 个任务收工，收工后开始倒数。

# 制造一个待执行的重启之后：
GET /__dsh_autorestart/sleep
→ phase=waiting  armed=true  remainingMs=20000
  message: 等这次重启完成后再关机……
  blockers: [{"sessionId":"restart-pending","kind":"restart-pending",
              "label":"待执行的重启","name":"待执行的重启"}]
```

**`remainingMs` 是满值 = 倒数还没开始**，也就是机器在等什么东西。下面是可能的原因，以及该怎么办：

1. **还有任务在跑。** `blockers[]` 列的就是它们，看 `kind`：`session` 是会话，`subagent` 是某个会话派出去的子智能体。**子智能体也算在干活，这是故意的** —— 否则重启会把它掐断。**怎么办：** 等它干完，或者把那个会话停掉；列表会自己变短。
2. **有待执行的重启。** `kind` 是 `restart-pending`（`label`/`name` 都是 `待执行的重启`）。这是正常排队，不是故障：先重启，会话跟着回来，完事之后倒数自动接着走。**怎么办：** 不用管，等重启完即可（也可以用 `continuum_cancel_restart` 把这次重启取消掉）。
3. **刚收工，倒数还没开始。** 关机**没有看不见的预留**：所有会话一收工，倒数立刻开始。**你会看到：** `blockers[]` 空了、`phase` 还是 `waiting`，说明会话刚刚才闲下来，这一轮 tick 还没把机器切到 `countdown`。**怎么办：** 不用管，下一拍就进倒数了；真要有落盘的活要等，把「关机倒数秒数」调大就行。（重启有它自己的窗口 —— `restartGraceMs`，默认不预留 —— 两个互不影响。）
4. **倒数期间又有会话开始干活。** 倒数退回「等待」，`remainingMs` 变回满值。**你会看到：** 消息里说又有谁开始干活了，`blockers[]` 列着是谁。**怎么办：** 等他们干完。
5. **想看「到底等谁」。** `continuum_status` 的 `blockedBy[]` 和 `GET /sleep` 的 `blockers[]` 是**同一份数据**（前者给 agent 看，后者给脚本看）。每条都有 `kind`（它是什么）、`label`（会话标题）、`name`（完整称呼，比如「写代码的会话的子智能体」）。标题解析不到时 `label` 是 `null`、`name` 是空字符串 —— 这时候等待那句话就只说「等 3 个任务收工」，不带名字列表。
6. **彻底不想关了。** 等待卡片上的取消按钮（或者再点一次月亮按钮，或者 `POST /sleep {"action":"cancel"}`）会把这个意图彻底清掉：`armed` 变回 `false`，`armedAt` 变回 `null`。

**桌面端和 web 端行为完全一致。** 没有票据、没有额外请求头、没有隐藏模式：`POST /__dsh_autorestart/sleep` 只带一个动作，两端走的是同一条路由。脚本（或者 agent）同样可以驱动它：

```bash
# 武装（倒数之后关机）
curl -s -X POST http://127.0.0.1:<端口>/__dsh_autorestart/sleep \
  -H 'content-type: application/json' -d '{"action":"arm"}'
# 取消
curl -s -X POST http://127.0.0.1:<端口>/__dsh_autorestart/sleep \
  -H 'content-type: application/json' -d '{"action":"cancel"}'
```

**关的是真宿主机。** 不是关子系统，是关**整台机器**：

| 宿主 | 执行的命令 |
| --- | --- |
| Windows | `shutdown.exe /s /f /t 0` |
| **WSL**（DSH 跑在发行版里） | `/mnt/c/Windows/System32/shutdown.exe /s /f /t 0` —— 借挂载的 `C:` 盘调 Windows 的程序，所以**关掉的是整台 Windows**；**绝不只关 WSL 子系统** |
| 真 Linux 主机 | `systemctl poweroff`（兜底 `shutdown -h now`） |
| macOS | `osascript -e 'tell application "System Events" to shut down'` |
| 其它平台 | **一条命令都不执行**：按钮不显示，路由报 `phase: "unsupported"` |

WSL 的判定依据：`WSL_DISTRO_NAME`、`WSL_INTEROP`、`/proc/version` 里出现 microsoft，或挂载的 Windows 程序存在。倒数是插件自己做的，所以操作系统被要求**立即**关机（`/t 0`），不会再倒数第二遍。

**三个配置项。**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `showSleepButton` | `true` | 左侧栏最底部（设置按钮旁边）的月亮按钮是否显示 |
| `sleepCountdownSeconds` | `20` | 真正关机前倒数几秒——**下拉框：0 / 10 / 20 / 30 / 60 秒**，默认 20；`0` = 不倒数、立即关机（仍会先等会话收工）。**这段看得见的倒数就是关机前的那段等待** |
| `sleepCommand` | `''` | 自定义关机命令；留空 = 自动识别宿主，填了就用这条命令代替（Windows 走 `cmd.exe /c …`，其它平台走 `/bin/sh -c …`） |

**设置分区（设置 → 自动重启与关机）分成两个带标题的框。** 这个分区是设置页侧栏里的**独立一栏**（排在「Agent预设」下面），点进去直接就是这两个框——不用先去插件详情页，也不用再展开任何一层。**「重启相关设置」在前，「关机相关设置」在后。**

**「重启相关设置」**

| 控件 | 配置键 | 说明 |
| --- | --- | --- |
| 重启前等待（下拉） | `restartGraceMs` | 0 / 5 / 10 / 20 / 30 / 60 秒，默认 0（不额外等） |
| 重启前备份（开关） | `backupOnRestart` | 关掉就完全不做重启前快照 |
| 备份包含已安装插件（开关） | `backupIncludePlugins` | 关掉后只备份 DSH 自身状态，不含 profile 里的插件目录；**「重启前备份」关掉时它置灰** |

**「关机相关设置」**

| 控件 | 配置键 | 说明 |
| --- | --- | --- |
| 关机倒数秒数（下拉） | `sleepCountdownSeconds` | 0 / 10 / 20 / 30 / 60 秒；`0` = 不倒数、立即关机 |

改完立刻写进 profile 配置（走插件自己的 choice 路由，用官方 `configEditor` Service），并且**从宿主回读**，所以分区里永远不会出现宿主没接受的值。**非法值一律 400、一个字节都不写。**

**首次安装会问一次「按钮要不要留着」。** 答完写进 profile 配置的 `showSleepButton` 键（用官方 `configEditor` Service，和备份范围那次问询同一条路），所以设置分区和问询看到的永远是同一个值。

**想空跑、不真关机。** 给宿主进程的环境变量设 `DSH_AUTORESTART_SLEEP_DRYRUN=1`：插件只报告"本来会执行什么命令"，**一条都不执行**。

**给代码看的状态字段。** `GET <healthPath 前缀>/sleep`（默认 `/__dsh_autorestart/sleep`）会回答阶段、倒数和"要关的是哪台机器"。其中几个字段是给**程序**看的、不是给人看的：`host.kind` 是机器类别（`windows` / `wsl` / `linux` / `macos` / `unsupported`；如果平台没认出来、但你配了 `sleepCommand`，则是 `custom`）；`host.suspect` 为 `true` 表示这台机器**只凭挂着 Windows 盘**才被认成 WSL（是佐证，不是铁证）；`lastRun.dryRun` 表示上一次是**试运行**，什么都没真关；`backupOnRestart` / `backupIncludePlugins` 报告重启前备份的当前范围。

**上一次重启的记录。** `GET <healthPath>?state=1` 和 `continuum_status` 工具都会报 `lastRestart`：重启前拍的那份快照（`snapshot.dir`、`snapshot.stamp`、`snapshot.atLocal`——**本地时间**，因为目录名是 UTC——、`snapshot.durationMs`、`snapshot.pruned`），以及**起来那个新实例**的判定（`result` 是 `pending` / `ok` / `failed`，外加 `verifiedAt`、`durationMs` 和四条开机检查 `listener` / `routes` / `plugin` / `recovery`）。新实例始终没起来时，记录停在 `pending`——这同样看得见。记录落在 `<stateDir>/last-restart-verdict.json`。

**这个宿主是谁拉起来的。** 同一个返回里的 `supervisor` 块说 `mode`（`app` / `installed` / `external` / `unknown` / `off`）、`restartCapable`，以及——因为**第二个守护会抢同一个端口**——`selfReplay`（`allowed` / `refused` / `unknown` / `n/a`）；别人在管时还有 `external` 的证据（`kind`、`evidence`、`commandLine`）。Linux 上会读宿主的**父进程链**（`/proc/<pid>/cmdline`），所以用户自己的 `supervise-*.sh` 脚本能被认出来。**认不出人时是 `unknown`，绝不会默默当成"裸跑"**：这时插件拒绝自己重放自己的命令。**桌面版不会是 `unknown`**：它自己会把自己拉起来，所以报 `mode: "app"`、`restartCapable: true`、`selfReplay: "n/a"`。

**关机命令起不来时的退路。** 宿主会等命令的**真实结果**（进程有没有真的起来）。命令起不来（找不到程序、权限不够）时，关机**不会假装成功**：状态回到 `idle`，并给出原因（"关机命令没跑起来（…），电脑还开着，可以再点一次月亮按钮。"），电脑保持开机。界面上那个「正在关机」的卡片也**不会把界面锁死**：最多停留 8 秒就会给出一个"关掉这个提示"的按钮。

## 需要 goal 吗？

不需要。

| 情况 | 重启后行为 |
| --- | --- |
| 有 active goal | `goals.resume()` 重新武装 → goal round driver 自动开下一轮（可跨多轮持续，直到 goal 完成/预算用尽） |
| 没有 goal | 注入一条 `<continuum_resume>` 续接消息 → 新的一轮把活干完（这一轮结束后不会自动再起一轮） |

也就是说：**goal 是"多轮自动驾驶"的增强项，不是使用前提**。长任务建议用 `create_goal` 获得更强的连续性；
一次性收尾任务不用 goal 也完全能接续。

## Goal 解除（disarm）：重启不再被 goal 卡死

带 durable goal 的会话会自己把自己占住：goal round driver 在 agent 空闲后的几毫秒内就开下一轮，
于是插件的空闲闸门（要 agent idle **且** 静默 `settleMs`）永远打不开，重启就一直等着 —— 而重启
往往正是这个 goal 继续跑下去所需要的。

**为什么不是 pause**：被 `ctx.goals.pause()` 暂停的 goal，模型自己已经没法再 resume（Host 只允许人恢复），
等于把会话停成一个只有人工才能撤销的状态。现在改成**解除（disarm）**：`ctx.goals.disarm(agent)`
只撤掉"进程内的续跑授权"，durable goal 依然是 `active`，所以重启后本插件早就实测通过的恢复路径
（`ctx.goals.resume`）直接适用。

- **解除条件**（全部满足才会解除）：goal 存在、`phase='active'`、`activation='armed'`、
  `roundsStarted < maxGoalRounds`（预算用完的 goal 解除之后再也续不了，只上报、不解除）。
- **解除动作**：`ctx.goals.disarm(agent)`。**当前正在跑的那一轮不会被取消**，它照常跑完（输出照旧留在
  会话日志里，什么都没丢），只是不会再起下一轮；会话因此空闲下来，静默窗口过去，重启就能进行。
- **解除记录**：成功后写检查点记录 `{ goalId, disarmedAt, resumedAt }`（`state.disarmedGoals`）。
- **旧记录兼容**：上一版 pause 实现写下的 `{ goalId, parkedAt, resumedAt }`（`state.parkedGoals`）
  仍然会被容错读取和修复，所以那一版暂停掉的 goal 重启后照样能恢复。

**能不能解除只看 goal 的实时状态**：判定依据只有它当下的 `phase` / `activation` / 轮次预算 ——
`active` + `armed` 且 `roundsStarted < maxGoalRounds` 才解除，其余情况（用户暂停、blocked、complete、
预算用尽、已经没有续跑授权）只上报原因。检查点里的记录**只用于上报**（`continuum_status` 里让人看见
这个插件解除过什么、恢复了没有），它**永远不会否决一次解除**：一个被恢复过（于是又是 `armed`）的 goal
必须能再解除一次，否则重启会一直等一个再也解不掉的 goal —— 那正是这个功能要消灭的死锁。每次新的解除
都会**覆盖**该会话的记录（`kind=disarmed`、新的解除时间、`resumedAt=null`），所以旧版 pause 实现留下的
记录也拦不住后来的解除；每次本插件把 goal 重新武装（boot 恢复、旧版 paused goal 的恢复、手动重试），
都会给记录打上恢复时间戳，让状态里显示它已经恢复。插件被重新应用（禁用再启用、热重载）时，
**工具和路由一起释放**：工具的 disposer 和路由一样交给 `ctx.effect` 由宿主持有，旧实例不会留下残留的
工具，新实例也不会撞上"重复注册"，于是 host 不会出现"工具属于旧实例、路由属于新实例"的错位。
- **恢复（boot）**：
  1. goal 是 `active` + `disarmed` 且有本插件的解除记录 → `ctx.goals.resume()` 重新上链（`resume-disarmed-goal`）；
  2. goal 是 `paused` 但有**旧版 parked 记录**且 goal id 一致 → 这是我们自己暂停的，可以 resume（`resume-paused-goal`）；
  3. goal 是 `active` + `disarmed` 且没有记录 → 走既有路径重新上链（`rearm-goal`）；
  4. resume 失败（revision 过期 / 预算用完）→ 回落到续接消息，**记录保留**，下次 boot 或手动重试还能再试一次。
     **用户自己暂停的 goal（没有记录）永远保持暂停。**

解除默认开启（**不需要任何配置**），也可以按次关闭：

- `continuum_restart` 的参数 `parkGoals`（默认 `true`，语义现在是"重启前解除 goal 驱动的阻塞"）。
  传 `false` 时什么都不解除，返回的提示会说明：goal 驱动的会话可能让重启一直等着。
- 工具 `continuum_park_goal`（参数 `sessionId?`，省略时是调用方自己的会话）：手动解除某个会话的
  goal，返回 `{ ok, disarmed, goalId, reason }`；不能解除时给出原因（例如预算用完 → `goal-exhausted`）。
- 新工具 `continuum_recover_now`（参数 `sessionId?`）：**立刻重跑恢复**，不用等下一次重启；
  返回每个会话的动作与原因。卡住的会话（agent 还没起来、resume 失败）用它重试。
- 路由：`POST <healthPath 前缀>/park`（保留给旧客户端，语义已经是解除）和新的
  `POST <healthPath 前缀>/recover`（默认 `/__dsh_autorestart/recover`，body `{ sessionId?: string }`）。
  两条都和健康路由同一套鉴权规则（loopback，或被连接服务放行的请求）。

`continuum_status` 会说明每个阻塞会话为什么阻塞：`goal-active`（被 armed 的 goal 占住，可解除）、
`goal-exhausted`（轮次预算用完，没法再继续）、`goal-paused` / `goal-blocked` / `goal-complete` /
`goal-disarmed`（已经没有续跑授权可以拿掉）。同时会列出解除过的 goal
（session id / goal id / disarmedAt / resumedAt，以及是否恢复成功），以及**每个会话上次恢复的动作与原因**：
`recovery: [{ sessionId, action, detail, pending, attempts, error }]`。`action` 取值：
`resume-disarmed-goal` / `resume-paused-goal` / `rearm-goal` / `prompt-continuation` /
`agent-not-live` / `session-controller-unavailable` / `goal-lookup-failed` / `prompt-failed` / `nothing`。
`?state=1` 路由同样返回 `recovery`、`parkUrl`、`recoverUrl`。

### 解除的残差限制（诚实说明）

- **轮次预算用完的 goal 没法继续**：`roundsStarted >= maxGoalRounds` 时解除它等于把后续轮次丢掉，
  所以只上报 `goal-exhausted`，不解除 —— 需要人工给这个会话一个新的 goal。
- **agent 还没活着的会话需要重试**：boot 恢复可能比 profile 加载 agent 更早，那个会话会记
  `agent-not-live` 并保持 pending；下一次 boot 会自动再试，也可以 `continuum_recover_now`
  （或 `POST /recover`）立刻重试。
- **解除后一直没被恢复的 goal 会留在检查点里**：只有恢复成功（或很久之后被清理）才会写上 `resumedAt`，
  这样下一个 boot 还能把它补回来；`continuum_status` 里一直能看到它。
- **goal 查找失败不会静默跳过**：`goals.get` 抛错时记 `goal-lookup-failed`，仍然注入续接消息让会话继续推进。

## 会话接力（上下文超限的救援）

- **它救的是哪种死局**：一个会话累积的对话超过了模型的 context window 之后，它**任何请求都跑不动**了 —— 供应商直接回
  `invalid_request_error`（说上下文超限）。而且**宿主自己的 compaction 也救不了**：压缩请求本身需要同一份超大的上下文，
  于是这个会话既不能继续、也不能被压缩，就卡在那里。
- **工具**：`continuum_handoff`，参数 `sessionId`（要接力的会话；省略 = 调用方自己的会话）和 `maxChars`
  （带走的对话尾部的字符预算，默认 `20000`）。
- **路由**：`POST <healthPath 前缀>/handoff`（默认 `/__dsh_autorestart/handoff`），body
  `{ "sessionId": "<会话 id>", "maxChars": 20000 }`；鉴权规则和健康路由**完全一致**（loopback，或被连接服务放行的请求）。
  路由没有"调用方会话"这个默认值，所以不传 `sessionId` 会直接被拒（`no-session`）。
- **带过去的东西**（顺序固定）：goal 的 **objective**（目标）、检查点里记录的**接手原因**（`reasons`，最新的在前）、
  以及对话的**有界尾部** —— 尾部按 plain text 渲染：文本消息渲染成 `角色: 内容`，**tool call / tool result 压成一行、
  只留工具名**（工具的载荷不带）。再早的内容**全部丢弃**。
- **旧会话的命运**：**保留**，并被标记为"已接力"（检查点里记 `handoff`：目标会话 id、接力时间、带走的字符数）；
  它的 goal 被**解除（disarm）**，于是它不再发出注定失败的请求；插件**永远不会再自动恢复它**
  （带 `handoff` 记录的会话会被 `recoverableSessions` 跳过）。旧会话的历史仍然完整可读，当作存档留着。
- **新会话**：在**同一个工作目录**下新建一个 live session，把上面那段接力文本作为一条
  `<continuum_handoff>` 续接消息投进去，agent 那边就能接着干活。

### 接力的限制（诚实说明）

- **源会话必须在当前进程里活着**：读不到它的消息就什么也做不了（`source-session-not-live`）——
  所以先在侧边栏把那个会话**打开一次**，让它进入本进程的 live 会话表。
- **源会话的 header 里必须有绝对工作目录**，否则没法在同样的目录下建新会话（`source-cwd-unknown`）。
- **带过去的是尾部摘要，不是完整历史**：更早的对话已经被丢弃，模型在新会话里看不到。
  目标（objective）和检查点里记录的原因还在，所以活儿一般接得上，但细节可能要重新说一遍。
- **接力是"一次性的"**：每个会话只会被接力一次，接力之后它就退出自动恢复路径了。

## 上下文超限保险

- **重启后重新武装 goal 之前，插件先判断这个会话是不是已经超过模型的 context window**。
  证据只取自**活着的会话**：最后一条 assistant 消息的 `usage.inputTokens` 对上该会话 request 的 `contextWindow`
  （**用超了**才算超限），以及最近一轮消息 / 事件里"上下文超限"类的报错。
  数字拿不到时**一律不算超限** —— 不知道窗口大小永远不会挡住正常的恢复路径。
- **一旦判定超限**，插件**拒绝**重新武装那个 goal，也**不排**续接消息（这两件事都只会失败）；
  改为把 `lastRecoveryAction` 记成 `context-overflow`（数字知道的话一并记下 `inputTokens` / `contextWindow`），
  并且**期待一次接力而不是一次重试** —— 该做的事是 `continuum_handoff`，不是再试一遍。
- **状态里看得见**：`continuum_status` 和 `?state=1` 的 `handoffs[]` **按会话**列出两件事：
  这个会话**是不是被接力过**（目标会话 id + 接力时间），以及**是不是已经超限**（`overContextLimit`）。
  这两类会话都不在自动恢复路径里，所以必须单独报出来，否则它们会从状态里凭空消失。

## 健康检查

```powershell
curl http://127.0.0.1:<当前 GUI 端口>/__dsh_autorestart/health
# {"ok":true,"plugin":"dsh-autorestart","bootId":"…","pid":17884,"phase":"running",
#  "pageHeartbeat":true,"systemPrompt":true,"configSchema":true,"indexTaps":1,…}

# 自检：把页面心跳注入逻辑作用到一段探针 HTML 上（不需要鉴权页面）
curl "http://127.0.0.1:<端口>/__dsh_autorestart/health?probeIndex=1"

# 解除某个会话的 goal，让待重启不再被 goal 卡住（鉴权规则同健康路由；旧路径，语义已是解除）
curl -X POST http://127.0.0.1:<端口>/__dsh_autorestart/park \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"<会话 id>\",\"restart\":true}"

# 立刻重跑恢复（不用等下一次重启）；body 的 sessionId 可省略 = 所有待恢复会话
curl -X POST http://127.0.0.1:<端口>/__dsh_autorestart/recover \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"<会话 id>\"}"
```

`bootId` / `pid` 每次**新进程**变化（重启后立刻能看出换了进程）。`autoReloadPage` 打开时，
`dsh web` 页面会轮询该路由；发现 `bootId` 变了就自动 `location.reload()`，不用手动刷新。

## 验证与已知限制

- **真实重启端到端已实测通过**：agent 自己调 `continuum_restart` → 等空闲 → WMI 脱离进程树 `taskkill` + 重启应用 →
  新 host 进程（pid `6560 → 17884`、bootId 更新、端口 `60909 → 65403`）自动 `resolveAgent` + 注入续接消息，
  **无人工输入**地开始下一轮继续原任务。证据见 `verification/e2e-restart-result.md`。
- **system prompt 钩子已实测**：启用后 agent 的 system prompt 中出现 `## Restart policy (dsh-autorestart)`；禁用插件后消失。
- **手动重启硬拦截已实测**：`pwsh` 执行 `echo taskkill /IM "DeepSeek Harness.exe" /T /F`（故意用 echo，即使守卫失效也不会
  真的杀进程）在 dispatch 前被拒绝；`Stop-Process -Name "DeepSeek*"`、`wmic … call terminate`、`npx kill-port <当前端口>`
  三种形态同样被拒；随后 `echo autorestart-guard-final-ok` 正常执行；`health.manualRestartBlocks` 计数递增。
  `blockManualRestart: false` 可关闭。
- **页面心跳已实测**：`health.pageHeartbeat=true`，`?probeIndex=1` 返回注入后的 HTML（含 `data-dsh-autorestart-heartbeat`）。
- **Config schema 已实测**：`Config.listConfigs` 对该行返回 `status: "schema"`（17 个键 + 默认值齐全）；`health.configSchema=true`。
  （注：profile 里的 linked bundle 用真实路径解析，找不到 `@deepseek-ai/schemastery`；插件会回退到
  `<dsh 安装目录>/app.asar/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs` 加载。健康路由的
  `schemastery` 字段只报告粗粒度来源 `bare` / `asar-fallback` / `unresolved`；schema 缺失时降级为"配置照常可用、
  只是没有可视化 schema"，并在日志里给出警告，**不会**因此让插件激活失败。）
- 测试：**250 个插件用例全绿**（`plugins/dsh-autorestart/test/*.test.mjs`，其中 goal 解除 / 自述式恢复 /
  `continuum_recover_now` / `/recover` 路由 / 收工关机（宿主侧状态机 + 前端纯函数）是新增的用例）。运行：
  `<bundled node> --test "plugins/dsh-autorestart/test/*.test.mjs"`
  （Node 24 把位置参数当 glob，务必加引号）。
  注意：仓库外的 `verification/adversarial.test.mjs` 里仍是"只注册一条/两条路由"的旧断言（插件现在注册
  健康 + park + recover + handoff + choice + sleep 六条），该文件不在本插件改动范围内。
- 独立验证员复验：`verification/verify-report.md`。
- WMI 脱离进程树已实测（`Invoke-CimMethod Win32_Process Create` 的子进程 parent 是 `WmiPrvSE.exe`）。
- 健康路由在"开机时激活"的情况下会短暂晚于 webserver 就绪，插件会重试注册（≤30 次 × 2s）。
- **限制**：`restartMode: app` 只对 DSH Desktop 生效；`dsh web`/CLI 部署请设 `restartMode: command` 并给出你们自己的重启命令。
- 手动重启守卫是**模式匹配**（命令文本里 kill/restart 动词 + DSH 字样或本进程 pid）；如果你自己写了绕过它的脚本（例如
  编码混淆后再执行），守卫生效前提是文本可被识别。它防的是"agent 顺手 taskkill"，不是安全边界。
- 重启会关闭并重新打开桌面窗口（这是整应用重启，不是热重载）。
- 杀进程后没有二次确认：若助手进程创建成功但 `taskkill`/`start` 本身失败，会停在 `phase: restarting` 直到下次启动。
- 若进程在 **turn 结束时恰好** 被杀，checkpoint 可能仍记着 running，最多导致一次多余的续接提示。
- 恢复出的新一轮会消费 API token（和人工催"继续"一样）。

## 目录

```
index.js             插件入口：apply / 事件跟踪 / 工具 / 健康路由 / 启动恢复
lib/checkpoint.js    原子 JSON 检查点，容错读取，boot/restart/session/解除记录（含旧 parked 记录）与"已看过的新功能公告"变更函数
lib/lifecycle.js     纯决策：bootPlan / restartDecision / selectGoalDisarms / continuationPrompt / describeState
lib/restart.js       Windows 脱离重启（WMI 主、schtasks 兜底、dryRun、自定义命令）
lib/sleep.js         收工关机：识别真宿主机（含 WSL）、关机命令、等待→倒数→关机的状态机
lib/semver.js        版本号比较（公告去重用：只看"记录版本是否低于当前功能版本"）
locale/{en,zh}.json  界面文案的镜像（与 client.js 里注册给 DSH 的两份字典同键同词；键集由一条用例钉住）
icon.svg             插件图标
LICENSE              MIT 许可（发布到插件市场需要）
test/                node:test 用例（状态机 / 检查点 / 重启命令 / goal 解除 / 集成恢复 / recover_now）
```


## Two-gate restart safety

A restart is never scheduled while another DSH conversation is still working.

1. Conversation gate: busyAgents() inspects every live agent (subagents and
   teammates included). An agent blocks the restart when its status is 'running'
   (ALWAYS, under every setting) or when it still has queued inbox work
   (inbox.nextTurn / inbox.nextStep, or inbox.hasPending) — the queued work only
   blocks until queuedGraceMs (default 60000 ms) is over; after that it is
   treated as stuck, it stops blocking and the session that holds it is named in
   the log. The verdict is { allow:false, reason:'conversation-active',
   blockedBy:[...] }.
2. Settle gate: even with no busy conversation, the host must have been quiet for
   settleMs (default 2000 ms) since the last REAL activity — a turn that started
   or ended (agent/status), a message that was queued (agent/inbox/inserted), a
   session event that says work happened (a message, a tool, a turn), or the last
   moment a conversation was seen working. A ROUTINE session event (a title, a
   projection, a context request) is not activity: the host emits those every
   two to three seconds, so counting them kept the window from ever filling and
   the restart never fired. Otherwise the verdict is
   { allow:false, reason:'settling' }. This closes the gap between the decision
   and the detached helper's ping delay, where a new turn could otherwise start
   and be killed.

The gate is evaluated three times: in the poll tick, again right after the
pre-restart session flush (before anything is scheduled), and once more inside the
detached helper (restart-<generation>.cmd in the state-file directory). The helper
GETs http://127.0.0.1:<webPort><healthPath>?gate=1 and exits without killing when
the gate denies the restart or the request fails.

Because a denied helper leaves this process alive, a watchdog armed for
relaunchDelaySeconds + 20 seconds treats that as a gate abort: it logs, increments
restart.gateAborts, rolls the checkpoint back to phase 'deferred' (decrementing
attempt so a later retry is allowed) and polls again. After more than 20 gate
aborts the plugin logs an error and schedules one ungated restart instead of
retrying forever. Even that ungated fallback re-checks the same gate before
anything is scheduled, so a busy conversation is never killed.

A restart waits until every conversation is idle, with NO deadline: nothing ends
the request except the gate opening or the user withdrawing it. The only setting
that can act on busy conversations is forceRestartWhenBusy — it restarts over a
running conversation, i.e. it interrupts it (off by default), because a restart
must never kill a conversation that is still working unless the user asked for
exactly that.

Inspect the live verdict with continuum_status (gateAllow, quietForMs, blockedBy)
or by requesting the health path with ?gate=1.
## 多会话合并重启（coalescing）

- 多个会话同时调用 `continuum_restart` 时，请求会**合并成一次进程重启**：`generation` 仍然每次 +1，但 `restart` 会被替换为包含所有请求者的记录。
- `restart.requesters` 保存每个请求会话 `{ sessionId, requestedAt, reason, resume }`（按新到旧排序，最多 16 个）；`restart.bySessionId` 仅保留最后一个请求者以兼容旧逻辑。
- 每个请求者都会被标记 `pendingResume`，重启后**全部**被唤醒；`continuum_cancel_restart`（以及放弃重试/回滚路径）会一次性释放**所有**请求者，而不是只释放最后一个。
- 启动恢复按 `maxSessions` 分批执行，每批之间等待 `recoveryBatchDelayMs`（默认 1200ms），最多 5 批，因此一轮启动就能唤醒多于 `maxSessions` 的会话；只有超过批次上限时才会留到下一次启动。
- `resolveAgent` 在同一轮启动内最多重试 2 次（`resumeRetryDelayMs`，默认 1000ms）；最终失败会写入 `lastResumeError` 并保持 `pendingResume`，该字段也会出现在 `continuum_status` 的每个会话条目中。达到 `maxResumeAttempts` 后 `pendingResume` 被清除并记录最后的错误，避免坏会话无限重试。

## UI：等待重启小胶囊 + 侧边栏圆点

- 胶囊渲染在**输入框工具行左侧**（`conversation.input.left` 槽位），是一个高度约 22px 的小胶囊，**不额外占一行**（不再是输入框上方的一整行）。
- 只有当健康路由 `/__dsh_autorestart/health?state=1` 返回 `pendingRestart: true` **且**本会话 id 出现在 `waiters` 列表里时才会出现；别的会话等待重启时你看不到它。
- 文案有多种状态：还有别的**会话**占着时显示「待重启 · 等待 N 个会话」；都空闲时显示「待重启 · 空闲后自动重启」；被某个**自动续跑的 goal** 占着时显示「待重启 · 被某个自动续跑的 goal 占着」（见下面的升级 3）。
- 悬停提示（原生 `title`）：「等待其他会话结束（计数含"排队但还没开始"的会话）后自动重启；重启后会自动继续本会话进度」。
- **每个占用者都说清自己是什么**：普通会话用它自己的标题；**子智能体**用"创建它的那个会话"的标题来称呼（显示成「子智能体（那个会话）」）。**原始的 `session-xxxx` 永远不会推给界面** —— 取不到标题时用一个通用说法。
- 颜色走**品牌色（蓝紫）** `var(--dsw-alias-brand-primary, #5b8def)`，**不再用告警黄（warning）色**：胶囊里的小圆点和侧边栏圆点都是品牌色，胶囊边框保持中性（`--dsw-alias-border-l1`），文字保持中性。
- 左侧边栏会话行的**行首 16px 状态格**里也会出现一个同款 8px 圆点（`sidebar.session.row.leading` 槽位，id `autorestart-restart-dot`，order 20）：纯图标，完整说明放在悬停 `title` 里，aria-label 为「待重启」/「Pending restart」。
- 那个 16px 状态格会被**优先级更高的行状态**（ask / 未读 / 运行中）替换，所以圆点只在该行**空闲**时出现。
- 胶囊与侧边栏圆点**共用同一个 2 秒轮询**（客户端只有一条 2s 定时器 + 一次 fetch，不是各轮各的）；重启一旦真正触发、状态里的 `pendingRestart` 变成 false，两个界面同时自动消失。
- 胶囊是**行内紧凑**的：`flex: none` + 固定高度，不撑高工具行；文字过长时按省略号截断（`white-space: nowrap` + `text-overflow: ellipsis`），不换行也不溢出。
- 工具行左侧的胶囊与费用条等其它 dock 条目互不影响：不依赖 `position:absolute/fixed`、不使用负 margin，也不新增兄弟元素。
- 客户端这一半（`client.js`）需要**刷新页面或 DSH 重启后**才会加载进前端，Host 端改动则随插件热更新生效。

### 升级 1：重启在即时的呼吸脉冲

- 当 `?state=1` 返回 `pendingRestart: true` **且** `allowRestart: true`（Host 的空闲闸门已开，重启随时都会发生）时，胶囊里的小圆点和侧边栏圆点都会**轻微呼吸**：`scale(1) -> scale(1.5) -> scale(1)`，同时透明度略微下沉。
- 动画只动 `transform` 和 `opacity`，**不改变布局**（不动 `width` / `height`），所以工具行不会被撑开。
- `@keyframes dsh-autorestart-pulse` 只往 `<head>` 里注入**一条**规则（按 id `dsh-autorestart-pulse` 去重），两个界面共用；最后一个订阅者离开时这条规则会被移除。
- 通过 `animation` 样式属性应用；系统开启「减少动态效果」（`prefers-reduced-motion: reduce`）时**不播放**任何动画。

### 升级 2：点胶囊看详情

- 胶囊现在是**可点击**的：`cursor: pointer`、`role="button"`、`tabIndex=0`、`aria-expanded`，鼠标点击以及 **Enter / Space** 都能展开或收起。
- 展开后是一个锚定在胶囊上方的小详情面板（胶囊外层 `position: relative`，面板 `position: absolute`、`bottom: 100%`、左对齐、`min-width: 260px`、圆角、小阴影、字号 12；背景 / 边框 / 文字颜色走宿主主题 token）。
- 面板内容：一行标题「待重启」；一行当前状态（**等待其他会话空闲** / **等待空闲窗口**）；**每个占用会话一行**（Host 给了标题就显示标题，没给就显示「有一个会话正在运行」）；一行**已等待时长**（客户端从第一次看到 pending 状态开始计时）；一行「重启后本会话会自动继续进度」。
- 点击面板外部或按 **Esc** 关闭；所有监听器和计时器在卸载时都会清理。
- 没有 pending 重启时整个组件**什么都不渲染**，绝不会影响输入框。

### 升级 3：goal 卡住时的胶囊状态 + 一键停泊并重启

- 当 `?state=1` 的 `blockedBy[]` 里出现 **goal 驱动的占用**时，胶囊会换一种状态文案：reason 为 `goal-active` 表示**某个会话的 goal 在自动续跑**（它自己就把重启一直占着），reason 为 `goal-exhausted` 表示**那个 goal 的轮次额度已经用完、没法再续跑**。
- `goal-active` 的条目会在胶囊里给出一个「**停泊并重启**」按钮：点击后客户端 `POST /__dsh_autorestart/park`（鉴权规则同健康路由），body 为 `{ "sessionId": "<占用会话>", "restart": true }`——Host 会**停泊那个 goal**（于是它不再自动续跑）并把**当前会话登记为待重启的请求方**，重启随即就能推进，重启后该 goal 会被自动恢复。
- `goal-exhausted` 的条目**不给按钮**：它的 goal 无法被继续，停泊也没有意义，胶囊只把原因说清楚。
- 请求在飞的时候按钮是**禁用**的（文案变成「停泊中…」）；失败时（比如 Host 回 **403** 或 **409**）在详情面板里显示一行**内联错误**，内容是 Host 自己给的那条消息。
- Host 停泊过的 goal 会通过 `?state=1` 的 `parkedGoals` 回报：胶囊上多一行「已停泊 N 个 goal，重启后自动继续」，详情面板里逐条列出**会话 id 与 goal id**。
- 胶囊依旧保持**单根、自居中、行内紧凑**：按钮是胶囊内部的子元素，复用胶囊自己的按钮样式，没有 `position:absolute/fixed`、没有负 margin，也没有在工具行里新增兄弟元素。

### `?state=1` 响应字段

```json
{
  "ok": true,
  "pendingRestart": true,
  "phase": "restarting",
  "generation": 3,
  "waiters": ["sess-a", "sess-b"],
  "blockedBy": [{ "sessionId": "sess-c", "reason": "running", "title": "重构解析器" }],
  "allowRestart": false,
  "quietForMs": 1200,
  "settleMs": 2000,
  "updatedAt": 1730000000000,
  "parkUrl": "/__dsh_autorestart/park",
  "parkedGoals": [{ "sessionId": "sess-c", "goalId": "goal-3", "parkedAt": 1730000000000, "resumedAt": null }]
}
```

- `blockedBy[]` 的每一项在原有字段（`sessionId`、`reason`）之外，还带两个字段：
  - `kind`：`"session"` 或 `"subagent"` —— 这个占用者是普通会话还是**子智能体**（子智能体用 `agent.origin === 'subagent'` 判定；分叉会话的 `origin` 为空，仍然是普通会话）。
  - `label`：**它该被怎么称呼** —— 普通会话用自己的标题；子智能体用「创建它的那个会话」的标题（所以界面显示成「子智能体（那个会话）」）。取不到就是 `null`，界面改用通用说法。
  - 另外还有 `name`（完整的称呼，如「写代码的会话的子智能体」）、`parentTitle` / `parentSessionId`（子智能体的父会话）、`title`（`label` 的旧名字，保留给老客户端）。
- 这些字段是**尽力而为**：会话控制器缺失、抛错或没有标题都**不会**让这条路由失败，只是 `label` 为 `null`；**原始的 `session-xxxx` 永远不会被当成名字推给界面**。
- 标题查询结果会缓存约 **5 秒**（客户端每 2 秒轮询一次，不会把会话列表打成风暴）。
- 标题查询结果会缓存约 **5 秒**（客户端每 2 秒轮询一次，不会把会话列表打成风暴）。
- `blockedBy[]` 里的 `reason` 可能是 **goal 相关**的：`goal-active`（持有一个会自动续跑的已武装 goal）、`goal-exhausted`（goal 的轮次额度用完，无法继续）等；此时原本的占用原因保留在 `busyReason` 里。
- `parkUrl` 是停泊路由的绝对路径（由配置的 `healthPath` 前缀推导），客户端优先用它，而不是自己猜路径。
- `parkedGoals` 与 `continuum_status` 上报的列表一致：本插件停泊过的每个 goal 的 `sessionId`、`goalId`、`parkedAt`、`resumedAt`（以及派生的 `resumed`）。

## 平台与部署

> 本节讲**怎么配**；**哪些环境被支持、哪些不支持**看上面「支持范围」那一节，
> 每种能力 × 每个环境的完整矩阵（带 `文件:行号`）见 [platform-matrix.md](platform-matrix.md)。

| 部署形态 | `restartMode` | 怎么重启 |
| --- | --- | --- |
| DeepSeek Harness 桌面应用 | `app`（默认） | 用宿主内置的**应用重启**能力：脱离进程树地杀掉并拉起桌面端 |
| 托管的 `dsh web` 部署 | `command` | 桌面端那套「重启应用」在 web 部署里不存在，必须自己给一条重启命令 |

托管 `dsh web` 的配置（注意是**整段替换 config**，不是合并）：

```yaml
- id: dsh-autorestart
  config:
    restartMode: command
    restartCommand: systemctl --user restart dsh-web
```

`restartCommand` 里可以用占位符 `{pid}`（当前宿主）、`{ppid}`（它的父进程）、`{app}`（桌面端路径）。

**不配这个，重启就会失败，而且失败是有提示的**：托管宿主不是桌面端，插件没有「重启应用」的能力，
日志里会出现
`no restart method available (not the desktop app and restartCommand is empty); leaving the checkpoint in place`，
待重启会被回退（退避后重试一次，再失败就取消，不会永远重试），**不会有任何进程被拉起** —— 只是把检查点
留在盘上，等你手动把宿主再起一次时它会接着跑。`continuum_status` 在取消之前会一直报待重启状态。

同一个 profile 行也是首次安装那次提问的落点：**托管 profile 如果自己没有 `dsh-autorestart` 行**，
`configEditor` 就没有行可写，答案会退到 `<DSH_HOME>/storages/dsh-autorestart/install-choice.json`
而不是 profile 配置；声明这一行才能让 profile（以及设置分区）保持唯一真相。

- **浏览器侧的「待重启」小胶囊**依赖 `GET <healthPath>?state=1` 这条状态路由。这条路由现在接受
  **loopback 调用者**，*或* **宿主 connection 服务判定为「已认证浏览器」的请求**
  （`connection.requestRejection` 不给拒绝码就放行）。所以：**托管部署必须允许已认证浏览器访问这条状态路由**，
  否则远程浏览器拿不到 pending 标记，小胶囊永远不出现。
  两者都不成立时仍然返回 `403 {"ok":false,"error":"loopback-only"}`。
- 宿主没有 connection 服务时（例如更老的宿主版本），行为不变：仍然只接受 loopback。
- **两段等待现在都是 2 秒，且互相独立**：
  - `settleMs`（默认 `2000` ms）：最后一次会话活动之后，宿主必须静默这么久，重启才允许开始；
  - `relaunchDelaySeconds`（默认 `2` 秒）：脱离的 helper 在杀掉应用**之前**等这么久（`ping -n 3`，约 2 秒）。

  两个值都可以在 profile 的 config 里单独覆盖；把 `settleMs` 调大会更保守（更不容易打断刚起步的会话）。

## 发布到插件市场

```powershell
# 1. 打包
npm pack                 # -> dsh-autorestart-0.2.1.tgz
# 2. 发布到 registry
npm publish
# 3. 从市场安装
#    dsh CLI：dsh plugin install dsh-autorestart
#    或直接对 Agent 说：把 dsh-autorestart 装到当前 profile
```

`package.json` 里已经带齐市场需要的元数据：MIT license、`keywords`、`repository`，以及
`dsh.compatibility.dshReleases`（声明在 DSH `0.2.1-rc.2` 上实测兼容）。
改了代码记得重新 `npm pack`——市场里装的是 tarball，不是工作区目录。

## AI 生成声明

本插件由 AI 生成，**未经人工代码审核**。它会重启你的 DSH 进程并读写本地状态文件。请先在测试 profile 里验证行为符合预期，再用于日常/生产 profile；使用风险由使用者自行评估。

This plugin was generated by an AI and has **not been reviewed by a human**. It restarts your DSH process and writes local state files. Verify it in a test profile before using it in your working profile.
