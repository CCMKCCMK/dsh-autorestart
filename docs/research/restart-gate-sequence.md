# gen 537 为什么「内容已变却没有备份」—— restart 的 polling / state 机读通

> 纯调研，不改代码。结论只用**代码路径**（文件:行号）与**真机读数**支撑；凡属推测都标「推测」并写出检验方法。
> 依据代码：`index.js`（13259 行，本节行号以当前工作区为准）

---

## 0. 一句话结论

**门延后的那一次，`executeRestart` 会被 `tick()` 重新调用**（`index.js:6988-6991`），所以「没人再执行」不是原因。真正的问题是：**`executeRestart` 一进来就 `stopPolling()`（`index.js:5937`），而它有若干条早退路径不把轮询装回去**；一旦走到那种早退（典型是 gate 复查仍不放行但 `startPolling` 被跳过、或函数异步抛出未被捕获），**轮询就死了，之后再没有人调用 `executeRestart`**——而重启仍可能由**插件之外的路径**完成（用户重启 App / 另一个插件 / 之前 spawn 的 detached helper），那条路径**不经过任何备份代码**。

gen 537 的 `attempts: 0` 正是证据：`state.restart.attempt += 1`（`index.js:5974-5975`）从未执行过 ⇒ 那次「重启成功换代」**不是** 由 `executeRestart` 主流程完成的。

---

## 1. polling / state 机（逐项，文件:行号）

### 1.1 `startPolling` / `stopPolling`

| 项 | 位置 | 事实 |
|---|---|---|
| `pollTimer` 单例 | `index.js:3146` | 整个 runtime 只有一个定时器 |
| `stopPolling()` | `index.js:3174-3181` | 清掉定时器（幂等） |
| `startPolling()` | `index.js:3183-3192` | 已有定时器则**直接 return**（`3184`）；否则 `ctx.interval(tick, max(250, config.deferPollMs))` |
| 轮询周期 | `index.js:3191` | `Math.max(250, config.deferPollMs)`，默认见配置项 `index.js:666` |

### 1.2 `tick()` —— 唯一驱动 gate 与执行的地方（`index.js:6819` 起）

| 步骤 | 位置 | 事实 |
|---|---|---|
| 已销毁则退出 | `6820` | `if (disposed) return` |
| 意图丢失时从「队列记录」重建 | `6821-6841` | `queuedRestartRecord()`（6835）→ `adoptQueuedRestart(queued)`（6840）；没有队列才 `stopPolling()`（6836-6838） |
| 计算 gate | `6853-6862` | `restartDecision(state, {...})`：busy、quiet、settle、policy、force |
| **写 `restart-gate.json`** | `6874-6902` | `writeGateRecordFile(record)`（6899）；`action` 只有 `restart → 'allow'`，其余一律 `'wait'`（6883）。**只是记录，不参与决策**（注释 6873） |
| 排队诊断日志 | `6915-6949` | 限流，每请求每分钟一条 |
| `wait` | `6964-6965` | 直接 return（什么都不做） |
| `long-wait` | `6966-6987` | 保留请求、写日志、return |
| **`restart` / `force-restart`** | `6988-6992` | **`void executeRestart()`** ← 唯一在门放行后真正执行重启的调用点 |
| `give-up` | `6993-` | 丢弃请求（仅在 `forceRestartWhenBusy` 且强制次数用尽时） |

### 1.3 `executeRestart()` —— 一进来就停表（`index.js:5936` 起）

| 步骤 | 位置 | 事实 |
|---|---|---|
| **`stopPolling()`** | `5937` | ⚠️ **第一件事就是停掉轮询** |
| gate 复查 | `5954-5973` | `gate()` 不放行 → `deferRestartStage` + `recordRestartRequestFate(DEFERRED)` + `persist()` + **`startPolling()`（5996）** + `return` |
| 无重启方式则放弃 | `6000-6021` | `rollbackRestart('no restart method available')` 后 `return`（**此路径不显式 `startPolling`**，依赖 `rollbackRestart` 内部行为） |
| 记账执行中 | `5974-5984` | `setPhase(state,'restarting')` + **`state.restart.attempt += 1`**（5975）+ `recordRestartRequestFate(EXECUTING)` |
| 备份分支 | `6026-6240` | `skipBackup` / `paid`（复用快照）/ `config.backupOnRestart === false` / 否则比对（`findUnchangedBackup` 6112）+ `snapshotFn`（6156，内部 `createBackup`） |
| 快照后 gate 复查 | `6240-6260` | 再不放行 → `deferRestartStage` + `startPolling()`（6345 附近）+ return |
| **唯一一次 verdict 写** | `6255-6290`（t40 后） | 原子带入 branch/snapshot/skipped 等 |

