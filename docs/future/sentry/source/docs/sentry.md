# 守夜人（sentry）：DSH 彻底起不来时，谁来救它

> ⚠️ **当前版本（0.8.6）里它是一份「未接线」的备用件 —— 不要以为它在替你看门。**
>
> - 它救的是**看门狗覆盖不到的那个窗口**：不是"我们主动重启"的时候，而是 0 个进程、profile 被官方 `sanitizeProfile` 清空、连插件自己被摘掉的那种死局。看门狗只管重启窗口，这个窗口没人管 —— 这就是它存在的理由。
> - **但它现在没有被接进主线**：不注册任何工具（没有 `continuum_sentry` 之类的入口）、不会自动安装自己（没有确认卡片、没有安装流程）、也没有任何 clean-exit 钩子（没人写 `clean-exit.json`，所以"用户主动关掉不弹回来"这条在真机上**还没有接线**，只有单测）。
> - 三个文件（`lib/sentry.js` / `lib/sentry-install.js` / `supervisor/sentry.js`）只是**放在仓库里**，由 `test/sentry*.test.mjs` 覆盖，不参与插件的任何流程。
> - 要真的用它，得**另开任务**做接线（工具入口 / 安装卡片 / clean-exit 标记 / 真机验收）。
>
> 换句话说：**这一页讲的是"将来会有的兜底"，不是"现在有的兜底"。**

> 一句话：**它在 DSH 外面活着。** DSH 变成 0 个进程、设置被官方清理成空壳、连这个插件自己被摘掉，它都还在，并且会把 DSH 拉回来。

---

## 1. 它是干什么的

2026-10-30 那次死局长这样：

- `DeepSeek Harness.exe` **0 个进程**；
- 官方 `sanitizeProfile` 把 profile 清成了空壳：`dsh.profile.bundles` 没了，`cordis.patch.yml` 只剩 `[]`；
- 插件本身跟着 profile 一起被摘掉 —— 于是"插件自带的看门狗 / supervisor / 恢复流程"**全部同时消失**。

插件里所有的保险都在**宿主进程里**或**profile 里**，所以那次它们一起没了。守夜人是补上的那一级：

