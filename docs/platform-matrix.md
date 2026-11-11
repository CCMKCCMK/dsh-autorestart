# 跨环境能力矩阵

这张表只回答一个问题：**「我这台机器到底能做什么，哪一格会缺？」**

插件装在哪台机器上，就只有那台机器的答案 —— 所以每一行能力都按环境分开写，
每一格要么能在代码里找到对应实现（带文件名），要么明确写「不支持 / 查不到」。

**本表只写 0.9.6 真正有的能力**：排队重启、重启前快照、清登录 cookie、会话续接、关机倒计时。
0.9.0 **删掉**了自动救场与手工救场那一整条线，所以表里没有那一类格子 —— 「插件不做什么」
写在第六节。

**本表的环境列只覆盖 4 类被支持的环境。** macOS、远程 SSH 无图形、容器**不在支持范围内**，
单独放在第四节的「范围外」里 —— 那里写清为什么不做、你会失去什么。

## 一、被支持的 4 类环境（6 列）

| 列 | 是什么 | 关键前提 |
|---|---|---|
| **Windows 桌面** | DeepSeek Harness 桌面客户端 | `restartMode: app`（默认值） |
| **Windows web** | 托管在 Windows 上的 `dsh web` | 必须 `restartMode: command` + 一条真能重启这个进程的 `restartCommand` |
| **Linux web · 有 systemd** | 托管在真实 Linux 上的 `dsh web`，有 `systemd --user` | 同上 |
| **Linux web · 没有 systemd** | 精简镜像 / Alpine 等没有 systemd 的 Linux | 同上 |
| **WSL web · 有 systemd** | WSL 里跑 `dsh web`，发行版里开了 systemd | 同上 |
| **WSL web · 没有 systemd** | WSL 里跑 `dsh web`，没开 systemd | 同上 |

> 「有 / 没有 systemd」只影响**开机自启怎么建议**（见第三节「开机自启建议」一行）；
> 其它能力在两边一样。

## 二、图例（四选一，每格都必须落在这四种里）

| 记号 | 含义 |
|---|---|
| ✅ | **有实现，且有测试覆盖**（测试文件名写在最后一列） |
| ⚠️ | **有实现，但只到计划层 / 单测层，没有真机验证**，或者有条件才成立（条件写在格子里） |
| ❓ | **查不到或不确定**（代码里找不到对应实现，或行为依赖外部系统回答不了） |
| ❌ | **明确不支持**，格子（或说明）里写原因 |

## 三、能力矩阵

「实现与测试」一列是**同一行所有格子共用的证据**；格子里只写这一环境特有的差异。

