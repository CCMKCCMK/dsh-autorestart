# 跨环境能力矩阵

这张表只回答一个问题：**「我这台机器到底能做什么，哪一格会缺？」**

插件装在哪台机器上，就只有那台机器的答案 —— 所以每一行能力都按环境分开写，
每一格要么能在代码里找到对应实现（带 `文件:行号`），要么明确写「不支持 / 查不到」。

**本表的环境列只覆盖 4 类被支持的环境。** macOS、远程 SSH 无图形、容器**不在支持范围内**，
单独放在第四节的「范围外」里 —— 那里写清为什么不做、你会失去什么。

## 一、被支持的 4 类环境（6 列）

| 列 | 是什么 | 关键前提 |
|---|---|---|
| **Windows 桌面** | DeepSeek Harness 桌面客户端 | `restartMode: app`（默认值，`index.js:683`） |
| **Windows web** | 托管在 Windows 上的 `dsh web` | 必须 `restartMode: command` + 一条真能重启该进程的 `restartCommand` |
| **Linux web · 有 systemd** | 托管在真实 Linux 上的 `dsh web`，有 `systemd --user` | 同上 |
| **Linux web · 没有 systemd** | 精简镜像 / Alpine 等没有 systemd 的 Linux | 同上 |
| **WSL web · 有 systemd** | WSL 里跑 `dsh web`，发行版里开了 systemd | 同上 |
| **WSL web · 没有 systemd** | WSL 里跑 `dsh web`，没开 systemd | 同上 |

