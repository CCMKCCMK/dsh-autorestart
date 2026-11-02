# 0.8.6 真机实测读数（原始值，供 release 引用）

这份文档只做一件事：**把真机跑出来的原始读数照抄下来**，供发版说明逐条引用。
它不写结论性的形容词，也不替读者判断。凡是没验的、没观察到的，都留在表里并写明「未验 / 未观察到」。

采集时间：**2026-11-02 18:50–19:05**（主采窗口）；被测版本：`0.8.6`。
另有两处更早的采样（17:33、18:28）用于看「未完成备份目录」的生命周期，已在该行单独标注时间，不并入主窗口。
**本轮读数取代早前一轮的读数**：早前一轮的 `generation` / 端口 / pid 等数字不再作为 0.8.6 的证据引用。

| 环境编号 | 环境 | 结论口径 |
|---|---|---|
| E1 | Windows 桌面客户端（用户日常那台，真 profile） | 已实测（见第 1 节） |
| E3 | WSL `dsh web`，Ubuntu-22.04，**有** systemd | 已实测（见第 2 节） |
| E2 | Windows 上的 `dsh web` | **未验**（见第 4 节） |
| E4 | WSL 无 systemd | **未验**（见第 4 节） |
| E5 / E6 | 原生 Linux（systemd / 无 systemd） | **未验**（见第 4 节） |

---

## 1. E1 — Windows 桌面客户端（真 profile，应用模式）

| 环境 | 真触发的动作 | 读数（原始值） | 判定 |
|---|---|---|---|
| E1 | 重启**前**读 `health`（旧实例，端口 `52601`） | `pluginVersion = 0.8.6`、`backups.count = 2`、`backups.incomplete = 0`、`watchdog.tier = scheduled-task`、`restart.mode = app` | 动手前加载的是本次版本；盘上没有半份备份 |
| E1 | **真触发一次重启**（`continuum_restart`，排队后执行） | 端口 `52601` → **`50519`** | 宿主换了一个进程（应用模式自己拉起自己） |
| E1 | 重启**后**读 `health`（新实例，端口 `50519`） | `pluginVersion = 0.8.6`、`generation = 264`、`restart.mode = app`、`lastRestart.result = ok`、`lastRestart.durationMs = 26067`、`watchdog.tier = scheduled-task`、`backups.count = 2`、`backups.incomplete = 1` | 新实例报的版本仍是 `0.8.6`（新代码确实被加载）；重启判定 `ok`、用时 `26067` ms；此刻盘上有 **1 份未完成备份**（窗口见第 5 节观察①） |
| E1 | 重启后**立刻**读 `backupHygiene` | `{"skipped":false,"removed":[],"kept":["2026-11-01T13-33-42-271Z","2026-11-01T23-14-17-160Z","2026-11-02T11-00-17-754Z"],"scanned":3,"bytes":0,"error":null}` | 清扫**没有删**任何东西（`removed: []`），扫到 3 个、保留 3 个、释放 0 字节、无错误——年轻目录被年龄保护挡住（见观察①） |
| E1 | **17:33 采样**：数备份目录 | 3 个目录；其中 `2026-11-02T09-31-54-480Z` = **460 个文件 / 152.8 MB / 没有 manifest** | 盘上确实存在一份没有 `manifest` 的半成品 |
| E1 | **18:28 复查**：同一台机器再数一次 | 该目录已不存在；磁盘回到 **2 个**目录、两个都有 `manifest`；`health` 变成 `count = 2`、`incomplete = 0` | 半成品在窗口过后被清扫掉了；`health` 的 `incomplete` 回到 `0` |

---

## 2. E3 — WSL `dsh web`（Ubuntu-22.04，有 systemd，命令模式）

| 环境 | 真触发的动作 | 读数（原始值） | 判定 |
|---|---|---|---|
| E3 | 起托管实例 | `/home/fg/supervise-web.sh`；进程 `node /home/fg/.npm-global/bin/dsh web --port 5601 --no-open` | 托管实例由外部脚本拉起（`supervisor mode: external`） |
| E3 | 重启**前**读 `health` | `pluginVersion = 0.8.6`、`restart.mode = command`、`restart.command = /home/fg/restart-web.sh`、`watchdog.tier = systemd-run`、`watchdog.disarm.ok`；`diagnostics` → `host kind: wsl`、`desktop client: no`、`supervisor mode: external` | 加载的是本次版本；重启走命令模式且命令已记下；看门狗档位是 `systemd-run` |
| E3 | **真触发一次命令模式重启**（`POST /__dsh_autorestart/park`，body 含真实 `sessionId` 与 `restart: true`） | 请求 `state = queued`；旧 pid **`1503175`** → 新 pid **`1532646`** | 重启命令确实把进程换掉了 |
| E3 | 重启**后**读 `lastRestart` | `result = ok`、`durationMs = 25158`、`failedChecks = []`、`generation = 28` | 命令模式重启完成、用时 `25158` ms，四项启动检查无失败项 |
| E3 | 查 systemd 残留 | `systemctl --user list-timers \| grep autorestart` = **0**；`systemctl --user list-units \| grep autorestart` = **0** | 该清掉的清掉了（两处均为 0） |
| E3 | 读备份状态 | `backups.incomplete = 1` | 与 E1 同一种窗口：重启刚结束、半成品还没到年龄（见观察①） |