| 能力 | Windows 桌面 | Windows web | Linux web · 有 systemd | Linux web · 无 systemd | WSL web · 有 systemd | WSL web · 无 systemd | 实现与测试 |
|---|---|---|---|---|---|---|---|
| **重启**（把 DSH 自己重启起来） | ✅ 插件用一条**脱离进程树**的命令 kill + 重新 start 应用（WMI 主、`schtasks` 兜底）；**0.9.6 本版真机已验**（**人工目视确认**设置页，见下面那一节） | ✅ 走 `restartCommand`；**没配就什么都不拉起**，只留检查点并如实报告 | ⚠️ 走 `restartCommand` + POSIX 脱离守护（`setsid`）：单测覆盖，**真实 Linux 实例未验** | ⚠️ 同左 | ✅ 走 `restartCommand`（只杀不拉起的 `/home/fg/restart-web.sh`）+ WSL 里的 `supervise-web.sh` 守护；**真机验过（2026-11-11）**：`generation` **53 → 54**、pid **95091 → 103723**、约 **40 秒**后页面重新可用，健康路由 `phase: restarting → idle`，日志只有**一条** `relaunching in 2s`（早一轮读数：2026-11-03，`generation` 29 → 30、pid 73512 → 114454） | ⚠️ 同左（本机 WSL 开着 systemd，无 systemd 那一档未验） | `lib/restart.js`（命令拼装、WMI、POSIX 脱离守护、Windows 调度、执行 `restartCommand`）、`lib/supervisor.js`、`lib/restart-phase.js`、`lib/restart-verdict.js`。测试：`restart.test.mjs`、`restart-phase.test.mjs`、`restart-safety.test.mjs` |
| **会话续接**（重启后接着干） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 检查点 `lib/checkpoint.js`、启动恢复 `index.js`、`lib/lifecycle.js`（`bootPlan` 与续接提示）。**前提**：宿主真的被拉起来了（桌面靠自带重启，其余靠你的 `restartCommand` / 守护）。测试：`checkpoint.test.mjs`、`lifecycle.test.mjs`、`integration.test.mjs` |
| **重启前备份**（profile 快照） | ✅ | ✅ | ✅ | ✅ | ✅ 真机验过（**2026-11-11**）：新备份目录 `2026-11-11T05-33-49-351Z`；manifest 里 **三类插件口径真的成立** —— `link` 安装的 `dsh-autorestart 0.9.6` → `copied: true`、**156 文件 / 5,339,766 字节**，`link` 安装的 `dsh-release-board 0.1.0` → **22 文件 / 568,298 字节**；`thirdParty` 列表**约 180 项只有 name 与 version，没有任何文件**；总 `bytes` **5,958,563**（早一轮读数：2026-11-03，`snapshot.taken: true`，`<stateDir>/backups/2026-11-03T00-09-28-780Z`，6 756 009 字节，含 `node_modules-link/dsh-autorestart`） | ✅ | `lib/backup.js`（`createBackup`、`<stateDir>/backups/`）；默认 **2 份**、可设 **2–10** 份（`backupLimitInfo` 的 `BACKUP_LIMIT`，配置项 `maxBackups`）。**三类插件分开处理**：手写的 `link` 与本地化的 `localized` **连文件一起拷**（回退能原样还原），其余 `thirdParty` **只记 name + version、不拷文件**。**体积浮动的原因见下面那一节**（体积跟着插件自己的运行数据走，判据是文件数与插件清单，不是字节数）。测试：`backup.test.mjs`、`hosted-backup.test.mjs`、`backup-hygiene.test.mjs` |
| **备份完整性把关**（半份快照不许冒充备份） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/backup.js` 的 `backupIsComplete`（要有可读 manifest **且**至少一个配置文件）；发布前校验，不完整就删掉、不给正式名字。测试：`backup-completeness.test.mjs`、`backup-identity.test.mjs` |
| **备份目录清扫**（启动时） | ⚠️ 只清插件自己留下的 | ⚠️ 同左 | ⚠️ 同左 | ⚠️ 同左 | ⚠️ 同左 | ⚠️ 同左 | 启动时有一次备份目录清扫 `removeIncompleteBackups`（`index.js` 调用、`lib/backup.js` 实现），扫掉「既无 manifest 又无配置文件」的空壳目录；但它**按设计跳过所有 `.` 开头的目录**，所以真正的「半份快照」`*.staging-*` 残留**不会被启动清掉** —— `cleanupStaleStaging` 已经写好，但**没有任何生产代码调用它**（只有测试调用）。手动删掉这类残留是安全的。测试：`backup-hygiene.test.mjs`、`backup-staging.test.mjs` |
| **登录 cookie 清理**（重启前清掉过期凭证） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/cookie-clear.js` + `scripts/clear-dsh-auth-cookies.mjs`；结果写进 `<stateDir>/last-cookie-clear.json`（清掉几枚、成功与否）。清不掉**不阻拦**重启，但会如实报出来。测试：`cookie-clear.test.mjs` |
| **关机倒数**（收工关机） | ✅ 真关过电 | ✅ 真关过电 | ⚠️ `systemctl poweroff`（退 `shutdown -h now`）：**POSIX 没真关过电**（用户决定不真关） | ⚠️ `systemctl` 通常不存在 → 只剩 `shutdown -h now`，**两条都可能失败**，而界面仍说「关闭这台 Linux 主机」 | ⚠️ 走 `/mnt/c/Windows/System32/shutdown.exe`，**关的是整台 Windows**（Windows 侧真关电已验，WSL 分支只到计划层） | ⚠️ 同左 | `lib/sleep.js`（`detectShutdownPlan`、WSL / Linux 分支）、`lib/host-kind.js`。测试：`sleep-plan-posix.test.mjs`、`sleep.test.mjs`、`sleep-choice.test.mjs`、`sleep-intent.test.mjs` |
| **开机自启建议** | ✅ 桌面版自带重启，页面直接说「这里不用装守护」 | ✅ 建议 + 可安装（计划任务；「任务被拒时退启动文件夹」只到单测） | ✅ systemd user unit | ✅ 只给两条出路（在 WSL 里打开 systemd / 让 Windows 拉起发行版），**不替用户改系统** | ✅ 真装真卸过 | ✅ 同左（无 systemd 的那两条出路） | `lib/autostart-advice.js`（`planAutostartAdvice`）、`lib/supervisor.js`（`planSupervisorInstall` / `installSupervisor` / `uninstallSupervisor`）、`lib/supervisor-config.js`（容器与无 init 的处理）、`lib/startup-mode.js`。测试：`autostart-advice.test.mjs`、`supervisor-systemd.test.mjs`、`startup-mode.test.mjs` |
| **设置页可见性**（四组） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 四组：**重启相关设置 / 关机相关设置 / 开机自启 / 遇到问题**（`client.js` 的 `settings.groups.*`）。备份的两个开关、备份份数上限与备份列表在「重启相关设置」组里；清 cookie 没有单独分组（每次重启前自动做，结果在 `last-cookie-clear.json`）。全部走普通 HTTP 路由，浏览器在哪台机器上看都一样。测试：`settings-save-notice.test.mjs`、`settings-startup-backup.test.mjs` |
| **单插件回退**（某个插件起不来） | ✅ 从备份里挑**一个**插件退回上一个版本 | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/plugin-recover.js`（`restoreOnePlugin` 等）、`lib/plugin-compare.js`（`detectPluginRecovery`）。**注意**：启动时的自动检测**已经被拿掉**（宿主拒绝 boot 期工具调用），现在只有「磁盘上的报告」+「手动回退」。测试：`plugin-recover.test.mjs`、`manual-rollback.test.mjs`、`plugin-compare.test.mjs` |
| **一次性告知**（升级 / 首装弹一次） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 新功能公告按**功能版本**而不是包版本记账（`index.js` 的 `SLEEP_FEATURE_VERSION` 等常量），首装提问与插件失败面板同属这一层。测试：`announcement.test.mjs`、`onboarding-card.test.mjs`、`plugin-failure-panel.test.mjs` |
| **诊断信息**（报告问题） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/diagnostics.js`（`buildDiagnostics`）；**不含访问令牌、不含密钥**。测试：`diagnostics.test.mjs`、`tool-output-schema.test.mjs` |