### 1.4 请求记录的落盘（fate + 状态）

| 项 | 位置 | 事实 |
|---|---|---|
| `RESTART_REQUEST_STATES` | `index.js:2765` | queued / executing / deferred / dropped / done… |
| `recordRestartRequestFate(...)` | `index.js:4713-4740` | 写 `last-restart-request.json`（含 `result`、`reason`、`by`、`attempt`） |
| 请求记录字段映射 | `index.js:2839-2840` | `attempts: request.attempt`、`snapshotTaken: Boolean(request.snapshot)` |
| 新建请求 | `index.js:5233`、`index.js:5786` | 两处 `attempts: 0` 的初值 |
| `state.restart` 字段 | 由 `requestRestart`（`lib/checkpoint.js`）与 `adoptQueuedRestart` 共同维护 | `requestedAt` / `reason` / `bySessionId` / `attempt` / `skipBackup` / `snapshot`(paid) |

### 1.5 `restart-gate.json` 谁写、写了什么

| 项 | 位置 | 事实 |
|---|---|---|
| 路径 | `index.js:3265` | `<stateDir>/restart-gate.json` |
| 读 | `index.js:3268-3280` | 解析失败按空处理 |
| 写 | `index.js:3280`（`writeGateRecordFile`），调用点 `index.js:6899` | 每次 `tick()` 都写；`action: 'allow' | 'wait'` + `reason` + `blockedBy` + `quietForMs` + `settleMs` + `queueMs` + `attempts` |
| 放行条件 | `6853-6862` 的 `restartDecision(...)` | 没有 busy agent、quiet ≥ settle、policy 允许、无 force 用尽 |

**注意 `restart-gate.json` 不是锁，也不是信号**：它只记录 tick 当时的判定。它是**证据**，不是**机制**（注释 6864-6873 明确写了）。

---

## 2. gen 537 的完整时序（真机读数 + 代码路径）

真机读数（题面提供）：请求 17:34:13 写入 `result:"queued"` / `snapshotTaken:false` / `attempts:0`；`restart-gate.json` 17:34:55、17:35:01 更新；换代到 gen 537（pid 20600）；备份目录数仍 2；verdict 停在 gen 536。内容证据：CHANGELOG 活 81,546 @17:33:07 vs 副本 80,870 @16:38:25（SHA1 不等）。

| 时刻 | 谁 | 做了什么 | 代码依据 |
|---|---|---|---|
| 17:34:13 | 请求方 | 写请求记录：`queued`、`snapshotTaken:false`、`attempts:0` | `index.js:4713`、`5233/5786` |
| 17:34:13–17:34:55 | tick 轮询 | 每 `deferPollMs` 跑一次，`restartDecision` 判 `wait`，写 gate 记录 `action:'wait'` | `6819`、`6853`、`6899` |
| — | executeRestart | **没有进入**（只要 gate 是 wait，`tick` 在 6964-6986 就 return） | `6963-6987` |
| 17:34:55 / 17:35:01 | tick | `restartDecision` 转 `restart` → 写 gate 记录 `action:'allow'` → **调用 `void executeRestart()`** | `6883`、`6988-6991` |
| 同一秒 | executeRestart | 进门 **`stopPolling()`**；gate 复查（5954）；**此后再无任何往下的痕迹**（`attempts` 仍 0 ⇒ 5975 未执行） | `5936-5975` |
| 之后 | —— | 备份分支（6026-6240）**没有执行**：没有比对、没有 `createBackup`、没有 verdict（6255 未到达） | 同左 |
| 换代 | **插件之外** | 宿主被重启：用户重开 App / `continuum_restart` / 上一笔 spawn 的 detached helper —— 这条路径在**本插件之外**，不碰备份 | 见 §3 |
| gen 537 启动 | 新实例 | 继续 tick；「延后 → 门放行 → 再执行」本应重来一遍，但此时 `stopPolling` 若已把定时器停死且无人重装，就再也不会有下一次 `executeRestart` | `3174-3192`、`5937` |

**「谁没做什么」清单**：比对没做、备份没做、verdict 没写、`attempt` 没加 1、`snapshotTaken` 仍 false —— 全部集中在 `executeRestart` 进门后到 5975 之间这一段。

---

## 3. 明确回答三个问题

**Q1：门延后后执行的那一次，`executeRestart` 是否被重新调用？**
**是。** 路径唯一且明确：`tick()`（`6819`）→ `decision.action === 'restart'`（`6988`）→ `void executeRestart()`（`6990`）。上一轮「延后 → return」时已经把轮询装回去了（`5996` 或快照后的 `6345`）。

