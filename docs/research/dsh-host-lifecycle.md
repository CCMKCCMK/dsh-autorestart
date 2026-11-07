# DSH 本体怎么处理启动 / 关闭 / 重启？有没有日志？有没有备份？

> 纯调研，无代码改动。方法：直读安装目录 + 解 asar（自己解析 asar header，未用 `npx asar`）+ 读 `~/.dsh` 真实数据。
> 查不到的地方明确写「查不到」并列出试过的方法。

---

## 1. 安装结构：哪一份才是「真身」

| 位置 | 是什么 |
|---|---|
| `…\DeepSeek Harness\resources\app.asar`（213,202,918 字节，单文件，22,102 个条目） | Electron 外壳 + 依赖。`/dsh/package.json` = **`@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1`** |
| `app.asar` 内 `/dsh/node_modules/@deepseek-ai/dsh/package.json` | **宿主真身：`@deepseek-ai/dsh@0.2.2-rc.1`**（本项目 7 个 JS 文件，含 `lib/profile-boot*.js`） |
| `resources\app.asar.unpacked\dsh\node_modules\` | 只放原生模块（node-pty、koffi、sherpa-onnx…），不含业务代码 |
| `resources\runtime\` | `bin` / `cli` / `office-skills` / `primary-runtime`；`primary-runtime\dependencies\` 只有 **node / pnpm / python** 与 `versions.json`（node 24.21.0、pnpm 11.28.5） |
| `~/.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\` | 同上（运行期缓存） |

→ 排错时要读的业务代码**只在 app.asar 里**；磁盘上没有可 grep 的 dsh 源码树。

## 2. 关闭 / 重启：代码位置与关键逻辑

真身在 `app.asar` 的 `/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-<hash>.js`（同目录还有未哈希的 `profile-boot.js`）。关闭相关原文（行号为该文件行号）：

```js
270:  if (failures.length > 1) throw new AggregateError(failures, "dsh: profile cleanup failed");
275:  const shutdown = createProcessShutdown(dispose);
276:  const signalShutdown = new AbortController();
277:  const interrupt = (code) => {
278:    signalShutdown.abort();
279:    shutdown.interrupt(code);
280:  };
281:  process.on("SIGTERM", () => {
282:    interrupt(0);
283:  });
284:  process.on("SIGINT", () => {
285:    interrupt(130);
286:  });
287:  installFailLoud(NAME, process, async () => {
288:    await app.current?.fiber.dispose();
289:  });
```

**能确认的事实**：

- 收到 `SIGTERM` / `SIGINT` → 先 `signalShutdown.abort()`（打断正在进行的异步），再 `shutdown.interrupt(code)`（**退出码 0 / 130** 有明确约定）。
- 关闭动作叫 **`dispose`**，并且有一道「profile cleanup」：清理失败的聚合错误会抛 `dsh: profile cleanup failed`（270）。也就是**插件树被 dispose、profile 级清理会执行**。
- `installFailLoud(...)` 在致命错误时也会 `fiber.dispose()`（287-289）——**崩溃路径与正常关闭路径共用同一套 dispose**。

**有没有「等 agent 空闲」？没有。** 关闭路径里没有任何「等待会话/turn 结束」的逻辑；空闲门（`restart-gate`）是**我们插件**加的。
**有没有「重启前备份」？没有。** 关闭路径上没有任何备份调用；`~/.dsh/backups` 里没有以重启/关闭命名的产物（见 §4）。
**有没有「重启编排」（relaunch）？** 在 dsh 本体里没找到 relaunch/spawn 宿主自身的代码；重起 app 的是桌面外壳（`dsh-desktop-runtime`）或**我们插件的 detached helper**。

> 诚实边界：`createProcessShutdown` 的实现体（在别的 chunk 里，文件名不含 host/boot 关键词）**没有逐行读到**，因此「它内部还有没有别的副作用（写日志、落状态）」**查不到**。已试：解析 asar header 遍历 22,102 条目，按 `host|main|boot|lifecycle|signal|proc|entry|serve` 过滤到 2 个候选并逐个搜 `SIGTERM|SIGINT|process.on`，仅 `profile-boot*` 命中。

## 3. 日志：落在哪、什么格式、能不能区分重启来源

**位置**：`~/.dsh/logs/startup-<ISO 时刻>-<uuid>.log`。当前只有两份：

| 文件 | 大小 | 时间 |
|---|---|---|
| `startup-2026-10-31T15-31-25.365Z-d672d149-….log` | 17,292 | 2026-10-31 23:31 |
| `startup-2026-10-31T15-33-37.501Z-e07a9932-….log` | 8,072 | 2026-10-31 23:33 |

**真实样本（逐字）**：

```
WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.