> **为什么这一列不写行号**：0.9.0 删掉了自动救场那一整条线（一整套模块与脚本），代码行号整体位移，
> 任何写死的行号都会指错地方。**文件名与测试文件名才是稳定的**，改完代码请回来同步这一列。

### Windows 桌面端 0.9.6 的真机确认（2026-11-11）

用户在 **DSH 桌面版**打开「**设置 → 自动重启与关机**」，逐项目视确认（**人工看截图确认**，不是跑自动化测试）：

| 项 | 确认到的 |
|---|---|
| ① 「重启前备份」说明 | 是新的**整段**：比对什么、**默认保留 2 份**、份数在下方「保留份数」里改、关掉不比对也不产存档、存档不自动还原 |
| ② 「备份包含已安装插件」 | **三行三类口径**，**缩进在「重启前备份」下面、左侧有淡竖线** |
| ③ 「保留份数」 | 显示 **2**，与「备份包含已安装插件」在**同一个缩进组**里（**已不在「备份信息」折叠内**） |
| ④ 「备份信息」折叠 | **只剩只读内容** |
| ⑤ 关机倒数秒数 | 显示 **10 秒** |

用户原话：「设置页面我看了觉得没有问题了」。

> 这一节只覆盖**设置页界面**的目视确认；Windows 桌面端**重启本身**的行为仍由上表「重启」那一行的实现与测试列负责。