| 它在哪 | 谁启动它 | profile 被清掉时还在吗 | 宿主 0 进程时还在吗 |
|---|---|---|---|
| 插件（index.js） | 宿主加载 | ❌ 跟着 profile 没了 | ❌ 进程没了 |
| `supervisor/supervisor.js` | 宿主自己 spawn | ✅ 在 `%USERPROFILE%\.dsh\storages\dsh-autorestart\` | ❌ 它是宿主的子进程，跟着一起死 |
| **`supervisor/sentry.js`（守夜人）** | **Windows 登录任务（与 DSH 无关）** | ✅ 同上，在 profile 之外 | ✅ 它不依赖宿主 |

它每一轮（默认 30 秒）做一件事：`tasklist` 数一下客户端进程。

- **有进程** → 记下"最后一次见它还活着"的时间，清空这一轮的抢救计数，继续睡。
- **没进程** → 记下"从什么时候开始没的"，然后按一套固定顺序判断该不该动手（见第 3 节）。

---

## 2. 什么时候它会救你（以及救的时候按什么顺序动手）

同时满足这几条才会真的动手：

1. 客户端进程数 = 0（**读不到进程表时不算 0**，它会继续等 —— 见第 6 节）；
2. 已经"没有进程"超过 `graceMs`（默认 90 秒）；
3. 不是你自己关的（见第 4 节）；
4. 没有一次重启正在进行（插件自己在重启时不抢）；
5. 最近一小时内的抢救次数还没到上限（默认 3 次）；
6. 这一轮宕机里的启动次数还没到上限（默认 3 次）。

动手时顺序是**写死的**，顺序本身也是有意义的：

| 步骤 | 做什么 | 为什么必须是这个顺序 |
|---|---|---|
| ① 清通行证 | 跑 `kit/clear-dsh-auth-cookies.mjs`，只删 `127.0.0.1` 上的 `dsh-auth-*` cookie | 71 个旧 cookie 就会让宿主的 Cookie 头超过 16 KB，返回 431，客户端报"Web authentication failed"然后死循环 —— 不清就等于白拉 |
| ② 体检 + 还原 | 读 profile 的 `package.json` 和最新备份；**只有像空壳才还原**（`kit/restore-profile.ps1`） | 还原会把当前 profile 挪走，对好配置做还原比不救更糟 |
| ③ 拉起 | `spawn(appExecPath, [], { detached: true, stdio: 'ignore' })` | 必须在前面两步之后：带着坏 cookie / 空配置拉起来只会再死一次 |
| ④ 等它活 | 在 `startTimeoutMs`（默认 90 秒）内轮询"进程在 + 健康路由 `ok:true`" | "我 spawn 了"≠"它起来了"；结论要写进报告 |

每一轮和每个动作都写 `<stateDir>/sentry/sentry.log`；每次救护写 `<stateDir>/sentry/last-rescue.json`，字段固定为
`at / action / reason / cleared / restored / launched / ready / errors / durationMs`（**以后不许改名**，改了就没人能读旧报告）。

---

## 3. 判定顺序（照抄代码里的顺序，顺序不能换）

```
1. 进程数 > 0                                  -> idle（顺便刷新"最后见它活着"）
2. 不知道从什么时候开始没的                     -> wait（先记时间）
3. 还没超过 graceMs                            -> wait
4. 有 clean-exit 标记且不早于"最后见它活着"-5s   -> stand-down-intentional（你关的，绝不拉）
5. 有重启正在进行                              -> stand-down-restart-in-flight
6. 最近一小时抢救次数 >= 上限                   -> stand-down-budget
7. 本轮宕机已启动次数 >= 上限                   -> give-up
8. 其它                                        -> rescue
```

`lib/sentry.js` 里的 `decideRescue` 是**被单测覆盖的那一份**；`supervisor/sentry.js` 里有一份逐字重复的实现（它不能 import 插件，见第 7 节），`test/sentry-install.test.mjs` 用同一张用例表比对两份的结论，防止它们走偏。

---

## 4. 为什么它不会在你主动关掉 DSH 时烦你

插件在**被你要求退出**的时候写一个标记：`<stateDir>/sentry/clean-exit.json`（`{ at, atIso, reason, by }`）。

守夜人判定第 4 条：这个标记的时间**不早于**"它最后一次看见客户端活着"减 5 秒，就 `stand-down-intentional` —— **什么都不做**，只在日志里写一行。

- 5 秒的容差是必要的：标记是**关机过程中**写的，时间点一定早于"最后一次看见它活着"，不会晚于。
- 一个**很旧的** clean-exit 标记保护不了之后的崩溃：只要后来客户端又活过（"最后见它活着"被刷新），旧标记就自动失效，那之后的 0 进程仍然会被当成崩溃救回来。

> 这条是本次的硬口径：**用户主动关掉的不许弹回来。**

---

## 5. 怎么关掉它 / 怎么装它

### 装

装是插件侧的事（需要你点确认卡片），落盘顺序：**先拷 kit → 再写配置 → 再注册登录任务 → 再回读确认**：

- 注册：`schtasks /Create /TN dsh-autorestart-sentry /TR "<真 node> \"<stateDir>\sentry\sentry.js\" --config \"<stateDir>\sentry\sentry.json\"" /SC ONLOGON /RL LIMITED /F`
- 注册完**必须回读**（`/Query /TN ... /FO LIST`）才算成功。
- 任务被系统拒绝（普通用户没有建任务的权限）→ 降级写启动文件夹里的 `dsh-autorestart-sentry.cmd`（纯 ASCII + CRLF，`start ""` 起，不留窗口）。
- 解释器必须是**真 node**（复用 `resolveSupervisorNode`）：`process.execPath` 在桌面版里是 `DeepSeek Harness.exe`（Electron 客户端），拿它当解释器会在每次登录**再开一整个客户端**。找不到真 node 就**拒绝安装并说明原因**，绝不拿客户端顶替。
- `confirmed !== true` 或 `dryRun: true` → **只给计划，一个文件都不写、一条命令都不跑**。

### 卸

`uninstallSentry` 的顺序：停进程（读锁里的 pid）→ `schtasks /Delete /TN ... /F` → 删启动文件夹的 `.cmd` → 删 `<stateDir>/sentry`。**幂等**：没装过也算成功。中途失败会把没做完的项写进 `<stateDir>/sentry-pending-cleanup.json`（带手工收尾命令），不会静默丢。

紧急情况也可以纯手工：删计划任务 `dsh-autorestart-sentry` + 删目录 `%USERPROFILE%\.dsh\storages\dsh-autorestart\sentry`，两件事做完它就不存在了。

### 看状态

`node "<stateDir>\sentry\sentry.js" --config "<stateDir>\sentry\sentry.json" --status`（打印状态 JSON 后退出，永远 exit 0）。
`--once` 只跑一轮判定并把结论打到 stdout（演练用，同样永远 exit 0）。

---

## 6. 它救不了什么

诚实地写清楚，免得你以为有了它就万事大吉：

1. **它不修 DSH 本身的 bug。** 如果宿主每次启动都因为同一个原因立刻死，它最多拉 3 次（`maxAttempts`），然后 `give-up` 并写报告 —— 剩下的要人看日志。
2. **读不到进程表时它不会动手。** `tasklist` 失败 → "未知"不等于"0 个"，它宁可不救，也不肯在已有一个客户端时再开一个（两个客户端抢同一个端口，比不救更糟）。
3. **备份没了就还原不了。** `restore-profile.ps1` 依赖 `<stateDir>/backups/` 里的快照；快照被删光时它会在报告里写"未还原 + 原因"，然后照样尝试拉起（cookie 还是会清）。
4. **它只管 Windows 桌面客户端。** 非 win32 平台 `planSentryInstall` 直接返回 `unsupported-platform` —— 它靠 `tasklist` + 登录任务，这两样在 Linux/macOS 上没有对应物。
5. **它不碰 profile 的其它东西。** 除了"按需还原"那一步，它不写 profile；除了 `dsh-auth-*` cookie，它不碰任何浏览器数据，也**从不 `taskkill`**。
6. **登录之前它不存在。** 任务是 `ONLOGON`：机器刚开机、用户还没登录的那段，没有任何东西在看着。

---

## 7. 目录与文件（全在 profile 之外）

```
%USERPROFILE%\.dsh\storages\dsh-autorestart\
  sentry\
    sentry.js                        # 守夜人本体（零依赖，只 import node: 内建）
    sentry.json                      # 配置：路径、时长、次数上限
    sentry.lock                      # 单实例锁（含 pid，死锁自动接管）
    sentry.log                       # 每轮 + 每个动作（>1MB 自动轮转）
    last-rescue.json                 # 上一次救护的报告（字段固定）
    clean-exit.json                  # 你主动关掉时插件留下的标记（守夜人只读）
    sentry-state.json                # 计数器：downSince / 本轮次数 / 一小时窗口
    dsh-autorestart-sentry.cmd       # 降级用的启动文件夹 .cmd 副本
    kit\
      sentry.js                      # 拷进来的本体（自包含，插件被摘掉也能跑）
      clear-dsh-auth-cookies.mjs     # 只删 dsh-auth-* cookie
      restore-profile.ps1            # 按需还原最近一次好状态
      rescue-strings.zh.json         # 上面那个脚本读的中文文案
  sentry-pending-cleanup.json        # 装/卸没做完时的清单（在 sentry 目录之外）