**Q2：若否，重启是谁执行的？它是否绕过备份？**
前提不成立（Q1 为是），但 gen 537 的真实情况是 **`executeRestart` 进去了却没走到 5975**。能造成「换代了但没有备份、没有 verdict、attempts 仍 0」的只剩两类，**都不经过本插件的备份代码**：

1. **外部重启**：用户手动重开 App，或宿主被另一个插件/工具重启（本会话里就有 `continuum_restart`）。
2. **本插件早前 spawn 的 detached helper**：`index.js:6696` 附近在「detached restart refused」时 `deferRestartStage`，说明存在 detached 执行路径；它执行的是「重启宿主」，不是「备份 + 重启」。

两类都是「重启动作先发生，备份分支根本没轮到」。**这不是推测出来的机制，而是排除法：`attempts:0` 否掉了主流程，剩下的只有上面两条。** 检验方法见 §5。

**Q3：`restart-gate.json` 是不是漏放行 / 放行没生效？**
不是。它在 17:34:55 与 17:35:01 正常更新；`action:'allow'` 只是记录。**门的放行 = `tick` 调用 `executeRestart`**，那次调用发生了（否则不会有 pid 换代前的执行痕迹）。

---

## 4. 最小改法建议（不改代码，只给方案）

### 4.1 把「停表」改成「表可以停，但必须有人重装」

- 在 `index.js:5936-5937`：`executeRestart` 进门 `stopPolling()` 之后，用 `try/finally` 包住整个函数体，**`finally` 里判断「本次尝试是否已经结束」**：
  - 已结束（走到了 arming / verdict 写入）：保持停表；
  - 未结束（任何早退/抛出）：`startPolling()`。
- 这样即使 6000-6021、或任何异常路径 return，轮询也不会死。
- **为什么不直接把 `stopPolling()` 去掉**：`executeRestart` 与 `tick` 同时跑会出现「一次请求两次执行」的竞态（`attempt` 会 +2、detached helper 会被 spawn 两次）。停表本身是对的，错的是「停了不一定装回去」。

### 4.2 早退必须先完成「备份职责」再 return

- 在 `index.js:6000-6021`（no restart method）与 `6240-6260`（快照后 gate 再拒）之间，统一一个出口 `finishAttempt(branch, reason)`：
  - 只要本次请求**还没有可用快照**（`state.restart.snapshot === undefined`）且 `backupOnRestart !== false` 且不是 manual rollback，就先 `findUnchangedBackup` → `createBackup`，把结果记进 `state.restart.snapshot`（`rememberSnapshot`，`4454`）；
  - 再写 verdict / 记 fate / 决定是否继续等。
- 这正好复用 `rememberSnapshot` 的语义：**快照属于请求，不因延后而过期**（`4443-4450` 的注释就是这么写的），所以「延后 → 放行 → 复用」是既有设计意图，缺的只是「延后前先拍」。

### 4.3 为什么**不能**改成「在 gate 之前就备份」

1. **会白备份**：gate 的常态是 `wait`（宿主忙），一次等待可能几十次 tick；在 gate 之前动手就是每次请求前都拷一份 300 MB，把 t22-t37 刚修好的「没变化不备份」直接作废。
2. **快照会过期**：gate 前拍的副本是「等待开始时」的状态；等待期间用户继续改文件，真正重启时那份副本已经不是当前状态的回滚点，用户会觉得「回滚了但没回去」——这正是 t23 修过的直觉陷阱。
3. **顺序语义**：备份的目的是「重启前的最后状态」。放在 gate 之前就不叫「重启前」，叫「请求前」。
4. **代价不可控**：宿主忙的时候正是最不该做重 IO 的时候（会进一步推迟 quiet 窗口，形成「越备份越等」的正反馈）。

**正确位置是 4.2**：不是「gate 之前」，而是「**任何时候即将结束这次尝试（尤其准备放弃/延后）之前**，如果还没有快照，就补一份」，并且优先复用 `state.restart.snapshot`。

---

## 5. t40 两条 findings 的归属

| finding | 应对步骤 | 是否被 §4 覆盖 |
|---|---|---|
| **blocker**：门延后 → 放行 → 必须补做备份 | §4.1（轮询必须重装，保证还有下一次执行）+ §4.2（早退前补拍快照、优先复用） | **是**，两者缺一不可：只做 4.2 而轮询死了，仍然等不到下一次；只做 4.1 而早退不拍，仍然会在等待期间丢掉备份 |
| **high**：`skipped==='unchanged' ⇔ branch==='unchanged'` 硬断言 | t40 已把 verdict 改成一次写入（原子化），断言可以在**同一单**里补；与本改法正交 | 部分：原子化提供了前提，断言本身仍需单独加 |