### 备份体积从哪来、为什么会浮动（桌面端实测，2026-11-11）

**体积几乎全来自「连文件一起拷」的那几类插件**；线上第三方插件只往 manifest 里记名字和版本，**在磁盘上不占空间**。

桌面端实测（读数来自 `backups/<stamp>/manifest.json` 与磁盘 stat）：

| 备份 | 体积 | 文件数 | `links` | `localized` | `thirdParty` |
|---|---|---|---|---|---|
| `2026-11-11T06-36-48-336Z` | **132.1 MB** | **820** | 7 | 0 | 145（只记名字 + 版本） |
| `2026-11-11T04-13-04-262Z` | 129.2 MB | 820 | 7 | 0 | 145（只记名字 + 版本） |

`linkBytes` 是 **138,395,369** ≈ 整份副本的字节；两份备份的**结构完全一致**，只有字节数动了。

被连文件拷的 7 个插件各占多少：

| 插件 | 体积 |
|---|---|
| `dsh-codekg` | **118.7 MB** |
| `dsh-goal-guard` | 6.1 MB |
| `dsh-autorestart` | 5.1 MB |
| `dsh-secret-vault` | 1.2 MB |
| `dsh-github-guard` | 0.4 MB |
| `dsh-security-scan` | 0.3 MB |
| `dsh-web-fetch-fallback` | 0.1 MB |

**`dsh-codekg` 一个占约 86%**，它内部几乎全是自己的 `data/`（**114.0 MB**）：`snapshots/` **99.6 MB**
（108 个文件，绝大多数是工具自己写的 `run-*.json` 基线）、`graphs/` 11.4 MB、`runs/` 2.9 MB。

> **体积浮动的原因**：备份体积跟着插件**自己的运行数据**涨落（这里是 codekg 的图谱与基线）。
> **体积浮动不代表备份出错、也没漏插件**——判据是**文件数与插件清单**，不是字节总数。

### WSL web · 有 systemd 的真机验收（2026-11-11）

隔离实例（按 `docs/web-dev-instance.md` 搭起，**没碰 Windows 桌面版**）：

| 项 | 实测 |
|---|---|
| 端口 / profile | `5601` / `/home/fg/.dsh/profiles/web` |
| 加载的版本 | manifest 里是 `dsh-autorestart 0.9.6` |
| ① 页面与鉴权 | 不带 token 访问 `/` → **401**；用日志里的 token 换 cookie → **303**；带 cookie 访问 `/` → **200** |
| ② 命令模式重启 | 重启前 `generation=53`、`pid=95091`；经 `POST /__dsh_autorestart/park` 入队一次重启；约 **40 秒**后 `pid=103723`、`generation=54`，健康路由 `phase: restarting → idle`，页面重新 **200**；日志里只有**一条** `relaunching in 2s` |
| ③ 重启前备份 | 新备份目录 `2026-11-11T05-33-49-351Z`，总 `bytes` **5,958,563**。三类插件口径真的成立：`dsh-autorestart 0.9.6`（`link`）→ `copied: true`、**156 文件 / 5,339,766 字节**；`dsh-release-board 0.1.0`（`link`）→ **22 文件 / 568,298 字节**；`thirdParty` 列表**约 180 项只有 name 与 version，没有任何文件** |
| 未验 | Windows web、真实 Linux、WSL **无 systemd** 三档仍为 ⚠️（没跑过，不用推断冒充） |