---

## 3. 桌面端救援开关 `emergency-toggle.ps1`（**早前一轮**的读数，本轮未复采）

这一节的读数来自同一版本（`0.8.6`）的**更早一轮**实测，本轮 18:50–19:05 没有重跑；保留它是为了让发版说明仍能引用，但不要读成「本轮采到」。
试跑对象是**真实 profile 的副本**，不是真 profile 本体。

| 环境 | 真触发的动作 | 读数（原始值） | 判定 |
|---|---|---|---|
| 真实 profile 副本 | `-Action disable` | `exit 0`；`bundles` 26 → 25 | 成功摘掉一个 bundle |
| 真实 profile 副本 | `-Action enable` | `exit 0`；`bundles` 25 → 26；JSON 合法；`name` 行未被污染；生成 `package.json.bak-emergency-*` | 成功恢复，且恢复前留了备份 |
| 真实 profile 副本 | 对比 enable 后的位置 | 追加到 `bundles` 末尾，**不是原位置** | **已知偏差**（见第 6 节，功能可用但顺序变化） |

---

## 4. 未验项（留在表里，不许删）

| 环境编号 | 环境 | 真触发的动作 | 读数（原始值） | 判定 |
|---|---|---|---|---|
| E2 | Windows 上的 `dsh web` | —（本轮没有起该实例） | 无 | **未验**：本轮没有在这台机器的 Windows 上跑托管（`dsh web`）实例 |
| E4 | WSL **无** systemd | — | 无 | **未验**：这台 WSL 默认带 systemd，构造不出「无 systemd」的 WSL |
| E5 | 原生 Linux（有 systemd） | — | 无 | **未验**：手头没有原生 Linux 机器 |
| E6 | 原生 Linux（无 systemd） | — | 无 | **未验**：手头没有原生 Linux 机器 |

---

## 5. 本次观察（不是缺陷，但必须留档）

| 观察 | 事实（原始读数） | 说明 |
|---|---|---|
| ① 每次重启都会**短暂**留下一个未完成备份目录 | 本轮两次重启（E1 桌面、E3 WSL）各留一份。E1 上实测到的是 `2026-11-02T09-31-54-480Z`：460 个文件 / 152.8 MB / **没有 manifest**；17:33 采样时它在盘上，18:28 复查时已不存在（磁盘回到 2 个目录、两个都有 manifest、`health` 的 `count=2`、`incomplete=0`）。重启后立刻读 `backupHygiene` 得到 `removed: []`、`scanned: 3`、`kept: 3`、`bytes: 0`、`error: null` | 备份是**先写成暂存目录、落盘完成才改名**，所以任何中断（包括正常重启把进程换掉）都会短暂留下一个暂存目录。它在 **2 分钟年龄保护窗口**内被保留，出了窗口才被清扫；也就是说 `health` 在窗口内会如实报 `incomplete = 1`，窗口过后回到 `0`。**这不是缺陷，是窗口期的如实上报**——但引用时不要把窗口内的 `incomplete=1` 写成「备份坏了」 |
| ② `health?state=1` 在托管实例上**单次响应约 16.5 秒** | E3（WSL `dsh web`）上单次 `health?state=1` 约 16.5 秒返回 | 该路由会**遍历备份目录**（份数、每份时间、总占用都要真读），备份越大越慢。桌面端（E1）没有这个体感；引用 `health?state=1` 的数字时要连这个耗时一起说，不要让人以为是瞬间返回 |

---

## 6. 已知偏差 / 未证实（如实记录）

| 项 | 事实 | 状态 |
|---|---|---|
| 看门狗真武装时的 `armUnits` 输出 | 本轮**没有观察到**——武装窗口太短，来不及抓到该字段 | **未观察到，不得写成已验证** |
| `emergency-toggle.ps1 -Action enable` 的 bundle 位置 | 恢复时追加到 `bundles` 末尾，而不是回到原来的位置（真实 profile 副本实测） | 功能可用（`exit 0`、JSON 合法、`name` 行未污染），顺序与原始不同 |
| 重启等待里 `reason` 曾被丢弃 | 桌面 `reason` 字段曾被 state 白名单裁掉，导致「为什么等」读不回来 | **已修**（早前一轮修复，白名单已补该字段） |

---

## 7. 这份表能证明什么、不能证明什么

