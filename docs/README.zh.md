# dsh-autorestart

中文说明 · [English](../README.md)

![dsh-autorestart 图标](../assets/icon-180.png)

当前版本：**0.9.0**

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
| `forceRestartWhenBusy` | `false` | 不等空闲、直接打断正在跑的对话；默认永不打断任何会话 |
| `deferPollMs` | `3000` | 等会话空闲时的轮询间隔 |
| `relaunchDelaySeconds` | `2` | 脱离的 helper 在杀掉应用之前等几秒 |
| `backupOnRestart` | `true` | 每次重启前拍快照 |
| `backupIncludePlugins` | `true` | 快照里包含本地 `link:` 装的插件目录（本机约 117 MB、多约 3 秒）；关掉就只备配置文件 |
| `maxBackups` | `2` | 保留几份快照（2–10） |
| `restartCommandTimeoutMs` | `30000` | 重启命令最多让插件等多久（毫秒） |
| `showSleepButton` | `true` | 显示收工关机按钮 |
| `sleepCountdownSeconds` | `20` | 关机前倒数几秒——**下拉框：0 / 10 / 20 / 30 / 60 秒** |
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

### 设置页

四个分组：

| 分组 | 里面有什么 |
|---|---|
| **重启相关设置** | 重启前的等待、两个备份开关、备份份数上限，以及备份列表（每份带时间，和一个「回退到这一份」的按钮） |
| **关机相关设置** | 收工关机的倒数秒数 |
| **开机自启** | 这台机器上「开机自启」怎么做，附可直接复制的命令。插件**不会**替你改系统配置 |
| **遇到问题** | 诊断信息，以及一个「报告问题」按钮：复制诊断并打开预填好的 GitHub issue —— 不含访问令牌、不含密钥 |

## 它把文件写在哪

| 路径 | 内容 |
|---|---|
| `~/.dsh/storages/dsh-autorestart/state.json` | 启动代号、阶段、每个会话的重启状态 |
| `~/.dsh/storages/dsh-autorestart/backups/<时间戳>/` | 一份快照的 `config/` + `node_modules-link/` |
| `~/.dsh/storages/dsh-autorestart/last-cookie-clear.json` | 上次清掉了几枚凭证 |
| `~/.dsh/storages/dsh-autorestart/access.json` | 插件监听的本地端口与令牌 |

## 关于那份备份

它包含**配置文件**（`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`）和**本地 `link:` 装的插件目录**。从 npm 装的插件不在里面——它们可以用 `package.json` + `pnpm-lock.yaml` 重新装回来。所以它适合「看看以前是怎么配的」「把某个插件版本翻回去」，不是一键重装。

## 平台

| 平台 | 状态 |
|---|---|
| Windows 桌面客户端（`restartMode: app`） | 真机验过 |
| WSL 上的托管 `dsh web`，有 systemd（`restartMode: command`） | 真机验过 |
| Windows 上的托管 `dsh web` | 未验 |
| 无 systemd 的 WSL、原生 Linux | 未验 |

macOS、无图形环境的远程 SSH、容器**不在支持范围内** —— 未实测、不支持。逐项能力矩阵见
[platform-matrix.md](platform-matrix.md)。

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

插件自带测试套件，在 `plugins/dsh-autorestart/test/`。用随附的 Node 跑：

```
node --test plugins/dsh-autorestart/test
```

**939** 个用例全绿（939 通过 / 0 失败 / 0 跳过）。

## 许可

MIT