#### 踩到的坑：`restartCommand` 指向「自己拉起新进程」的脚本

实例曾把 `restartCommand` 指向 `restart-web-self.sh`：那个脚本 `pkill` 之后**自己 `setsid` 拉起一个新进程**，
而 `supervise-web.sh` 守护循环在子进程退出后**也会**拉起一个。两套同时拉：一个先抢到 5601，另一个撞
`listen EADDRINUSE: address already in use 127.0.0.1:5601` 秒退，守护循环每 ~10 秒重试一次——
日志里刷出一串失败，**看起来像「插件在无限重启」，其实插件只重启了一次**（`generation` 一直停在 53）。

**正确配对**：`restartCommand` 指向**只杀不拉起**的 `restart-web.sh`，拉起完全交给 `supervise-web.sh`。
判据：重启一次后 `pgrep -af "dsh web --port 5601"` 只有 **1 个**进程、`pgrep -c -f supervise-web.sh` 只有 **1 个**
循环，日志里每次重启只有**一条** `relaunching in 2s` —— 改成这样之后，这次实测就是**一次重启、一条 relaunch、
gen 53 → 54**。完整写法见 [`docs/web-dev-instance.md`](../../docs/web-dev-instance.md)（工作区根目录那份）。

### WSL web · 有 systemd 的真机验收（2026-11-03，早一轮读数）

隔离实例（按 `docs/web-dev-instance.md` 搭起，**没碰 Windows 桌面版**）：

| 项 | 实测 |
|---|---|
| 端口 / profile / 状态目录 | `5601` / `/home/fg/.dsh/profiles/web` / `/home/fg/.dsh/storages/dsh-autorestart` |
| 加载的代码 | 插件以软链指向工作区 `plugins/dsh-autorestart`（不是 npm 旧版）；`health.version = 0.8.6`（**这一行是 0.8.6 那次验收的读数**，0.9.0 尚未在该实例上复验） |
| 重启模式 | `restartMode: command`、`restartCommand: /home/fg/restart-web.sh`（+ `supervise-web.sh` 守护） |
| ① 重启真的发生 | `generation` **29 → 30**；pid **73512 → 114454**；守护日志 `dsh web exited at 2026-11-03T08:09:31+08:00, relaunching in 2s`，随后打印新 token |
| ② 版本 | `version = 0.8.6`（同上，是那次的读数） |
| ③ 残留 | systemd user unit **0**、timer **0**、cron **0**、`*.lock` **0**；`supervise-web.sh` 1 个、`dsh web` 1 个（守护本来就该在跑，属预期值） |
| ④ 记录 | `last-restart-verdict.json`：`result: "ok"`、`mode: "command"`、四项自检 `listener` / `routes`(15 条) / `plugin` / `recovery` 全部 `ok: true`；`last-restart-request.json`：`snapshotTaken: true`、`snapshotDir: /home/fg/.dsh/storages/dsh-autorestart/backups/2026-11-03T00-09-28-780Z` |
| 未验 | Windows web、真实 Linux、WSL **无 systemd** 三档仍为 ⚠️（没跑过，不用推断冒充） |

## 四、范围外：macOS / 远程 SSH 无图形 / 容器

**这一节是结论，不是待办。** 用户已裁定：插件只对上面 4 类环境负责；
下面三种环境**未实测、不在支持范围**，装上去可能「看着能跑」，但没有任何一项承诺。

为什么不做：这三种环境缺的是**同一个东西** —— 一台「插件能自己动、且承诺会回来」的机器。
macOS 上没有任何一处代码做过真机验证；远程 SSH 无图形环境里没有桌面；
容器里「谁把宿主拉回来」由编排器说了算，插件连承诺的资格都没有。

