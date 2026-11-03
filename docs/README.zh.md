# dsh-autorestart

中文说明 · [English](../README.md)

![dsh-autorestart 图标](../assets/icon-180.png)

当前版本：**0.9.0**

## 它做什么

三件小事，都发生在「重启」前后。

**一、重启排成队。** 有会话要求重启时，插件不会立刻掐断还在跑的对话：它等所有会话都空闲了才动手，重启完再把被打断的活接着做完——会话自动恢复，目标（goal）重新上链。多个会话同时要求重启会合并成一次，且每个请求者都会被唤醒。带 goal 的会话不会把重启卡死：重启前先解除它的 goal（当前那一轮照常跑完，什么都不丢），重启后自动重新武装。

**二、重启前自动备份。** 每次重启前把配置和本地插件目录存到 `~/.dsh/storages/dsh-autorestart/backups/`，最多保留 `maxBackups` 份（默认 2，范围 2–10），旧的和不完整的自动清理。

**三、清掉登录 cookie。** 桌面客户端每启动一次就多一枚 `dsh-auth-*` 通行证，攒多了请求头超过约 16 KB，服务器回 431，客户端只报 `Web authentication failed`。插件在每次重启前把这些过期凭证清掉，结果写进 `last-cookie-clear.json`。

另外还有**收工关机**：左侧栏底部的月亮按钮，等所有会话收工后在屏幕上倒数，然后关掉整台电脑。

## 它不做什么

- **不监视宿主**，也不判断「这次重启回没回来」；
- **不自动还原**：备份只给你手工查看或回滚，插件绝不会在你不知情时改写配置或插件；
- **没有救援脚本**：起不来就用 DSH 自己的崩溃对话框，或重装插件。

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
| `restartCommand` | `''` | `restartMode` 为 `command` 时用的命令 |
| `settleMs` | `2000` | 宿主必须安静多久才允许开始重启 |
| `restartGraceMs` | `10000` | 最后一个会话空闲后额外等待的宽限 |
| `queuedGraceMs` | `60000` | 排队中的收件箱消息最多挡多久 |
| `forceRestartWhenBusy` | `false` | 不等空闲、直接打断正在跑的对话 |
| `blockManualRestart` | `true` | 重启进行中拒绝随手杀进程 |
| `backupOnRestart` | `true` | 每次重启前拍快照 |
| `backupIncludePlugins` | `true` | 快照里包含已装插件目录 |
| `maxBackups` | `2` | 保留几份快照（2–10） |
| `resumeOnBoot` | `true` | 重启后恢复被打断的会话 |
| `recoveryDelayMs` | `6000` | 第一次恢复前等多久 |
| `maxResumeAttempts` | `2` | 每个会话最多尝试几次恢复 |
| `maxSessions` | `4` | 同时恢复几个会话 |
| `autoReloadPage` | `true` | 重启后自动刷新页面 |
| `supervisorMode` | `auto` | `auto` / `installed` / `external` / `off`：谁负责把宿主启动起来 |
| `showSleepButton` | `true` | 显示收工关机按钮 |
| `sleepCountdownSeconds` | `10` | 关机前倒数几秒 |
| `sleepCommand` | `''` | 覆盖默认的关机命令 |

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

## 安装

```
dsh plugin add dsh-autorestart
```

装上就能用，不需要额外配置：默认就会排队重启、每次重启前拍快照、并清掉过期 cookie。

## 卸载

```
dsh plugin remove dsh-autorestart
```

`~/.dsh/storages/dsh-autorestart/backups/` 下的快照是你自己的，卸载不会替你删。

## 许可

MIT
