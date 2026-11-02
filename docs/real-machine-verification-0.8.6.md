# 0.8.6 真机实测读数（原始值，供 release 引用）

这份文档只做一件事：**把真机跑出来的原始读数照抄下来**，供发版说明逐条引用。
它不写结论性的形容词，也不替读者判断。凡是没验的、没观察到的，都留在表里并写明「未验 / 未观察到」。

采集时间：2026-11-02；被测版本：`0.8.6`。

| 环境编号 | 环境 | 结论口径 |
|---|---|---|
| E1 | Windows 桌面客户端（用户日常那台，真 profile） | 已实测（见第 1 节） |
| E3 | WSL `dsh web`，Ubuntu-22.04，**有** systemd | 已实测（见第 2 节） |
| E2 | Windows 上的 `dsh web` | **未验**（见第 4 节） |
| E4 | WSL 无 systemd | **未验**（见第 4 节） |
| E5 / E6 | 原生 Linux（systemd / 无 systemd） | **未验**（见第 4 节） |

---

## 1. E1 — Windows 桌面客户端

| 环境 | 动作 | 读数（原始值） | 判定 |
|---|---|---|---|
| E1 | 读 `health` | `pluginVersion = 0.8.6` | 与本次要发的版本号一致（新代码确实被加载） |
| E1 | 真触发一次重启（`continuum_restart`） | `restart-gate.json` → `action = allow`、`reason = no-agent-running`、`queueMs = 15051`、`quietForMs = 12560`、`settleMs = 10000` | 闸门按预期放行；排队 15051 ms |
| E1 | 同上，读重启结果 | `last-restart-verdict` → `result = ok`、`mode = app`、`generation = 251`、`durationMs = 25388` | 应用模式重启完成，用时 25388 ms |
| E1 | 同上，看进程与端口 | 旧端口 `57538` → 新端口 `57661` | 宿主换了一个进程 |
| E1 | 查计划任务残留 | `schtasks` 匹配 `dsh` / `autorestart` = **0** | 该清掉的清掉了（数字为 0） |
| E1 | 读看门狗报告 | `result = disarmed`、`tier = scheduled-task`、`hostReady = true`、`disarm.ok = true`、`source = boot` | 开机撤防路径成立，报告文件确实写下 |
| E1 | 读最近一份备份内容 | `config/` 3 项 + `node_modules-link/` 2 个插件 + `manifest.json` | 备份结构完整（配置 + 链接插件 + manifest） |
| E1 | 数桌面 backups 目录 | 共 2 份，合计 148.6 MB | 与「保留份数」设置一致 |
| E1 | 桌面目录解析 | `desktopDir = G:\桌面`、`source = registry` | 走注册表，中文路径正确 |
| E1 | 桌面快捷方式 | 文件名为 `DSH 出了事双击这里.lnk` | 快捷方式确实写在解析出的桌面上 |

---

## 2. E3 — WSL `dsh web`（Ubuntu-22.04，有 systemd）