### 4.1 macOS（`process.platform === 'darwin'`）

- 代码里只认得出它（`lib/host-kind.js`），关机计划里有一条 `osascript` 分支（`lib/sleep.js`）——
  **这条分支从未在真机上跑过**，也没有任何测试覆盖真机行为。
- **你会失去什么**：
  - 关机倒数不可靠：那条 `osascript` 分支未经真机验证；
  - 会话续接、备份、诊断这些与平台无关的部分理论上照常工作，但**没有任何人验证过**。

### 4.2 远程 SSH 无图形环境

- 插件不检测「我在 SSH 里」，也没有为它做任何分支。它看到的只是「一个不是桌面客户端的宿主进程」。
- **你会失去什么**：
  - 没有桌面；
  - 「开机自启建议」给出的 systemd unit 在断线后会继续存在，但**它拉起的是宿主，不是你的 SSH 会话**，
    别把它当「登录后自动接上」；
  - 会话续接仍然会发生（新宿主起来后会恢复会话），但**什么时候起来取决于你或你的守护**，不取决于有人登录。

### 4.3 容器（Docker / Compose / Kubernetes）

- 插件**只在一个地方**认容器：开机自启的推导（`lib/supervisor-config.js` 的 `detectContainer`、
  `lib/startup-mode.js` 与 `lib/autostart-advice.js`），答案是「由编排器负责，这里没有『登录时自启』」。
- **关机倒数不认识容器**：`lib/sleep.js` 只按 `platform === 'linux'` 分支，
  所以容器里拿到的计划和一台普通 Linux 一模一样（`systemctl poweroff`，退 `shutdown -h now`）。
  **早期文档写的「容器里命令是空的、什么都不会执行」与代码不符** —— 实际是「会真的去关这台 Linux」，
  在容器里可能只是失败，也可能连带影响宿主的 init 进程，**没有验证过，不要依赖**。
- **你会失去什么**：
  - 没有「开机自启」这回事：容器由编排器拉起来，插件只会在页面上这么写；
  - 关机倒数不可靠（见上），**别在容器里按那个按钮**；
  - 容器重建后，`<DSH_HOME>/storages/dsh-autorestart/` 下的检查点与备份可能一起消失 —— 那是卷挂载的事，不是插件能保证的。

> 一句话：**在这三种环境里装它，等于自己承担全部风险。**

## 五、关机：会关掉哪台机器？

这一格必须说清楚 —— 猜错了代价太大。原话来自 `lib/sleep.js` 的 `host.label`。

| 你在哪 | 关机倒数按下去会关掉什么 | 界面上的原话 | 代码 |
|---|---|---|---|
| Windows 桌面 | **这台 Windows 电脑** | 「关掉这台 Windows 电脑」 | `lib/sleep.js` |
| Windows 上的 `dsh web` | **这台 Windows 电脑** | 「关掉这台 Windows 电脑」 | `lib/sleep.js` |
| Linux 主机上的 `dsh web` | **那台 Linux 主机** | 「关闭这台 Linux 主机」 | `lib/sleep.js` |
| **WSL 里的 `dsh web`** | **整台 Windows 主机**（不是那个 WSL 小环境！） | 「WSL 里的 DSH → 关掉整台 Windows」 | `lib/sleep.js` |
| 容器 | 按 Linux 分支执行（**不是空命令**） | 「关闭这台 Linux 主机」 | `lib/sleep.js`（容器不检测，见 4.3） |
| macOS | 那条 `osascript` 分支（未真机验） | 「关闭这台 Mac」 | `lib/sleep.js` |