> 「有 / 没有 systemd」只影响**自动回滚用哪种机制**（见第六节）和**开机自启怎么建议**；
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
| **重启**（把 DSH 自己重启起来） | ✅ 插件用一条**脱离进程树**的命令 kill + 重新 start 应用（WMI 主、`schtasks` 兜底） | ✅ 走 `restartCommand`；**没配就什么都不拉起**，只留检查点并如实报告 | ⚠️ 走 `restartCommand` + POSIX 脱离守护（`setsid`）：单测覆盖，**真实 Linux 实例未验** | ⚠️ 同左 | ⚠️ 同左 | ⚠️ 同左 | `lib/restart.js:504`（命令拼装）、`:538`（WMI）、`:871`（POSIX 脱离守护）、`:996`（Windows 调度）、`:1182`（执行 `restartCommand`）；`lib/supervisor.js:1174`。测试：`restart.test.mjs`、`restart-phase.test.mjs`、`restart-safety.test.mjs` |
| **会话续接**（重启后接着干） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 检查点 `lib/checkpoint.js:1047`（`beginBoot`）、`index.js:7493`（启动恢复）、`lib/lifecycle.js:73`（`bootPlan`）/`:423`（续接提示）。**前提**：宿主真的被拉起来了（桌面靠自带重启，其余靠你的 `restartCommand` / 守护）。测试：`checkpoint.test.mjs`、`lifecycle.test.mjs`、`integration.test.mjs` |
| **重启前备份**（profile 快照） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/backup.js:1585`（`createBackup`）、`:915`（`<stateDir>/backups/`）；默认上限 **20 份**（`lib/backup.js:96`，配置项 `index.js:734`），**不是早期文档写的 2 份**。测试：`backup.test.mjs`、`hosted-backup.test.mjs`、`backup-hygiene.test.mjs` |
| **备份完整性把关**（半份快照不许冒充备份） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/backup.js:575`（`backupIsComplete`：要有可读 manifest **且** 至少一个配置文件）、`:2029`（**发布前**校验，不完整就删掉、不给正式名字）、`:746`（`latestKnownGood`：还原只用被验证过能启动的那份）。测试：`backup-completeness.test.mjs`、`backup-known-good-boot.test.mjs`、`backup-identity.test.mjs` |
| **开机清残骸** | ⚠️ 只清插件自己留下的 | ⚠️ 同左 | ⚠️ 同左 | ⚠️ 同左 | ⚠️ 同左 | ⚠️ 同左 | 启动时**撤防**会删掉残留的计划任务 / systemd unit / pending 标记，并清掉能力探测留下的一次性任务（`index.js:6468`、`lib/watchdog-disarm.js:455`/`:261`/`:223`）。启动还有一次备份目录清扫 `removeIncompleteBackups`（`index.js:2088`、`lib/backup.js:2205`），但它**按设计跳过所有 `.` 开头的目录**（`lib/backup.js:2234`），所以真正的「半份快照」`*.staging-*` 残留**不会被启动清掉**：`cleanupStaleStaging`（`lib/backup.js:2295`）已经写好，但**没有任何生产代码调用它**（只有测试调用）。脱离的后台进程也没有孤儿回收。测试：`disarm.test.mjs`、`watchdog-disarm.test.mjs`、`watchdog-probe-cleanup.test.mjs`、`backup-hygiene.test.mjs`、`backup-staging.test.mjs` |
| **自动回滚 · 选档**（一台机器只有一个监护者） | ✅ `scheduled-task` | ✅ `scheduled-task` | ✅ `systemd-run` | ⚠️ `detached-process`（要有 `setsid`） | ✅ `systemd-run` | ⚠️ `detached-process`（要有 `setsid`） | `lib/watchdog-tier.js:110`（`pickWatchdogTier`，唯一决定档位的地方）、`:177`（`tierWithProof`）、`lib/watchdog-arbiter.js:46`（v2 / v1 只选一个）。测试：`watchdog-tier.test.mjs`、`watchdog-arbiter.test.mjs` |
| **自动回滚 · 注册** | ✅ 一次性计划任务（建完回读校验、`IgnoreNew`、`EndBoundary` 必填） | ✅ 同左 | ✅ `systemd-run --user --on-active=<秒>s` | ⚠️ `setsid nohup sh -c 'sleep N; 看门狗'`，pid 写进 stateDir 并回读 | ✅ `systemd-run` | ⚠️ 同 `detached-process` | `lib/watchdog-schedule.js:476`（注册任务）、`:545`（删除任务）、`:576`（`systemd-run`）、`:876`（脱离进程）、`:920`（回收）。失败会先清理再重试一次并如实报告（`index.js:4830`-`4865`）。测试：`watchdog-launcher.test.mjs`、`watchdog-systemd-arm.test.mjs`、`watchdog-strict-mode.test.mjs` |
| **自动回滚 · 撤防** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/watchdog-disarm.js:455`（`disarmWatchdog`，多次重试 + 退避），启动路径与健康路由都会触发（`index.js:6468`）。测试：`disarm.test.mjs`、`watchdog-disarm.test.mjs` |
| **自动回滚 · 报告** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 看门狗流程 `lib/watchdog.js:1224`、选还原点 `:406`、写报告 `:712`、把「结束（撤防）」也写进同一份报告 `:746`。测试：`watchdog.test.mjs`、`watchdog-report-order.test.mjs`、`watchdog-notice.test.mjs` |
| **自动回滚 · 能力探测** | ✅ 真注册一个探测任务 → 回读 → 删掉 | ✅ 同左 | ⚠️ 只看 `systemd-run --version` 在不在，**不做真注册回读** | ⚠️ 只看 `setsid --version` | ⚠️ 只看 `systemd-run` | ⚠️ 只看 `setsid` | `index.js:4605`（只探一次，结果缓存进 `capabilities.json`，设置页打开时不会重复注册任务）、`lib/scheduler-capability.js:165`（`probeSchedulerCapability`）、`lib/watchdog-tier.js:83`（命令存在性探测）。测试：`scheduler-capability.test.mjs` |
| **手动还原**（出事了自己救） | ✅ `restore-profile.cmd` | ✅ 同左 | ✅ `restore-profile.sh` | ✅ 同左 | ✅ 同左 | ✅ 同左 | `scripts/restore-profile.ps1` / `scripts/restore-profile.sh`（+ `.cmd` 外壳 `scripts/restore-profile.cmd`）；脚本按平台选名字 `lib/rescue-paths.js:39`。测试：`scripts-encoding.test.mjs`、`rescue.test.mjs`；演练 `scripts/drill-rescue.ps1` / `drill-rescue.sh` |
| **急救摘除**（把插件从 profile 里摘掉） | ✅ `emergency-disable.cmd` | ✅ 同左 | ✅ `emergency-disable.sh` | ✅ 同左 | ✅ 同左 | ✅ 同左 | `scripts/emergency-disable.cmd` / `scripts/emergency-disable.sh` + `scripts/emergency-toggle.ps1`；`lib/rescue-paths.js:39`。测试：`rescue.test.mjs`、`rescue-ui.test.mjs` |
| **关机倒数**（收工关机） | ✅ 真关过电 | ✅ 真关过电 | ⚠️ `systemctl poweroff`（退 `shutdown -h now`）：**POSIX 没真关过电**（用户决定不真关） | ⚠️ `systemctl` 通常不存在 → 只剩 `shutdown -h now`，**两条都可能失败**，而界面仍说「关闭这台 Linux 主机」 | ⚠️ 走 `/mnt/c/Windows/System32/shutdown.exe`，**关的是整台 Windows**（Windows 侧真关电已验，WSL 分支只到计划层） | ⚠️ 同左 | `lib/sleep.js:149`（`detectShutdownPlan`）、`:176`-`:212`（WSL / Linux 分支）。测试：`sleep-plan-posix.test.mjs`、`sleep.test.mjs`、`sleep-choice.test.mjs`、`sleep-intent.test.mjs` |
| **开机自启建议** | ✅ 桌面版自带重启，页面直接说「这里不用装守护」 | ✅ 建议 + 可安装（计划任务；「任务被拒时退启动文件夹」只到单测） | ✅ systemd user unit | ✅ 只给两条出路（在 WSL 里打开 systemd / 让 Windows 拉起发行版），**不替用户改系统** | ✅ 真装真卸过 | ✅ 同左（无 systemd 的那两条出路） | `lib/autostart-advice.js:68`（`planAutostartAdvice`）、`lib/supervisor-install.js:44`起（任务 / 启动文件夹 / systemd unit / compose 片段）、`lib/supervisor-config.js:585`（容器与无 init 的处理）、`lib/startup-mode.js:342`。测试：`autostart-advice.test.mjs`、`supervisor-install.test.mjs`、`supervisor-systemd.test.mjs`、`startup-mode.test.mjs` |
| **桌面快捷方式**（双击即救） | ✅ `.lnk`，带 DSH 图标，指向 `restore-profile.cmd`；**只有用户点了按钮才写** | ⚠️ 同左，但运行账户没有桌面目录时写不进（页面会说明失败原因） | ❌ 没有可双击的 `.lnk`；页面**不显示这个按钮**，改为直接列出 `.sh` 路径 + 复制按钮 | ❌ 同左 | ❌ 同左 | ❌ 同左 | `lib/rescue-paths.js:502`（`createDesktopShortcut`）、`:417`（`.lnk` 生成脚本）、`:591`（**只有 `win32` 才算桌面目录**）、`:460`（三种失败原因）；写入由用户动作触发 `index.js:10325`。测试：`rescue-ui.test.mjs`、`rescue.test.mjs` |
| **设置页可见性**（五组 + 备份块） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 五组：重启相关设置 / 关机相关设置 / 开机自启 / 遇到问题 / 桌面救援入口（`client.js:283`、`:284`、`:300`、`:444`、`:445`，英文版 `:753`、`:754`、`:770`、`:910`、`:911`）；备份整块折叠成「备份说明及手动备份操作」（`client.js:295`、`:6244`）。全部走普通 HTTP 路由，浏览器在哪台机器上看都一样。测试：`settings-save-notice.test.mjs`、`settings-startup-backup.test.mjs`、`rescue-ui.test.mjs` |
| **单插件回退**（某个插件起不来） | ✅ 从备份里挑**一个**插件退回上一个版本 | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/plugin-recover.js:1420`（`restoreOnePlugin`）、`:1188`（`detectPluginRecovery`），入口 `index.js:6407`。**注意**：启动时的自动检测**已经被拿掉**（宿主拒绝 boot 期工具调用，`index.js:6357`-`6366`），现在只有「磁盘上的报告」+「手动回退」。测试：`plugin-recover.test.mjs`、`manual-rollback.test.mjs`、`plugin-compare.test.mjs` |
| **一次性告知**（升级 / 首装弹一次） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 新功能公告按**功能版本**而不是包版本记账（`index.js:499`、`:6257`、`:6272`），首装提问与插件失败面板同属这一层。测试：`announcement.test.mjs`、`onboarding-card.test.mjs`、`plugin-failure-panel.test.mjs` |
| **诊断信息**（报告问题） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/diagnostics.js:153`（`buildDiagnostics`）；**不含访问令牌、不含密钥**（`lib/diagnostics.js:52`）。测试：`diagnostics.test.mjs`、`tool-output-schema.test.mjs` |

> 行号以本仓当前提交为准。改代码之后请回来同步这一列 —— 一张比代码旧的表比没有表更坏。

## 四、范围外：macOS / 远程 SSH 无图形 / 容器

**这一节是结论，不是待办。** 用户已裁定：插件只对上面 4 类环境负责；
下面三种环境**未实测、不在支持范围**，装上去可能「看着能跑」，但没有任何一项承诺。

为什么不做：这三类环境缺的是**同一个东西** —— 一台「插件能自己动、且承诺会回来」的机器。
macOS 上没有任何一处代码做过真机验证；远程 SSH 无图形环境里没有桌面、也没有能被双击的
救援入口；容器里「谁把宿主拉回来」由编排器说了算，插件连承诺的资格都没有。

### 4.1 macOS（`process.platform === 'darwin'`）

- 代码里只认得出它（`lib/host-kind.js:141`），关机计划里有一条 `osascript` 分支（`lib/sleep.js:215`-`:224`）——
  **这条分支从未在真机上跑过**，也没有任何测试覆盖真机行为。
- **你会失去什么**：
  - 没有桌面救援快捷方式（`.lnk` 是 Windows 的东西，`lib/rescue-paths.js:591`）；
  - 自动回滚只能退化成「自建后台进程」（要靠 `setsid`，macOS 上没有这个命令 → `lib/watchdog-tier.js:135` 走不到，
    实际会落到 `tier: none`，也就是**没有自动回滚**）；
  - 关机倒数不可靠：那条 `osascript` 分支未经真机验证；
  - 会话续接、备份、诊断这些与平台无关的部分理论上照常工作，但**没有任何人验证过**。

### 4.2 远程 SSH 无图形环境

- 插件不检测「我在 SSH 里」，也没有为它做任何分支。它看到的只是「一个不是桌面客户端的宿主进程」。
- **你会失去什么**：
  - 没有桌面、没有桌面快捷方式（页面上「桌面救援入口」那一组只能给出 `.sh` 路径）；
  - 「开机自启建议」给出的 systemd unit 在断线后会继续存在，但**它拉起的是宿主，不是你的 SSH 会话**，
    别把它当「登录后自动接上」；
  - 会话续接仍然会发生（新宿主起来后会恢复会话），但**什么时候起来取决于你或你的守护**，不取决于有人登录；
  - 真正的救援只能靠 `.sh` 脚本 —— 也就是说，你得先能 SSH 上去。

### 4.3 容器（Docker / Compose / Kubernetes）

- 插件**只在一个地方**认容器：开机自启的推导（`lib/supervisor-config.js:312` 的 `detectContainer`、
  `lib/startup-mode.js:342` 与 `lib/autostart-advice.js:89`），答案是「由编排器负责，这里没有『登录时自启』」。
- **关机倒数不认识容器**：`lib/sleep.js:176`-`:212` 只按 `platform === 'linux'` 分支，
  所以容器里拿到的计划和一台普通 Linux 一模一样（`systemctl poweroff`，退 `shutdown -h now`）。
  **早期文档写的「容器里命令是空的、什么都不会执行」与代码不符** —— 实际是「会真的去关这台 Linux」，
  在容器里可能只是失败，也可能连带影响宿主的 init 进程，**没有验证过，不要依赖**。
- **你会失去什么**：
  - 没有「开机自启」这回事：容器由编排器拉起来，插件只会在页面上这么写；
  - 自动回滚退化成插件自己的后台进程（`setsid` 在精简镜像里常常没有 → 直接 `tier: none`，**没有自动回滚**）；
  - 关机倒数不可靠（见上），**别在容器里按那个按钮**；
  - 容器重建后，`<DSH_HOME>/storages/dsh-autorestart/` 下的检查点与备份可能一起消失 —— 那是卷挂载的事，不是插件能保证的；
  - 没有桌面救援入口。

> 一句话：**在这三种环境里装它，等于自己承担全部风险。** 出了问题请按 `.sh` 脚本手工还原，
> 或者别装。

## 五、关机：会关掉哪台机器？

这一格必须说清楚 —— 猜错了代价太大。原话来自 `lib/sleep.js` 的 `host.label`。

| 你在哪 | 关机倒数按下去会关掉什么 | 界面上的原话 | 代码 |
|---|---|---|---|
| Windows 桌面 | **这台 Windows 电脑** | 「关掉这台 Windows 电脑」 | `lib/sleep.js:166` |
| Windows 上的 `dsh web` | **这台 Windows 电脑** | 「关掉这台 Windows 电脑」 | `lib/sleep.js:166` |
| Linux 主机上的 `dsh web` | **那台 Linux 主机** | 「关闭这台 Linux 主机」 | `lib/sleep.js:206` |
| **WSL 里的 `dsh web`** | **整台 Windows 主机**（不是那个 WSL 小环境！） | 「WSL 里的 DSH → 关掉整台 Windows」 | `lib/sleep.js:187` |
| 容器 | 按 Linux 分支执行（**不是空命令**） | 「关闭这台 Linux 主机」 | `lib/sleep.js:206`（容器不检测，见 4.3） |
| macOS | 那条 `osascript` 分支（未真机验） | 「关闭这台 Mac」 | `lib/sleep.js:218` |

> ⚠️ **在 WSL 里看到关机倒数，意味着你的整台机器会关机** —— 不是只停那个 Web 服务。
> WSL 是 Windows 上的一个 Linux 小环境，关掉它只会停掉那个发行版；要让**主机**关机，
> 插件走的是挂载盘里的 `shutdown.exe`（`/mnt/c/Windows/System32/shutdown.exe /s /f /t 0`），
> 备选是 `powershell.exe -Command "Stop-Computer -Force"` 和
> `cmd.exe /c shutdown.exe /s /f /t 0`（`lib/sleep.js:193`-`:197`）。也就是说：**关的是主机**。
>
> WSL 的判定是**有证据的**：`WSL_DISTRO_NAME` / `WSL_INTEROP` / `/proc/version` 里有 "microsoft" / 挂载盘可读
> （`lib/host-kind.js:60`）。只靠挂载盘认出来时，界面会明说「疑似 WSL（仅凭 /mnt/c 探测）」而不是假装确定
> （`lib/sleep.js:186`）—— 因为一台手工挂了 C: 盘的真实 Linux 看起来一模一样。

**验到什么程度**：计划层已验证（`test/sleep-plan-posix.test.mjs`：WSL 的计划必须走「关整台 Windows」那条分支、
纯 Linux 的计划里不许出现任何 Windows 命令、不支持的平台命令为空且**什么都不执行**）。
**Windows 真关电已验**；**POSIX 没有真关电** —— 用户决定不真关：为一条常识证据把所有人的会话都断掉不划算。

## 六、三档调度是怎么选的

`lib/watchdog-tier.js:110` 的 `pickWatchdogTier()` 是**唯一**决定档位的地方
（设置页的警告、diagnostics 里的说明、真正注册看门狗，问的都是它）：

| 档 | 机制 | 什么机器 |
|---|---|---|
| `scheduled-task` | 一次性 Windows 计划任务（`lib/watchdog-schedule.js:476`：建完回读校验、用完全删、`IgnoreNew`、`EndBoundary` 必填） | Windows（桌面与 web） |
| `systemd-run` | `systemd-run --user --on-active=<秒>s --unit=dsh-autorestart-watchdog`（`lib/watchdog-schedule.js:576`），结束后 `systemctl --user reset-failed` | Linux、WSL（有 systemd 时） |
| `detached-process` | `setsid nohup sh -c 'sleep <秒>; <看门狗>' >/dev/null 2>&1 &`（`lib/watchdog-schedule.js:894`），pid 写进 stateDir 并回读确认还活着 | Linux / WSL（没有 systemd，但有 `setsid` 时） |
| `none` | 没有可用机制 → **看门狗不注册**，`tier: 'none'`，设置页与 diagnostics 都明说「没有自动回滚」 | 被策略禁用的机器、没有 `schtasks` 的 Windows、既没有 systemd 也没有 `setsid` 的机器、macOS |

**一台机器同时只会有一个监护者**：`lib/watchdog-arbiter.js:46` 先看插件自己的守护（v2）能不能用，
能用就用它，用不了才回落到「脱离进程 + 计划任务」那一套（v1）。两个一起上会互相打架。

## 七、手工还原脚本在每个平台上做什么

两个版本是**同一套规则**（`scripts/restore-profile.ps1` 与 `scripts/restore-profile.sh`）：

1. 默认取 `<stateDir>/backups/` 里**最新、完整、且被验证过能启动**的那份（`lib/backup.js:746`）；
2. 还原前把现在的 profile 整份挪到 `<profileDir>.broken-<UTC 时间戳>`（**不删**）；
3. 还原后回读校验：`package.json` 能解析、`dsh.profile.bundles` 非空、
   **声明了 `dsh-autorestart` 就必须能在 `node_modules` 里读到版本号**；
4. 路径闸门：只接受 `<DSH_HOME>/profiles/*` 或显式指定的隔离路径；
   拒绝 `/`、`/usr`、`/etc`、`$HOME` 本身、别人的家目录；
5. **不自动重启 DSH**；`--dry-run`（Windows `-DryRun`）可以先看会发生什么。

中文文案都来自 `scripts/rescue-strings.zh.json`（UTF-8 **无 BOM**）；没有 node 的
机器上退回英文。

## 八、旧版本文档里已经订正的说法

| 旧说法 | 实际行为 | 依据 |
|---|---|---|
| 「设置页只显示这台机器上真有的脚本路径」 | 页面**每个平台都会列出两条脚本路径**并带复制按钮；路径是**按平台名拼出来的**，代码不校验文件是否真在磁盘上；只有「桌面快捷方式」是 Windows 专属 | `lib/rescue-paths.js:39`、`:614`、`:615`；`client.js:7710`-`7760`、`:7743` |
| 「重启前备份默认留 2 份」 | 默认上限 **20 份**（`maxBackups`） | `lib/backup.js:96`、`index.js:734` |
| 「容器里关机命令是空的、什么都不会执行」 | 容器**不被识别**，走普通 Linux 分支（`systemctl poweroff` → 退 `shutdown -h now`） | `lib/sleep.js:176`-`:212` |
| 「自动回滚被拒时的降级链路」 | 仍然**有意不做**：被禁就是被禁，只告知，不偷偷换别的机制 | `lib/watchdog-tier.js:117`-`:147`（Windows 没有 `schtasks` 直接 `none`） |

## 九、怎么自己验一遍

| 平台 | 命令 |
|---|---|
| Windows | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/drill-rescue.ps1` |
| Linux / WSL | `sh scripts/drill-rescue.sh` |

演练在**自己的临时目录**里造假 profile、故意弄坏、还原、断言，然后清理干净 ——
它不碰任何正在用的 profile。

想确认「这台机器被认成什么」：打开设置页看「开机自启 / 启动方式 / 看门狗档位」三处，
它们与 `GET <healthPath>` 报的是同一份答案。

---

**事实核对日期**：2026-11-02（对照仓库当时提交的源码逐个函数核对；行号只在这一天成立）。