| 环境 | 动作 | 读数（原始值） | 判定 |
|---|---|---|---|
| E3 | 读 `health` | `pluginVersion = 0.8.6`、`watchdog.tier = systemd-run`、`restart.mode = command`、`restart.command = /home/fg/restart-web.sh`、`restart.written = true` | 托管实例加载的是本次版本；重启走命令模式且重启脚本已写下 |
| E3 | 真触发一次重启（命令模式） | 旧 pid `72747` → 新 pid `95638` | 进程确实被重启命令换掉 |
| E3 | 同上，读重启结果 | `lastRestart` → `result = ok`、`mode = command`、`generation = 24`、`durationMs = 11390`、`failedChecks = []`；`generation` 23 → 24 | 命令模式重启完成，用时 11390 ms，四项启动检查无失败项 |
| E3 | 同上，读闸门判定 | `restartGate` → `action = allow`、`reason = no-agent-running`、`queueMs = 3818`、`quietForMs = 81601`、`settleMs = 2000` | 闸门按预期放行；排队 3818 ms |
| E3 | 读最近一份备份 | 5 个文件、共 `5804024` 字节 | 备份结构完整 |
| E3 | 同上，看 `manifest.json` 记了哪些 | `config/cordis.patch.yml`、`config/package.json`、`config/pnpm-lock.yaml`、`node_modules-link/dsh-autorestart`、`node_modules-link/dsh-release-board` | 清单逐项记账，与磁盘一致 |
| E3 | 查 systemd 残留 | `systemctl --user list-timers` 无相关项、`list-units` 无相关项、`--failed` 无相关项 | 该清掉的清掉了（三处均为空） |
| E3 | 读撤防结果 | `disarm.ok = true`、`scheduleRemoved = true`、`source = boot` | 开机撤防成立，调度项已移除 |
| E3 | 读陈旧文件清理 | `watcherHygiene = { scanned: 7, removed: [restart-16/4/5/6/7/8/9-watch.ps1], kept: [], error: null }` | 扫到 7 个、删掉 7 个、保留 0 个、无错误 |
| E3 | 清理后回数 | `ls restart-*-watch.ps1 \| wc -l` = `0` | 与上面的 `removed` 对得上 |

---

## 3. 桌面端救援开关 `emergency-toggle.ps1`（在**真实 profile 副本**上跑）

| 环境 | 动作 | 读数（原始值） | 判定 |
|---|---|---|---|
| 真实 profile 副本 | `-Action disable` | `exit 0`；`bundles` 26 → 25 | 成功摘掉一个 bundle |
| 真实 profile 副本 | `-Action enable` | `exit 0`；`bundles` 25 → 26；JSON 合法；`name` 行未被污染；生成 `package.json.bak-emergency-*` | 成功恢复，且恢复前留了备份 |
| 真实 profile 副本 | 对比 enable 后的位置 | 追加到 bundles 末尾，**不是原位置** | **已知偏差**（见第 5 节，功能可用但顺序变化） |

---

## 4. 未验项（留在表里，不许删）

| 环境编号 | 环境 | 动作 | 读数（原始值） | 判定 |
|---|---|---|---|---|
| E2 | Windows 上的 `dsh web` | —（本轮未起该实例） | 无 | **未验**：本轮没有在这台机器的 Windows 上跑托管（`dsh web`）实例 |
| E4 | WSL **无** systemd | — | 无 | **未验**：这台 WSL 默认带 systemd，构造不出「无 systemd」的 WSL |
| E5 | 原生 Linux（有 systemd） | — | 无 | **未验**：手头没有原生 Linux 机器 |
| E6 | 原生 Linux（无 systemd） | — | 无 | **未验**：手头没有原生 Linux 机器 |

---

## 5. 已知偏差 / 未证实（如实记录）

| 项 | 事实 | 状态 |
|---|---|---|
| 看门狗真武装时的 `armUnits` 输出 | 本轮**没有观察到**——武装窗口太短，来不及抓到该字段 | **未观察到，不得写成已验证** |
| `emergency-toggle.ps1 -Action enable` 的 bundle 位置 | 恢复时追加到 `bundles` 末尾，而不是回到原来的位置（E1 副本实测） | 功能可用（`exit 0`、JSON 合法、`name` 行未污染），顺序与原始不同 |
| 重启等待里 `reason` 曾被丢弃 | 桌面 `reason` 字段曾被 state 白名单裁掉，导致「为什么等」读不回来 | **已修**（本轮修复，白名单已补该字段） |

---

## 6. 这份表能证明什么、不能证明什么

- **能证明**：E1 与 E3 两台真机上，`0.8.6` 的新代码确实被加载（`pluginVersion = 0.8.6`），重启、撤防、备份、系统残留清理都有对应读数，且数字是 0 或预期值。
- **不能证明**：E2 / E4 / E5 / E6 四种环境的行为；看门狗真武装时的 `armUnits`；`enable` 后 bundle 位置与原顺序一致。
- 引用这段话时，请把它读成「两台机器、四种动作路径验过」——上面还有 4 个环境未验、2 项未证实或有偏差，不能当作普适结论引用。