{
  timestamp: '2026-10-31T15:31:25.365Z',
  dshVersion: '0.2.1-rc.3',
```
```
  platform: 'win32',
  arch: 'x64',
  profile: 'web',
  error: StartupError: dsh: startup failed: 2 required plugins did not activate
```
```
                at file:///C:/Users/Administrator/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/hmr/lib/index.js:751:29 {
              [stack]: [Getter/Setter],
              [message]: 'HMR is disposed'
```

**能确认的事实**：

- 这两份都是 **startup failed（启动失败）诊断**，不是常规运行日志；文件名前缀 `startup-`、首行是「原始诊断可能含凭据，分享前审阅」的警告。
- 格式是 **Node `util.inspect` 风格的对象 dump**（单引号、无 JSON 引号、`[Getter/Setter]`、`[length]: 4` 这类内部槽），**不是 JSON、不是行分隔、无法当结构化日志解析**，只能人工阅读或用宽松正则抓字段。
- 其中一份写着 `dshVersion: '0.2.1-rc.3'`、`profile: 'web'` —— 说明这套日志机制在 **hosted(web) profile** 启动失败时触发。

**能不能用它区分「插件触发的重启」与「外部重启」？不能。**
理由（都是事实，不是推测）：① 目录里**只有启动失败**的日志，没有「一次正常启动/关闭」的记录样本；② 关闭路径（§2）**不写日志**（没找到任何写日志调用）；③ 文件名与内容都不含「谁发起的」。所以**正常重启在 dsh 本体日志里没有痕迹**。

**替代证据（能区分，而且现成）**：我们插件自己写的三份记录——`last-restart-request.json`（`by: 'tool:restart'` 或 `idle-gate`/`busy-watch`）、`restart-gate.json`（每次 tick 的 `action/reason`）、`last-restart-verdict.json`（`attempts` / `executionEntered` / `branch`）。**判据**：宿主换代但 `attempts` 不增长、`executionEntered` 不为 true ⇒ **不是主流程做的**（外部重启或 detached helper 独立完成）。gen 537 的 `attempts:0` 正落在这条判据上。

## 4. `~/.dsh/backups` 与 `_session-identity-backup` 是谁写的

`~/.dsh/backups`（顶层只有两项，很干净）：

| 目录 | 时间 | 内容 |
|---|---|---|
| `agent-teams-profile-copy` | 2026-11-04 22:11 | 1 项 |
| `orchestrator-20261019-191333` | 2026-10-19 19:13 | 3 项 |

`~/.dsh/_session-identity-backup`：

| 文件 | 大小 | 时间 |
|---|---|---|
| `session-a92ba31e-….session.v4.jsonl.zstd.orig` | 227,349 | 2026-10-31 22:35 |
| `session-c7199892-….session.v4.jsonl.zstd.orig` | 357,855 | 2026-10-31 15:10 |

**写入者：查不到。** 两侧命名都不像 dsh 本体（dsh 自己的目录风格是 `logs/`、`sessions/`、`storages/`），更像某个插件的功能（`agent-teams-profile-copy` 显然是 AgentTeams 相关；`orchestrator-…` 像编排器快照；`.orig` 后缀像「改会话文件前先留原文件」的修复流程）。已试：① 在 app.asar 里按文件名关键词找写入者——**没有命中**（这些名字不在 dsh 包里）；② 扫 `~/.dsh/profiles/*/node_modules` 下的插件——本轮未完成（时间用在了 asar 解析上）。

**保留多久：查不到**（没有元数据、没有 manifest、没有清理记录）。从 mtime 看至少自 10-19 / 11-04 起未被清理。
**存什么**：`orchestrator-*` 与 `agent-teams-profile-copy` 是**目录级副本**（profile 快照风格）；`_session-identity-backup` 存的是**单个会话工件 `.jsonl.zstd` 的原始副本**（`.orig`），不是目录。

**关键事实（对我们最有用的一条）**：`~/.dsh/backups` 里**没有我们插件写的东西** —— 我们的备份全在 `<stateDir>/backups/`（`dsh-autorestart` 自己的状态目录）里，**两边互不相干、互不清理**。

## 5. 结论

### ① 我们的插件是否在重复 DSH 已有的能力？

**不是。** dsh 本体提供的是「**优雅关闭**」：`SIGTERM/SIGINT → abort + createProcessShutdown(dispose) + profile cleanup`，退出码 0/130 有明确语义，崩溃路径复用同一 dispose。它**不提供**：

- 空闲门（等所有会话/turn 结束再动手）——没有；
- 重启前备份 / 回滚点——没有；
- 重启编排（relaunch 宿主、断线后恢复会话）——没有（重起是外壳或我们的 helper 干的）；
- 重启过程的**可观测记录**——没有（本体日志只在启动失败时写）。

这四件事正是 `dsh-autorestart` 在做的，**属于互补**。

### ② 互补边界

| 层面 | 谁负责 |
|---|---|
| 信号语义、插件树 dispose、profile cleanup、退出码 | **dsh 本体**（我们不该重写，也不该绕过） |
| 何时可以重启（空闲门）、备份与回滚、helper 重起、会话续接、重启记录 | **dsh-autorestart** |

我们的 helper 是「**在 dsh 正常关闭路径之外**再把它拉起来」的那一环；它能成立，正是因为 dsh 本体**不做 relaunch**。反过来说：如果哪天 dsh 本体加了 relaunch，我们这层就该退化成「只做门 + 备份」。

### ③ 值得借鉴的三点

1. **`interrupt(code)` 的显式退出码**：`SIGTERM→0`、`SIGINT→130`。我们的 helper 杀进程后**应当记录「用什么信号、期望什么退出码」**，事后才能区分「被我们杀的」与「自己崩的」。
2. **`installFailLoud(NAME, process, …)`**：崩溃/未捕获错误统一走同一条清理路径并**大声说出来**。我们插件的 try/catch 多处是「吞掉继续」，值得改成「清理 + 明确记录」（t42 的 `.catch(...)` 已是这个方向）。
3. **`signalShutdown.abort()` 先打断再清理**：先中止进行中的异步，再 dispose。我们的 gate/轮询在重启前也应先「打断进行中的 tick」再动手，而不是并发跑。

**不建议照搬**：`~/.dsh/backups` 那套目录命名（三套并存、owner 不明、保留策略不明），我们自己的 `<stateDir>/backups/` + 认证位 + prune 更清楚。

## 6. 对 gen 537 悬案的判定方法（可直接用）

1. 读 `last-restart-request.json`：看 `result`、`by`、`attempts`、`snapshotTaken`；
2. 读 `last-restart-verdict.json`：看 `generation`、`attempts`、`executionEntered`、`branch`；
3. 读 `restart-gate.json`：看换代前后最后一次 `action`（`allow` 还是 `wait`）与 `queueMs`；
4. **判据**：换代了但 `verdict.generation` 不是换代那一代 / `executionEntered !== true` / `attempts` 不增长 ⇒ **不是主流程**；此时再看 `~/.dsh/logs` 有无 `startup-*.log`（有 = 那次启动失败过，属于外壳/用户操作），没有则说明是一次正常启动 —— 即**外部重启**。
5. 兜底：Windows 事件日志（`Application` 里 Application Error / 进程创建）与 `dsh-desktop-runtime` 自身的日志（**本轮未查**，属未验证手段）。