```

`sentry.js` **只用 `node:` 内建模块**（`fs` / `path` / `http` / `child_process`）。原因很直接：它运行的位置是 `<stateDir>/sentry/sentry.js`，插件目录和 profile 随时可能被清掉；`test/sentry-install.test.mjs` 会**读源码文本**断言"没有任何插件内 import"，这条断了测试就红。

---

## 8. 哪些是实测的，哪些还没在真机上验过

**已实测（本机测试跑出来的，不是推理）：**

- 判定逻辑：`decideRescue` 的 8 个分支、判定顺序（clean-exit 优先于预算、grace 优先于 clean-exit、in-flight 优先于预算）都有单测。
- `tasklist` 输出的解析：正常多进程 / `INFO: No tasks are running…`（当 0）/ 空输入 / 表头行 / 同一个 pid 重复 / 单元格里的逗号。
- 空壳判定：好配置 / `bundles` 被砍空 / `package.json` 不可解析 / `patch` 只剩 `[]` / 备份也空时不算空壳。
- 安装器：命令行构造（真 node + `<stateDir>\sentry\sentry.js` 绝对路径 + `--config` + `/SC ONLOGON`）、不含 `DeepSeek Harness.exe` 当解释器、非 Windows 拒绝、找不到 node 拒绝、任务被拒 → 启动文件夹降级、`confirmed != true` / `dryRun` 时**零命令、零文件**。
- 卸载：dry run 不改磁盘；没装过也算成功；真装过的目录、锁、任务都被清掉。
- 状态：没装 / 装好两种情况都能读出结论，读不到就如实说读不到，不抛异常。
- `sentry.js` 纯 ASCII、无 BOM；启动文件夹 `.cmd` 纯 ASCII + CRLF + `detach`。
- 守护进程与库的判定函数在同一张用例表上结论一致。

**还没在真机上验证（发版前必须补，见工作区规则第 7 条）：**

- ⚠️ **真杀一次 DSH，守夜人自己把它拉回来** —— 端到端没跑过。测试只证明"逻辑会动作"，证明不了"真宿主会按约定配合"。
- ⚠️ **真注册计划任务**（`schtasks /Create` 真跑）以及**任务被系统拒绝时**启动文件夹那条降级路径在真机上是否真的生效 —— 测试里 `schtasks` 全是注入的假执行器。
- ⚠️ **用户主动关掉时真的不弹回来** —— 需要真实启动一次 `clean-exit.json` 写入链路（由插件侧负责写）再真关一次客户端。
- ⚠️ **`restore-profile.ps1` 在真机上被守夜人调用**（`-ProfileDir` / `-StateDir` 参数、退出码、耗时）—— 这个脚本自己的演练脚本 `scripts/drill-rescue.ps1` 覆盖的是"人双击"的路径，不是"守夜人调用"的路径。
- ⚠️ **健康路由判定**：`<stateDir>/access.json` 里的端口 + `/__dsh_autorestart/health` 在客户端刚启动那几秒的可用性（会不会长时间 401/连接拒绝，导致误判 `ready: false`）。
- ⚠️ 登录任务在**多用户机器 / 域账户**下的行为。

> 结论：**代码和逻辑层已测；真机验收没做。** 在真机验收之前，不要把"它能救回来"当成已经兑现的承诺。