- **能证明**（本轮 2026-11-02 18:50–19:05 的读数）：
  - E1 与 E3 两台真机上，`0.8.6` 的代码**确实被加载**——两台在重启前后读到的 `pluginVersion` 都是 `0.8.6`（桌面新实例还报了 `generation = 264`、WSL 报了 `generation = 28`）。
  - **两条重启路径都在真机上走通了**：E1 应用模式（端口 `52601` → `50519`，`durationMs = 26067`）、E3 命令模式（pid `1503175` → `1532646`，`durationMs = 25158`），两边 `lastRestart.result` 都是 `ok`。
  - **该清掉的清掉了**：E3 的 `systemctl --user list-timers` / `list-units` 匹配 `autorestart` 都是 **0**；E1 的 `backupHygiene` 报告 `error: null`。
  - **该写下的写下了**：E1 的 `backupHygiene` 读回真实目录清单、`health` 读回 `backups.count` / `incomplete`；E3 读回 `watchdog.tier = systemd-run`、`disarm.ok`。
- **不能证明**：
  - **E2 / E4 / E5 / E6 四格是空的**——Windows 上的 `dsh web`、无 systemd 的 WSL、原生 Linux（有/无 systemd）本轮一个都没跑，不能因为「同一份代码」就推断它们也行。
  - 看门狗真武装时的 `armUnits`：本轮仍未观察到。
  - `emergency-toggle.ps1 -Action enable` 后 bundle 回到原位置：已知是追加到末尾，且这一节还是早前一轮的读数。
  - 窗口期的 `incomplete = 1` 不代表备份损坏；数据能证明的是「窗口内如实上报、窗口后回到 0」，不是「每一刻都是 0」。
  - `health?state=1` 在托管实例上要约 16.5 秒，不能读成「健康检查是瞬时的」。
- 引用这段话时，请把它读成「**两台真机、两条重启路径验过；另有 4 个环境未验、2 项未证实或有偏差**」，不能当作普适结论引用。

## 2026-11-02 21:00 界面改版后的复核（第二轮）

这一节只追加本轮读数，上面任何历史条目都没有改动。**每条都标了证据强度**：`【实测】` = agent 本轮自己读出来的原始值；`【队长目视】` = 队长在真机界面上看到/触发的，agent 没有独立复现；`【未验】` = 明确没有证据。

1. **【队长目视】宿主已重启加载新代码，界面能打开。** `Ctrl+,` → 设置 →「自动重启与关机」可正常打开；该屏**未见**「安全份」「已验证」「可放心回退」「认证依据」任何字样。（agent 本轮没有独立操作界面。）
2. **【未验】折叠块「备份说明及手动备份操作」在自动化点击下不展开。** 队长试了 4 次（点三角、点标题文字、点整行；先后用后台 UIA/PostMessage 与前台 SendInput 两种投递），每次点完仍是收起状态。因此折叠块展开后的**两行份数文案、下拉框右侧提示、窄窗口下的换行，全部没有被 agent 目视确认**。用户此前提供的展开截图是改动**之前**的版本，**不能当作改动后的证据**。
3. **【未验】「份数 2→3 界面生效」没有真机点击证据。** 现有证据只是单元测试与断言：t2 新增 2 条回归（`test/settings-startup-backup.test.mjs` 的「② 2 → 3 really writes the limit: one POST goes out and the number moves」与「the write route survives every shape the Host reports health in」），断言了「恰好 1 次 POST、body `{maxBackups:3}`、重渲染后 select 值为 3、提示出现」。**真机上点下拉框这一步未验。**
4. **【实测】测试读数。** 本轮在插件根目录跑 `node --test`（DSH 自带 node v24.21.0）：`ℹ tests 1373 / ℹ pass 1373 / ℹ fail 0 / exit 0`。相对上一轮的 1363 条，增量 10 条：t3 的 4 条、t2 的 2 条、t4 的 4 条。
5. **【单测实测 / 真机未验】回退触发的那次重启不写备份。** 证据只有单元测试：在磁盘上前后数目录、`deepEqual` 对比并带防空断言。**真机从未执行过回退**——回退会把现有插件与配置换成备份内容，用户未批准，agent 不擅自做。
6. **【实测】版本与仓库状态。** `package.json` = `"version": "0.8.6"`；`index.js` = `const PLUGIN_VERSION_FALLBACK = '0.8.6'`；`README.md:265` = `Current version: **0.8.6**`；`docs/README.zh.md:415` = `当前版本：**0.8.6**` —— 四处一致。本地 `main` 的 HEAD = `54da5a6`，工作树干净（`git status --porcelain` 输出 0 行）；**相对 `origin/main` 领先 49 个提交**（`git rev-list --count origin/main..main` = **49**，`origin/main` 停在 `ef6a445`）。派单里写的是 48，这一行以 agent 本轮实测的 49 为准——差 1 很可能是数字被记在最后一次提交之前。**尚未推送。**

> **agent 未能展开折叠块，故界面排版证据缺失，需用户目视确认后补记。**