> ⚠️ **在 WSL 里看到关机倒数，意味着你的整台机器会关机** —— 不是只停这个 Web 服务。
> WSL 是 Windows 里的一个 Linux 小环境，关掉它只会停掉那个发行版；要让**主机**关机，
> 插件走的是挂载盘里的 `shutdown.exe`，备选是 `powershell.exe -Command "Stop-Computer -Force"` 和
> `cmd.exe /c shutdown.exe /s /f /t 0`。也就是说：**关的是主机**。
>
> WSL 的判定是**有证据的**：`WSL_DISTRO_NAME` / `WSL_INTEROP` / `/proc/version` 里有 "microsoft" / 挂载盘可读
> （`lib/host-kind.js`）。只靠挂载盘认出来时，界面会明说「疑似 WSL（仅凭 /mnt/c 探测）」而不是假装确定
> —— 因为一台手工挂了 C: 盘的真实 Linux 看起来一模一样。

**验到什么程度**：计划层有单测覆盖（`test/sleep-plan-posix.test.mjs`：WSL 的计划必须走「关整台 Windows」那条分支、
纯 Linux 的计划里不许出现任何 Windows 命令、不支持的平台命令为空且**什么都不执行**）。
**Windows 真关电在本机跑过**；**POSIX 没有真关电** —— 用户决定不真关：为一条常识证据把所有人的会话都断掉不划算。

## 六、0.9.6 明确不做的事

这一节是**承诺的反面**：写清楚插件**不会**替你做什么，免得把「有备份」听成「有人救」。

- **不监视宿主。** 没有任何常驻的监护进程，也不会在宿主崩溃后自己起来把它拉起来。
  它只在**你自己发起的那一次重启**里做事。
- **它自己不会把备份放回去。** 重启前拍的那份快照**只是存档**：不会有人在你不知情的时候把它放回去。
  想回退，你在设置页里点「回退到这一份」，自己确认。
- **没有要手工跑的东西。** 0.9.0 把旧的手工还原脚本与桌面快捷方式一起删掉了，
  出事后请用 DSH 自己的崩溃对话框，或者卸载这个插件。
- **不替你改系统配置。** 开机自启只给建议与可复制的命令，要不要用由你决定。
- **不保证第三方插件可恢复。** 备份里**连文件一起拷**的只有**你自己写的插件**与**你在本机改过的插件**
  （`link` 与 `localized` 两类）；其余**原样安装的线上第三方插件**只记名字和版本、**不拷文件**
  （它们的版本由 `pnpm-lock.yaml` 钉死，重装即可）。
- **不提供备份排除 / 过滤选项。** 0.9.6 的备份是**整份连文件拷贝**，所以体积里含着被备份插件的**运行数据**
  （如 `dsh-codekg` 的 `data/`，实测 114 MB、其中 `snapshots/` 99.6 MB）。这是**有意的**：有些人确实需要
  连运行数据一起备份（换机、留档、出事回看）。**后续方向**是把它做成**配置项**、由用户自己决定拷哪些；
  **本版不做。**

## 七、旧版本文档里已经订正的说法

| 旧说法 | 实际行为 | 依据 |
|---|---|---|
| 「重启前备份默认留 2 份」 | **默认 2 份**，可在设置页设为 **2–10** 份（`maxBackups`） | `lib/backup.js` 的 `backupLimitInfo`、`index.js` 的 `maxBackups` schema |
| 「容器里关机命令是空的、什么都不会执行」 | 容器**不被识别**，走普通 Linux 分支（`systemctl poweroff` → 退 `shutdown -h now`） | `lib/sleep.js` |

## 八、怎么自己验一遍

插件自带测试套件，在包目录下跑：

```sh
node --test
```

想确认「这台机器被认成什么」：打开设置页看「开机自启」那一组，它与 `GET <healthPath>` 报的是同一份答案。

---

**事实核对日期**：2026-11-11（对照 0.9.6 的源码逐个函数核对）。
**这一版不再写行号**：0.9.0 删掉了一整套自动救场模块，行号整体位移，写死行号会指错地方；
文件名与测试文件名是稳定的，改完代码请回来同步这一列。