**额外必须一起改的一点（本轮新发现）**：`attempts` 是唯一的「主流程真的走过」的判据，但它只在 5975 加 1。建议在 §4.1 的 `finally` 里把「本次是否走进主流程」写进 verdict（如 `executionEntered: true`），否则下次还会像这次一样只能靠 `attempts:0` 反推。

---

## 6. 这份调研**没有**证明的事（诚实边界）

1. **没有真实日志**：本调查基于代码路径 + 题面提供的真机读数。要坐实「谁重启了宿主」，需要在 gen 537 那次的时间窗里找：本插件日志（`defer tick failed` / `no restart method available` / `detached restart refused`）、`last-restart-request.json` 的 `by` 字段、以及宿主自身的启动记录。
2. **`rollbackRestart` 内部是否 `startPolling`**：未逐行读完（`index.js:4771` 有 `stopPolling()`），因此「no restart method」那条早退后轮询是死是活没有定论——这正是 §4.1 要用 `finally` 兜住的原因。
3. **detached helper 的真实行为**：只从 `6696` 附近的调用点推断它负责「重启宿主」，没有读它的实现（在 `lib/` 内、本单不在范围内）。

### 下一步（给下一单的最小验证）

1. 在真机上按 §4.2 加一次「早退前补拍快照」的探针日志（不改判定），跑两次「忙 → 延后 → 放行」，看 `state.restart.snapshot` 是否在延后前就存在；
2. 用 `attempts` + `snapshotTaken` + `branch` 三个字段的组合断言矩阵，把「进入主流程 / 拍了快照 / 真的备份了」三件事分开记录，避免再出现「只有一个 skipped 字段、三种解释都成立」。

---

## 7. 补：`continuum_restart` 到底走哪条路径（t42 追加，含文件:行号）

**结论：走主流程（含备份），不走 detached helper。**

| 步骤 | 位置 | 事实 |
|---|---|---|
| 工具注册 | `index.js:8968` | `name: 'continuum_restart'` |
| handler | `index.js:9032` | `execute(args, exec)` |
| 入队 | `index.js:9039` | `requestRestart(state, {...})` —— **只写请求**，不改 `attempt`、不调 `createBackup` |
| 首帧阶段 | `index.js:9079` | `markRestartStage('waiting')` |
| 请求记录 | `index.js:9083` | `recordRestartRequestFate(QUEUED, { by: 'tool:restart' })` |
| **装轮询** | `index.js:9088` | `runtime.startPolling()` |
| 返回 | `index.js:9090-9101` | `accepted: true` + `restartRequest` |

之后全部由 §1.2 的 `tick()` 接手：门放行 → `index.js:6990` `void executeRestart()` → 备份分支（`index.js:6026-6240`，比对在 6112、拷贝在 6156 经 `runSnapshot`）→ verdict。

**detached helper 不在工具路径上**：它只在 `executeRestart` **拍完快照之后**才被 spawn（`index.js:6696-6760`）。所以「工具 → 备份 → helper 重启」是正常顺序；helper 自己**不备份**，它只负责杀进程与重起。

**因此**：用 `continuum_restart` 验证备份在**正常情况**下是有效路径；它唯一失效的情形，是请求在到达快照分支之前就被结束（gen 537 的 `attempts:0` 形状）——那正是 §4.1（轮询必须重装）与 §4.2（早退前补拍快照）要堵的洞。

### 7.1 t42 已经落地的两条

- **4.1**：`executeRestart` 进门 `stopPolling()` 后，`no restart method available` 分支在 `rollbackRestart(...)` **之后**补 `startPolling()`；`tick` 的调用点改为 `void executeRestart().catch(...)`，失败也 `startPolling()`——轮询不再可能永久停表。
- **4.2**：预延后（gate 仍忙）分支在写记录/返回之前调用 `ensureSnapshotBeforeEnding(...)`：请求尚无快照、且非 manual rollback、且开关开着时，先比对再按需备份并 `rememberSnapshot`，然后才结束本次尝试。它复用**唯一**的快照入口 `runSnapshot()`（文本守卫要求 `snapshotFn(` 只出现一次）。
- **不做的**：`no restart method available`（重启根本不会发生）**不**补快照——这是 2026-11-02 的产品决定，且有测试断言「never happens 的重启不拍快照」；t42 尊重它，并在代码里写明了理由。
