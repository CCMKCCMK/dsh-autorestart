# Changelog

## 0.9.4

这一版把「重启前备份」从「每次都拷一份」改成「**真变了才拷**」，并顺手修掉了三个只有真机才会暴露的坑。
改动合并 t22–t26 的修复，版本号仍是 0.9.4。

### 新增：重启前先比对，**没变化就不备份**（2026-11-07）

重启前那份「备份」现在先问一句：最新的完整副本，是不是已经装着这次开机要跑的内容？

- **有变化**：照旧完整备份（真机 gen 516：847 文件 / 300,933,233 字节）。
- **没变化**：不新建目录，直接沿用最近那一份，并在 `last-restart-verdict.json` 里留下
  `skipped: "unchanged"` 与它沿用的目录名（真机 gen 517：复用 `08-36-23`，份数不变）。
- **关掉「重启前备份」**：既不比对也不备份，浮窗直接显示「正在重启…」。
- **比对不了**（预算超限、profile 认不出来）：照旧备份 —— 比对永远不能阻止一次重启。

用户口径：备份条数应该等于「**配置真正改过几次**」，不该随重启次数膨胀。

### 新增：备份浮层改成两张卡

- **卡①**：「正在比对配置和插件有没有变化…」/（只备份配置时）「正在比对配置有没有变化…」。
  没开备份时**不出这张卡**。
- **卡②**：拷 → 「配置和插件有变化，正在备份，共 {size}」；跳过 → 「配置和插件没有变化，跳过备份，
  将执行重启」；比对不了 → 「无法比对配置和插件，仍会备份」；失败 → 「备份失败，重启继续进行」。
  拷完之后第二行固定「**备份完成，将执行重启**」。
- 「正在备份」与「正在重启」**不会出现在同一行**；同一条文案中英各一份
  （`locale/zh.json`、`locale/en.json` 三处镜像）。

### 新增：设置页讲清备份策略，并留下一次被跳过的痕迹

- 备份区顶部新增说明段「**什么时候会备份？**」：每次重启前先比对配置（勾了「备份包含已安装插件」时
  还会比对已安装插件）有没有变化；有变化才新建一份，没变化就跳过、沿用最近一份；备份条数等于
  配置真正改过的次数；关掉开关时既不比对也不产生备份。
- 备份列表新增一行留痕：「上次重启（{时间}）：配置和插件没有变化，未新建备份，沿用 {目录名}」——
  「为什么没多一份」从此看得见，不用去翻日志。

### 修正：三个只有真机才踩得到的坑

1. **插件树指纹必须跳过 `.git`。** 备份副本按设计不拷 `.git`（可重建，且曾占掉每次备份的绝大部分），
   而指纹把整棵树都走了：同一个链接插件**源 218 文件 / 9,908,999 字节 vs 副本 139 文件 / 5,601,116 字节**
   —— 差的 79 个文件 / 4,307,883 字节正好是 `.git`，于是两侧永远不相等、永远判「有变化」，
   每次重启都照拷一份。现在指纹与拷贝共用同一份排除名单（`BACKUP_SKIP_NAMES`）。

2. **比对基准必须与本次备份额度同范围。** 最新副本可能是 first-install 种子
   （`includePlugins: false`、`config-only`、只有 3 个配置文件、92,888 字节）。拿它当基准比出来的
   `unchanged` 是**假**的：真机 16:24 那次就因此跳过了备份，而源码其实改过
   （`plugins/dsh-autorestart/index.js` 源 **575,255 字节**（16:22:12）vs 副本 **573,584 字节**（16:06:12））。
   现在要备份插件时，只有含插件树（`manifest.includePlugins: true` 且 `node_modules-link/` 非空）的副本
   才可作基准；没有同范围副本一律判「有变化」并完整备份。**宁可多备一次，也不能该备没备** ——
   漏备比重复备危险。

3. **种子判定不能把「还没认证」当成「没有」。** 真机时间线：pre-restart 备份写出于 **16:19:18**、
   写认证于 **16:20:33**，而种子判定发生在 **16:20:23** —— 中间那 10 秒里 `latestKnownGood()` 是 null，
   于是每次开机都误判「首次安装」，白写一份 92 KB 的 `config-only` 副本。
   现在种子先问「有没有完好副本、且内容与本次启动加载的一致」，有就返回 `present`、不再写种子；
   认证语义本身没放宽（那份副本仍然只在自己启动成功且内容匹配后才算 known-good）。

读数：`node --test plugins/dsh-autorestart/test/` → **1052 项全绿**（pass 1052 / fail 0）。

## 0.9.3

这一版把用户在真机上反馈的几件事一起收了：**重启前备份有时候根本没做**、**备份目录里堆着空壳把份数预算撑爆**、**拷贝进度永远停在 0%**、**一次性残留卡片要刷新才出现、点「清理掉」还没反应**。改动落在 `d85af1e`（修复批），版本号在 `8fe39b8` 单独 bump。

### 修正：重启前备份保不住 / 空壳把保留份数撑爆 / 进度永远停在 0%（2026-11-07）

1. **最新一份不再被 first-install 种子抢占。** 种子（第一次安装时留下的那份）不再参与「最新」的候选，
   只取最新的、非种子的完整备份——否则保护位会被一份老种子占住，真正的滚动备份被当成「多出来的」删掉。

2. **删除失败不再静默。** 删除前先清只读属性、删完再校验目录确实不存在；失败逐条进 `failures`
   （不再是一个静默的 `catch {}`），回执里能说清「哪一份没删掉、为什么」。

3. **保留份数只统计带 manifest 的完整备份。** 空壳（没有清单的残留目录）单独计数、单独处理，
   不再占用保留份数的预算——份数从此是「真正可回滚的备份」的份数。

4. **`node_modules-link/<name>` 的拷贝补上了 `onProgress`，进度分母改成这次真正要拷的量。**
   原先只统计 3 个配置文件，于是目标很大、进度条却永远停在 0%——那次真机上进度采样 46 条
   从 0 走到 100%，末条 bytes 与 total 完全相等。

### 修正：一次性残留「要刷新才出现」「点了清理掉没反应」（2026-11-07）

1. **就自己出来。** 一次性残留卡片挂在 composer 上方，挂载即查 + 每 5 秒轮询，切到后台暂停，
   答过即停——用户不用再刷新页面才看到它。

2. **点下去当场有反馈。** 点击的那一帧就把按钮置灰并显示「正在清理，请稍候」/「正在记下来，请稍候」，
   不 await 任何往返；失败时显示一句可读的错误（走 locale，中英各一套），渲染或轮询抛错也不再静默。

3. **说完就收。** 成功回执 3 秒后自动消失，错误文案留 10 秒（要读完），两者消失后都不再发任何请求；
   清理进行中不计时、不提前消失。

4. **修掉 t10 遗留的作用域缺陷。** 卡片的 helper 与 React 工厂原本在两个互不可见的 IIFE 里，
   于是在真机上点「清理掉」取回执时抛 `ReferenceError`——**这就是「点了没反应」的根因**，
   而不只是少了一句文案。

### 修正：profile 目录定位把备份「静默跳过」（2026-11-07，那次真机事故的根因）

1. **先问，再记，最后才扫。** 顺序是 `DSH_PROFILE_DIR` → `DSH_HOME`+`DSH_PROFILE` → `--profile`
   → 扫描；能问到时**一次都不读 `profiles/` 目录**。解析成功一次就把路径记进 `state/profile-dir.json`，
   下次启动先读它（目录还在就直接用，被删才重新解析）。

2. **扫描排除了残留与拷贝。** `_backup-*`、`*.broken-*`、`*.partial-*`、以 `_` 开头的目录一律不参与；
   扫描只在问不到时兜底，且**候选唯一才采用**，多于一概判 `ambiguous`，不许猜。
   那次事故里另一个会话把整个 profile 复制成 `profiles/_backup-before-fetch-fallback-…`（也声明本插件），
   扫描到两个候选 → `ambiguous` → 备份没做。

3. **跳过备份不再只是日志里的一句 warn。** 重启结果与设置页都会显示
   「这次没有备份：没找到你的配置目录（发现 N 个候选）」——`N` 是扫描真实看到的候选数。

### 其它

- **先把话答回去，再去删。** `POST` 立刻返回「已受理」，后台每批 8 个目录分批删除，回执随下一次 `GET` 取回。
- **旧宿主不再无限「清理中」**：应答里没有 `cleanup` 字段时，直接用应答自带的 `removed`/`failures` 出回执；
  轮询另有 60 秒上限，到点给一句明确的文案。
- `scripts/cleanup-shell-backups.mjs` 只支持 `--dry-run` 报数，拒绝路径参数（免得被当成删除工具）。
- `lib/legacy-cleanup.js`：`execFileSync` 的程序名改成常量映射，消掉既有的 dynamic-program blocker。

### 读数

- 测试：`node --test plugins/dsh-autorestart/test/` → **1040 项全绿**（pass 1040 / fail 0）。
- 安检：`plugins/dsh-security-scan/security_scan.mjs` → **0 blocker**（medium 2 / info 6）。
- 真机：重启前备份 **taken=true**，**274.5 MB** 完整备份（配置 + 7 个插件 + 清单）；进度采样 46 条 0→100%，
  末条 bytes 与 total 完全相等。

## 0.9.2

### 修正：「这次启动少东西了」浮窗的三处自相矛盾（2026-11-05）

用户在真机上看到的卡面是：标题「有两件事要你看一下」→「这些功能这次没起来」→
`@deepseek-ai/dsh-experimental-client-ui-forge`→「这个插件是第三方安装的，备份里没有它的文件。
**要还原就用下面那条命令**，它会装回原来的那个版本（不是最新版）：」→**（空行，下面没有命令）**→
「备份里查不到它的精确版本，只能按插件名重新安装。」

1. **没有命令就不承诺命令。** 「要还原就用下面那条命令」这句话和它下面那条命令现在在**同一个分支**里：
   真的构造出了命令（`dsh plugin --profile <p> add <name>@<version>`）才输出这句话 + 命令；
   没有命令时只说一句实话（新增词条 `pluginFailure.noCommandHint`），旧的 `pluginFailure.noVersion`
   文案（本身就是一句「只能按插件名重新安装」的自相矛盾）连同词条一起删掉。

2. **插件清单里查不到的包不再算「没起来的插件」。** 清单是本 profile 插件的名单；名单里没有的包
   （例如宿主自带的 `@deepseek-ai/dsh-experimental-client-ui-forge`）不是用户装的插件，
   备份里没有它的文件、也没有可重装的版本——列出来等于让用户去做一件做不到的事。
   现在 `buildPluginFailureModel` 直接跳过这类包。**前提**：只有清单真的读到了（rows 非空）才启用这条过滤；
   清单读不到时保持原样，不把整张卡静音。

3. **标题不再声称件数。** 「有两件事要你看一下」/「Two things worth a look」换成中性说法
   （中文「启动后有东西没起来」，英文「Something did not come up after the start」）——
   这张卡只有一份列表，列表里可能有一个名字，也可能有几个。

### 修正：浮窗里的还原命令写着 `<profile>` 占位符；命令旁补一句「回插件页重装」（2026-11-05）

用户在托管 web 实例上看到的是 `dsh plugin --profile <profile> add dsh-better-sidebar@0.28.2`——
`<profile>` 是原样占位符，这条命令复制出去根本跑不了。

1. **命令里写真实的配置名。** 宿主健康载荷里的 `profile` 是配置目录的绝对路径
   （托管 web：`/home/fg/.dsh/profiles/web`；桌面版：`…\.dsh\profiles\desktop`），
   取最后一段就是配置名（`web` / `desktop`）。新增工具函数 `pluginFailureProfileName`
   负责这件事，`/` 与 `\` 两种分隔符都处理；取不到时仍回落成 `<profile>`
   （不崩、不显示 undefined/null）。

2. **命令旁边补一句「不习惯用命令可以回「插件」页重装」。** 新增词条
   `pluginFailure.reinstallHint`，并写明**从界面重装拿到的是最新版，不是备份里这个版本**
   （上面那条命令装的是备份里的那个版本，两者不是一回事，读者必须知道自己将要拿到哪一个）。
   这句只在真的有命令的分支里出现；没有命令的分支（`pluginFailure.noCommandHint`）不出现，
   免得又变成一句没有下文的承诺。

## 0.9.1

- 安全修复（外部报告，已私下协调披露）：会话 id 传 `__proto__` 时，读取会话状态的代码会落到 `Object.prototype`，
  于是后续字段写入会污染宿主进程里每个普通对象。现在状态表一律只认自有属性，并对 `__proto__` / `constructor` /
  `prototype` 这三个 id 在工具与 HTTP 路由两侧统一拒绝。
- 会改状态的 HTTP 路由现在要求 `Content-Type: application/json`：跨站页面无法再用简单请求触发它们。
- 新增 13 条回归测试；同一批断言在修复前的代码上有 9 条会失败。

## 0.9.0

- 收窄到「重启」本身：删除看门狗自动救援与手动救援脚本，出事后交给 DSH 自己的崩溃对话框或重装
- 保留：排队重启、重启前快照、登录 cookie 清理、会话续接、托管端按命令重启、关机倒计时
- 文档与插件描述同步改写，不再宣称任何自动还原能力
- 设置页文案同步：备份说明从「起不来会自动回退」改成「存档，插件不会自动用，要回退自己点」；
  唯一例外是你自己装的「开机自启」守护，它仍会在宿主起不来时回滚上次快照
- 升级清理：从 0.8.x 升级后首次启动会删掉旧看门狗留下的计划任务与 5 个状态文件

## 0.8.6 — 2026-11-03

本版把 2026-10-30 的首批改动与之后累积的六批改动一并发布（0.8.6 在此之前只写进过 CHANGELOG，一直没有对外发布过）。逐批见下。

### 修正：重启一直没触发、重启「截止时间」概念拆除、备份清单如实记账（2026-11-02）

这一轮全部围绕「界面/日志说了假话」和「等不到的重启」两件事。

#### 1. 重启永不触发：目标驱动的会话把安静窗口无限重置

**症状**：`/health?state=1` 显示 `allowRestart: false`、`quietForMs` 一直很小、`blockedBy` 里挂着一条**目标驱动**的会话，重启等了几十分钟也没发生。

**根因**：目标驱动的会话每跑完一轮就立刻起下一轮，于是「最后一次活动时间」被无限推后，安静窗口永远凑不满；闸门就一直不放行，而**没有任何地方把这个原因说出来**——用户只看到「重启没发生」。

**修法**：新增两个诊断字段（`restartGate` / `quietResetBy`），把「闸为什么没开、安静窗口是被谁重置的」直接写进 `state` 载荷：一眼能看出是「有人在跑」还是「跑完又立刻起下一轮」。行为不变，可见性补齐。

#### 2. 重启等待不再有「截止时间」（按用户口径：一直等，直到所有会话空闲）

**症状**：状态里出现 `deadlineAt` / `deadlineInMs` / `deadlineCutsTheRequest`，页面/日志里出现「截止时间已过」。读者（包括维护者本人）一律理解为「请求作废了」——**但它从来没作废过**：默认配置下这些数字一个都不影响结果，只是把人吓一跳。

**修法**（代码侧已随本轮改动落地，文档同步更新）：

- `restartRequest` / `state` 载荷**不再输出** `deadlineAt` / `deadlineInMs` / `deadlineCutsTheRequest`，改为 `waitsUntilIdle: true`；
- 闸里删掉软/硬期限与「到点告警」分支：只要有会话在跑就是 `long-wait`（`reason: waiting-for-conversations`），**没有任何计时器、超时或默认值能让请求结束**；请求只有两种结局——闸门放行，或用户显式撤回；
- 「等很久」也不再等某个阈值才显示：请求一被挡住就报「已等多久 + 谁在挡」，日志与胶囊同步；
- `deferSoftMs` / `deferHardMs` / `deferPolicy` **读入但完全无效**，仅为兼容旧配置文件保留（建议下一版删除）；
- `forceRestartWhenBusy` 保留、默认关闭，语义明确为「**会打断正在运行的会话**」，不再被当作截止时间。

#### 3. 急救开关在「只剩一个 bundle 的 profile」上写坏 JSON（Windows 救援路径不可用）

**症状**：`emergency-toggle.ps1 -Action enable` 在单 bundle 场景下拼出的 JSON 多/少一个逗号，脚本自校验失败 → 自己回滚 → `exit 1`。也就是「Windows 上出事了想急救，开关根本打不开」。

**修法**：修正逗号插入位置；并把它钉成断言（修好之前那条断言是红的），避免再次悄悄回归。

#### 4. 备份清单没记账 → 界面误报「备份里没有」

**症状**：`dsh-codekg` 的文件明明在 `node_modules-link/dsh-codekg` 里，界面却说「备份里没有这个插件」。

**根因**：判断「副本里有没有它」用的是**活档的安装形态**（`node_modules/<name>` 是不是符号链接），而活档形态会和备份时刻不一致。

**修法**：manifest 新增 `plugins: [{ name, version, install }]`（只记真正拷进 `node_modules-link/` 的成功项，版本取副本自己的 `package.json`）；读取端顺序改成 **manifest → 扫目录 → 活档标志**，老副本没有该字段时扫目录兜底。真机实测：同一份备份上，`dsh-codekg` 由「备份里没有」变成「跟备份不一样」。

#### 5. 插件列表收敛：只列自研，内置/第三方各一句（文案纠正）

- 逐条列出的只有**能真正回退的**插件（链接安装的，或副本里确实有文件的），各自带「已在备份里 / 跟备份不一样 / [只恢复 X]」；
- **内置插件**：「另有 N 个内置插件：DSH 自带，不需要备份」；
- **第三方插件**：「另有 N 个第三方插件：**我们没有备份它们**，真出事时需要重新安装」；
- 删掉「备份里只有名字和版本」这类**暗示备份里有东西**的说法（中英都改）。

#### 6. 桌面快捷方式图标与设置页同源

`.lnk` 的 `IconLocation` 与设置页显示的图标现在来自**同一个** host 字段（`rescue.iconPath`，同一次存在性校验）；取不到图标时两边都明说「没有」，`.lnk` 省略图标而不是失败。同时修好了桌面定位：优先读注册表 `User Shell Folders\Desktop`，并按 GBK 解码 `reg.exe` 输出（否则桌面在 `G:\桌面` 这类中文路径上会被判成「找不到」而回落到猜的 C 盘目录）。

#### 7. 桌面救援快捷方式图标改用插件自带 icon（不再借用 DSH 可执行文件）

桌面救援快捷方式的图标现在是插件随包的 `assets/icon.ico`，**不再拿 DSH 自己的可执行文件顶替**——桌面上看到的是「救援工具」，不是那个已经坏掉的程序。包内没有这个图标文件时，`.lnk` 仍然会创建，只是不写 `IconLocation`（也就没有「图标路径不存在 → `Save()` 抛异常 → 快捷方式建不出来」这条风险）；运行期不会生成图标，也不回退到别的程序的脸。非 Windows 平台不提供桌面快捷方式，设置页给的是可复制的还原脚本命令。

#### 8. 排队重启在会话静默后永不触发（轮询器把自己停了）

**症状**：点了重启，界面说「已排队」；后来所有会话确实静默了，重启却一直没发生。`/health?state=1` 里 `restartGate.at` **冻在某一刻不再前进**（真机读数：`at` 停在 `23:09:21`、`waitedMs ≈ 719640`，也就是 12 分钟没再评估过一次），而重启请求的记录文件一直写着 `pending`。

**根因**：`tick()` 的停止条件把「还有没有排队中的请求」判给了**内存里的意图**。会话静默后内存意图被清掉 → `queuedRestartRecord()` 答 `null` → 轮询器认为「没有在等的请求」→ `stopPolling()` 自己退出 → **闸门从此再没被评估过**。记录文件还在说 pending，但已经没有人去读它了。

**修法**（两处，各自只认事实）：
- `queuedRestartRecord()` 直接读 `readRestartRequestRecord(stateDirOf())`，把 `queued` / `deferred` 当作 pending，**不再去问 `restartRequestInfo()`**——那个函数是给界面**汇报**用的，不该承担「现在该不该继续轮询」的判据；
- `summarizeRestartRequest()` 在内存意图已消失（`live === null`）但记录仍是非终态时回 `pending: true`：状态载荷不会因为意图没了，就把「还在排队」说成「没有请求」。

**可观测性（用户明确要求）**：闸门的判定结果（`allowRestart` / `quietForMs` / `blockedBy` / `reason`）被写进状态，下次打开 `?state=1` 就能看见「为什么还没放行、是谁在挡」，不再只留在日志里。

> 附一条测试侧结论（见 `docs/real-machine-verification-0.8.6.md` 的证伪实验）：上面第二处修法被回归测试钉住（把它回退掉，断言立刻变红）；**第一处没有被任何测试覆盖**——因为第二处让「汇报函数」自己也能答 pending，旧写法的第一处照样工作。第一处仍然保留：它的价值不是「再算一遍同一件事」，而是**不让轮询器依赖一个汇报用的函数**（当初的 bug 恰恰就是轮询器去问汇报器、汇报器答错）。

#### 9. 删掉「某个插件起不来？退回它的上一个版本 / 立即检查」入口

**为什么删**（用户决定，2026-11-02，原话意思是「没法定位具体哪个插件坏了」）：这个入口只能按「跟备份不一样」把插件列出来，那是一个**线索**，不是**诊断**。留一个做不到的承诺，比没有这个入口更糟。

**删了什么**：客户端与 web 端挂的是同一块，所以删一次两端都没了——整块 `pluginRecoveryItems`（标题、`立即检查` 按钮、「还没检查。点『立即检查』看看每个插件现在的状态。」空态、逐插件行与「只恢复 X」按钮、「另有 N 个内置/第三方插件」两句）、驱动它的 `usePluginRecovery` 钩子、`pluginInventoryRows` 与 `SETTINGS_STATUS_KEY`，`client.js` 净减 **214 行**；两个挂载点（设置页的备份折叠区、插件配置页）一并删除。

**词典同步收口**：12 个键 × 中英两份 = 22 条，镜像键数 **406 → 394**（两份逐键一致）；另删掉两处指向它的「引子」——折叠标题下的「内含：某个插件起不来？退回上一个版本」，以及桌面救援说明里「只想摘某个插件，请用上面『某个插件起不来』」这半句（英文镜像同步改）。删完在 `client.js` 与两份镜像里 grep，全部 0 命中。

**没有动后端**：浮动故障卡自己的恢复路径（`pluginInventoryUrlFor` / `restorePluginOnce` / `PluginFailurePanel` / `pluginFailure.restore`）全部保留且仍在调用——删掉的只是「在设置页/配置页列出所有插件并逐个回退」这个入口。

#### 10. 桌面快捷方式的图标从来自愈不了（重启多少次都还是旧图标），顺带修掉「跑测试会改写用户真桌面」

**真机症状**：`.lnk` 的 `IconLocation` 一直停在旧图标 `…\shortcut-icon-9c245e5b.ico`，写入时间是 `2026-11-02 23:02:33`——**宿主已经重启、新代码已经加载之后，它仍然指着旧图标**。也就是说「图标改用插件自带 icon」这件事，只对**当时点过按钮**的人成立。

**根因**：`createDesktopShortcut` 在全仓只有一个调用点（`index.js` 里 `POST action === 'shortcut'` 那条路由）。启动路径**从不写 `.lnk`**，所以旧快捷方式不会随着版本更新被纠正——重启一百次也不会自愈。

**修法**：`lib/rescue-paths.js` 新增 `readShortcutLink()` 与 `syncShortcutIcon()`：读回 `.lnk` 的 `TargetPath` / `IconLocation`，与「本版本应该用的图标」比较，**只有不同才写**；写完用 `SHChangeNotify` 让壳刷新图标缓存；`TargetPath` 原样保留（快捷方式仍然指向 `restore-profile.cmd`）。`index.js` 启动路径加一次校准，整段用 `try/catch` 包住——校准失败绝不拖累启动。图标文件名按内容哈希算，代码里没有硬编码 sha。

**真机读数**：修后 `IconLocation = …\storages\dsh-autorestart\shortcut-icon-1902bb15.ico,0`，`TargetPath` 仍是 `restore-profile.cmd`；第二次 sync 返回 `already-current`（幂等，不重复写）。

**顺带修掉的更糟问题**：在加这层 guard 之前，**跑一遍全量测试会把用户真实桌面上的 `.lnk` 改写**成 `%TEMP%` 里的图标——实测读到 `…\Temp\dsh-autorestart-it-recover-now-idle-…\shortcut-icon-1902bb15.ico`。测试环境的东西跑到用户桌面上去了。已加 `isInsideTempDir()`：**临时目录里的图标永远不会被写进真快捷方式**。

#### 11. 排队重启被作废之后，用户完全看不见发生了什么

**真机症状**：`2026-11-02 23:04:38` 请求的重启一直排队，等了 `8473292 ms`（约 **2 小时 21 分**）从未执行；宿主重启后，新实例的 boot-recovery 把它判成 `cancelled`（理由含 `stale-never-executed`）。而**设置页上什么都没有**——用户看到的是「没有排队重启」，就好像他从来没点过。

**修法**：设置页顶部加一条可见提示（`role=status`，标记 `data-dsh-autorestart-restart="cancelled-note"`，文本节点 `cancelled-text`），只有当最近一次请求 `state === 'cancelled' && by === 'boot-recovery'` 时出现。内容三件事：请求时间（`2026-11-02 23:04:38`）、人话时长（`约 2 小时 21 分`；≥60 分说「约 N 小时 M 分」、<60 秒说「几秒」）、以及「想重启再点一次就行」。

**不漏内部标识符**：`reason` 字段根本不参与渲染；测试逐串断言页面上不出现 `boot-recovery` / `stale-never-executed` / `deferred` / `queued` / `attempts`。**也不常驻**：从未请求、仍在排队、正常完成、用户自己取消、被别人取消——五种情形各有断言，都不画。

#### 12. `health.backups.available` **恒为 0**（不是偶尔算错，是永远算不出别的数）

**真机症状**：`health` 报 `backups.available: 0`，而磁盘上两份备份都在，其中一份 `intervention: false` + `certifiedBy: full-checks` 的那份**确实可还原**。

**根因**：`available` 是在一份**给页面看的投影**上判资格，而那份投影里**没有 `boot`、也没有 `trigger`** 这两个键（键不出现，不是 `null`）。资格判据要的正是一份副本「启动记录」是否证明它起来过、内容是否匹配——投影把证据裁掉了，所以判据永远拿不到料，结果**常数 0，永远不会变成别的数**。而真正的证据一直在读路径里（`readBackupMeta` 会翻译旧记录：旧 seed → `first-install`，旧签 + 指纹匹配 → 一段可用的启动事实），`listBackupIdentities` 也带着这两个字段。

**修法**：先取完整记录 `identities`，投影 `items` 仍由它派生（**投影字段一个都没增**），`available` 改在 `identities` 上统计——与看门狗、回退助手**同一个函数**，不再是两套尺子。

**为什么长期没被发现**：**没有任何一条测试断言过 `available` 的取值**。已补 4 条：根因复现（投影喂判据必为假）、三份同形副本的逐份计数、与 selector 同判据（两集合必须一致）、seed 靠 `trigger` 仍算可用；并做了证伪——把实现改回旧写法，其中 3 条立刻变红。

#### 13. 测试套件把临时目录漏在 `%TEMP%` 里（跑了几个月，攒下 13 万个目录）

**症状**：本机 `%TEMP%` 下的可用空间在慢慢变少，但没有任何一处报错——因为每次测试都"成功"。

**真实规模**（先把估算纠对）：先前只数了一个前缀，得到 `34448 个 / 4.17 GB`，**那是低估**。按本插件实际用到的**六种前缀**统计——`dsh-autorestart-*`、`dsh-restart-request-*`、`dsh-ar-*`、`dsh-ledger-*`、`dsh watchdog <label> `（含空格）、`ar-*`——实测共 **131,151 个目录 / 1,219,987 个文件 / 14,350 MB**。

**根因**：测试里到处 `fs.mkdtempSync(path.join(os.tmpdir(), <前缀>))`，但**没有任何一处负责删**。测试成功也漏、失败也漏；`node --test` 跑一次就多一批，几个月下来就是这个量级。

**修法**：新增 `test/_tmp-guard.mjs`——包装 `fs.mkdtempSync` / `fs.mkdtemp`，把落在 `os.tmpdir()` 下、且带本插件前缀的结果记进**本进程的集合**，在 `process.on('exit')` 里逐个删；同时导出 `cleanupTempDirsNow()` 供需要提前清的地方兜底。67 个测试文件首行加一行 `import './_tmp-guard.mjs'`。

**证据（干净窗口）**：`131151 → 跑完全量 → 131151`，**新增 = 0**；失败场景同样清——在一份副本里加一条必失败的测试，跑完 delta 仍为 **0**（说明守卫不靠"测试成功"这条路生效）。

**历史残留已清理**：两轮共删约 **12.9 万个**目录（123,788 + 5,215 + 2），**失败 0**；可用空间 **92.7 GB → 108.17 GB（释放 15.5 GB）**；`%TEMP%` 顶层目录 **5,942 → 725**；本插件六种前缀剩余 **0**。


### 修正：恢复插件后的可用性没有被验证

旧版本在恢复插件时，只把备份里的文件拷回原位，**不检查恢复出来的插件能不能正常加载**；恢复完成后即记为成功。实测中出现过「报告成功、插件仍是坏的」以及「把一份本来就坏的备份当成可以回滚的那份」两种情况。

0.8.6 起：
- 备份的身份需要证据——只有**当前正在运行、且四项启动检查全部通过**的那一份才会被写成 `known-good`；
- 恢复目标只在这类 `known-good` 备份里选；**一份都没有时不动手**，并在报告里写明原因；
- 每个备份记录它**凭什么**被写成 `known-good`（比对内容指纹），拿不出这份记录的旧备份一律不采信。

### 修掉测试的「墙上时钟依赖」

**症状**：同一份代码，08:56 全量 999/999 绿，09:01 变三条红（`integration.test.mjs` 的「boot pass restores…」、`plugin-recover.test.mjs` 的「THE BOOT PASS ONLY LOOKS…」与「a clean previous boot writes no report at all」）。

**根因**（不在实现，在 fixture）：`lib/plugin-recover.js` 的 `findLatestStartupLog` 用 `log.mtime <= cutoff` 判断"这是上一轮已结束启动的日志"——这是被测行为，**一行没动**。而这几处测试把 `bootAt` 写死成 `2026-11-01T01:00:00Z`（北京 09:00），它们写出的启动日志却是 `writeFile` 落的盘，**mtime 是运行时真实时钟**。于是真实时间一越过 09:00，日志就被判为"本次启动写的"，查找返回 `null`，三个用例同时红。

**修法**：把日志的 mtime **钉死到它自己描述的那一刻**（`fs.utimesSync`），让测试与墙上时钟彻底解耦；同时把两个 fixture 的"日志时刻 / 启动时刻"提成命名常量（`LOG_AT` / `BOOT_AT`、`RECOVERY_LOG_AT` / `RECOVERY_BOOT_AT`），避免有人把 `bootAt` 推到未来去"修"它——那等于改掉被测语义。

- `test/plugin-recover.test.mjs`：新增 `pinLogTime()`，`writeStartupLog` 与另外两处直接写日志的用例（clean boot、sinceMs guard）全部走它。
- `test/integration.test.mjs`：`pluginRecoveryFixture` 写完日志即钉 mtime（早于它用到的两个 `bootAt`）；「只读更早启动的日志」那条用例仍然在之后把 mtime 顶到 `01:00:04Z`，语义不变。
- **新增 2 条守卫断言**：`the boot-pass fixture pins its log strictly BEFORE the boot under test` / `the plugin-recovery fixture pins its log strictly BEFORE the boot under test` —— 断言 `logMtime < bootAt`、盘上 mtime 约等于钉死值（容忍文件系统取整）、且钉死之后 `findLatestStartupLog` 仍然找得到这份日志。以后谁再引入"靠 now 决定"的 fixture，会当场红。
- 实测：修复前 09:01 三条红 → 修复后 **09:04 全量 1001/1001 绿（exit 0）**；拷问脚本显示钉死后 mtime = `2026-11-01T00:00:01.100Z`，距 bootAt 恒 +3598.9 秒，与真实时间无关。
- 断言**一条没删、一条没放宽**，只是把 fixture 的时间来源从"现在"换成"它描述的那一刻"。

### 收敛：启动只提示不改文件、按需恢复单个插件、守夜人全部删除

> **这一节取代下面「报错型插件故障：自动换回好版本、只重启一次、写出可读报告」那节里的自动恢复部分。** 那节的检测、纯函数和报告格式都还在用；被拿掉的是「启动时自己动手 + 自己请求重启」。

#### 用户拍板（2026-11-01）

三件事，两件是"少做"，一件是"补上缺的那半"：

1. **不要再自动修** —— 实测证明 DSH 自己就能剔除坏插件并照常起来：桌面版 22 秒正常启动、坏插件路由 404、配置不动；WSL 托管版 2.0–2.6 秒起来、`package.json` md5 五次一致、守护脚本 62.9 秒内只 +1 次启动。插件再插一手自动恢复，等于在启动路径上多一个改文件的写者 + 多一次自动重启。
2. **把提醒搬到前台** —— 原来"检测到了"这件事只落在 health 字段和日志里，用户看不见。现在弹出来：哪个插件坏了、报了什么错，并给**一个**选项「只把这一个插件恢复到上一个备份版本」。
3. **守夜人（sentry）全部删掉** —— 与「关就是关」冲突，不再维护。

#### ① 启动路径：只读、只写报告，不动文件、不请求重启

- 启动时改调新函数 `detectPluginRecovery()`（`lib/plugin-recover.js`）：读**上一次启动**的日志 → `findPluginFailures` 解析 → `mergeFailuresByPlugin` 归并 → 写 `<stateDir>/last-plugin-recovery.json` → 暴露 health 字段。
- **启动路径不再调用 `applyPluginRecovery`，也不再调用 `requestRestart`**（单测钉住：恢复前后 profile 里每个文件的 sha256 不变、没有 `<plugin>.broken-*` 证据目录、`state.restart === null`）。
- 报告里的 `actions` **恒为空**：什么都没做，就不能写"overwrite"假装恢复过。`backupKind` / `restoredAt` 仍然填（回答"有没有备份可恢复、恢复到哪个时点"），弹窗据此决定按钮是否可用。
- `plugin-recovery.json`（attempt 预算 / handled 指纹）**启动路径也不再写**：自动恢复没了，这两个记账就没有读者了。
- `runPluginRecovery()` / `collectPluginRecovery()` 保留导出（现有集成测试直接驱动它们，且逻辑本身没错），但**启动流程不再调用**。

#### ② 新增按需入口：只恢复一个插件

- `POST /__dsh_autorestart/plugin-restore`，body `{ "plugin": "<name>" }`。
- 返回 `{ ok, plugin, mode, restoredFrom, restoredAt, backupKind, needsRestart }`（另带 `changed` / `evidence` / `at` / `reason`）。
- 只恢复**被点名的那一个**：真副本 → `overwrite`（现场目录先改名为 `<name>.broken-<ts>` 留证据，绝不删除）；链接安装 → `replace-link`（软链同样改名留证据，备份内容顶替）。
- **幂等**：现场已等于备份 → `already-consistent`，不写任何文件，`needsRestart: false`。
- **失败也是 HTTP 200**：`ok:false` + `reason`（"没有备份" / "拷不进去"）。500 会让浏览器分不清"没有备份"和"宿主崩了"。
- 每次尝试写 `<stateDir>/plugin-restore-history.json`（最多 20 条，最新在前）；health 新增 `pluginRestore` 字段带最近一条。`pluginRecovery` 的形状**保持不变**（`continuum_status` 的严格 output schema 也没动）。
- 这一条路径**跳过**自动恢复的两个循环守卫（`duplicate` / `needs-human`）：那两条是"机器该不该自己动手"，人再点一次不是循环；幂等检查仍在保护磁盘。

#### ③ 前台弹窗（`client.js`）

- 新增 `PluginFailurePanel`，挂在 `conversation.input.dock`（和安装提问、新功能公告同一个位置：不盖界面、不碰倒计时）。
- 显示：标题「有插件没加载成功」、每个插件的名字 + 它报的错（最多 3 条，其余只报数量）、备份时间、以及每个插件一个按钮「只恢复 <plugin>」。没有可用备份时按钮不出现，直接说"只能手动处理"。
- 点完就地显示结果：恢复成功（重启后生效）/ 已经和备份一致 / 恢复失败的原因。
- 新增中英词条 12 条（`pluginFailure.*`）。

#### ④ 守夜人删除

- 删除 `lib/sentry.js`、`lib/sentry-install.js`、`supervisor/sentry.js`、`test/sentry.test.mjs`、`test/sentry-install.test.mjs`、`docs/sentry.md`（共 6 份）。
- `README.md` / `docs/README.zh.md` 的"未接线备用件"段落改写成「已移除（2026-11-01，用户拍板：与『关就是关』冲突，不再维护）」。
- 源码里**没有任何 import 引用**过它（这几份文件本来就是未接线的备用件），所以删掉不影响任何加载路径。
- **清理守夜人残留引用**（3 处，都指向已删除的文件/概念，删完才不留悬空指针）：
  - `package.json` 的 `files` 数组删掉 `"supervisor/sentry.js"` —— 那个文件已经不存在了，留着只会让打包清单指空；
  - `lib/watchdog.js` 里"用尽次数"的失败文案由「rely on the sentry」改成「no further rollback will be attempted」，如实描述现在的行为：看门狗是**最后一道自动步骤**，它放弃之后就得人来看报告（同时把该处注释补上这个理由）；
  - `test/watchdog.test.mjs` 里那条 `/sentry/` 断言不再是「指向谁接手」，改成**正向断言新文案** + **反向断言旧词已不存在**（`doesNotMatch(/sentry/i)`）——断言没有删，只是跟着文案走。

### 报错型插件故障：自动换回好版本、只重启一次、写出可读报告

#### 缺口

「坏法」有两种，原来只接住了其中一种：

- **进程级**（宿主根本起不来，比如 `EADDRINUSE`）——已有看门狗 + 重启前快照负责，这次不动；
- **报错型**（宿主起来了，但某个插件 entry **静默没激活**，功能直接 404）——原来**没有任何人管**：日志里明明写着 `<plugin>: failed to import: <error>`，界面却一切正常，用户只会看到某个功能"莫名其妙没了"。

#### 现在

- **检测**（新增 `lib/plugin-failure.js`，纯函数）：`findPluginFailures(text, { sinceMs, logAt })` 认得四种真实日志行 —— `dsh: warning: N entry did not activate`（总括行，不点名）、`<plugin>: failed to import: <err>`、`<plugin>: import failed ...`、`- <plugin>: loading`（审计时还停在 loading，等于没激活）。**不认识的行一律忽略**：尤其**故意不认**进程级启动失败那段 `startup failed: ... / Failed plugins (1): ... / Error: EADDRINUSE` 转储 —— 那是看门狗的活，两个机制抢同一件事只会互相打。
- **恢复**（新增 `lib/plugin-recover.js`）：拿最近一次身份为 `known-good` 的备份里该插件换回现场。
  - 备份有 `node_modules/<name>` 真副本 → `overwrite`：现场目录**改名**为 `<name>.broken-<ts>`（**留证据，绝不删除**），副本拷回去；
  - 备份只有 `node_modules-link/<name>`（链接安装的内容）→ `replace-link`：现场软链同样**改名留证据**，备份内容顶替（与既有 force 语义一致）；
  - 备份里没有 / 插件不在本 profile 启用清单里 → `no-backup`：**不动**，写清原因。
- **幂等**：拷贝前先比现场与副本（相对路径 + 大小 + sha256）；一致就 **不拷、不重启**，决策记 `already-consistent`。
- **防循环（硬要求）**：
  1. 同一份旧日志不许被当成新故障 —— 只读**上一次启动**那份日志（本次启动写的那份还不可能有自己的审计结论），行时间早于该次启动的一律不算，再用「插件 + 错误首行 + 日志时间」做**指纹**，指纹进 `plugin-recovery.json` 的 `handled` 后只能处理一次（再遇到记 `duplicate`）；
  2. 根因不在插件（缺 peer 依赖、缺宿主能力）时换回也没用 —— **同一插件一个周期内只动手一次**，第二次只报不动、`needs-human`，且**不请求重启**。一次没有任何插件故障的启动会把周期清零。理由更正确：恢复是拿好版本顶替现场，恢复完现场就是好代码，所以**不存在"越修越坏"的循环**，真正的循环只有上面两个。
- **只改过文件才重启**：`no-backup` / `duplicate` / `already-consistent` / `needs-human` 四种情况的 `restartRequested` **恒为 false**（有单测钉住）。重启走**现有入口** `requestRestart`（同一个 gate / 快照 / 续跑），**没有第二套重启机制**。
- **接入启动流程**（`index.js`）：启动后、写 ready 标记之前跑一次 —— 读日志 → 检测 → 计划 → 恢复 → 写 `<stateDir>/last-plugin-recovery.json`（`{ at, atIso, failures[], actions[{plugin,mode,restoredFrom,restoredAt,backupKind}], restartRequested, needsHuman }`，其中 `restoredAt` / `backupKind` **取备份自己的 meta**，回答"恢复到了哪个时点"）。
- **可见**：health 路由新增 `pluginRecovery` 字段（没发生过就是 `null`），`continuum_status` 工具同样返回它，并**同步写进工具 output schema**（严格 schema 下漏声明一个字段会让整个工具报废）。

#### 分工（写进 README 与中文 README）

| 故障 | 谁负责 |
|---|---|
| 进程级：宿主起不来 | 重启前快照 + 看门狗（`lib/watchdog.js` / `lib/restart.js`），回滚 + 拉起 |
| 报错型：宿主起来了、某个插件没激活 | 本条：检测 + 换回好版本 + 一次重启 + 报告 |

两条路径不共享状态、不互相触发：`pluginRecovery` 只描述"报错型"的事。

#### 验证

- `node --test plugins/dsh-autorestart/test/*.test.mjs` → **1067 / 1067 全绿**（基线 1017，本次 +50）。
- 新增单测：`test/plugin-failure.test.mjs`（四种行、无关文本 → 空数组、进程级转储 → 空数组、`sinceMs` 窗口、指纹稳定/去重、超长截断）、`test/plugin-recover.test.mjs`（四条分支、改名参数断言、幂等、attempt=1 允许 / attempt=2 拒绝、报告字段与 meta 来源、日志挑选）、`test/integration.test.mjs` 追加 10 条（端到端恢复与报告、四种"不重启"、只读上一轮日志、health 字段与工具 schema）。

### 链接安装的插件现在也进备份、也能被还原

#### 缺口（实测发现的真问题，不是为实验造的）

profile 的 `node_modules` 里有 **5 个插件是符号链接/联接**（`dsh-autorestart`、`dsh-codekg`、`dsh-github-guard`、`dsh-release-board`、`dsh-secret-vault`，都指向 `Documents\deepseek-harness\default-workspace\plugins\<name>`），而身份为 `known-good` 的备份里 **118 个真副本、0 个链接插件**：备份把链接本身记下来了，链接**背后的内容一个字节都没有**。后果是**负责救命的 dsh-autorestart 自己也救不回来**。

#### 现在

- **备份**（`lib/backup.js`）：新增 `collectLinkedPlugins`（只收 `dsh.profile.bundles` 里启用的、指向目录的 reparse point），`manifest.json` 新增 `links: [{name, target, kind, exists, readable, copied, files, bytes}]` + `linkFiles` / `linkBytes`，链接的**内容**另存 `node_modules-link/<name>/`（不和真副本混在一起）。本机实测 5 个插件 1216 个文件 / 69.5 MB。清单只加字段、不改名 —— 三个读者（还原脚本、看门狗、`lib/rescue.js`）都不受影响。
- **还原**（`scripts/restore-profile.ps1`，仍是纯 ASCII 无 BOM）：新增 `-ForceLinkPlugins` 开关；**默认档**保留健康的链接（开发目录继续“改完即生效”），**force 档**用备份内容顶替。每个链接插件都打印一行结论 `kept` / `replaced` / `target-missing` / `no-backup`（**不许静默跳过**），顶替原因写进 `links-restore.txt`。
- **看门狗**（`lib/watchdog.js`）：和脚本共用同一套判定（`decideLinkRestore`）——目标不存在/读不了 → 顶替；**第一次给链接一次机会，`attempts >= 2` 就顶替**；没有副本 → 不动它（**绝不删掉放不回去的东西**）。
- **顺手修掉两个真机踩到的坑**：
  - `fs.cpSync` 往一个**带死链接**的 `node_modules` 里写会直接把 Node 进程打死（Windows，`0xC0000409`，无栈无消息），而 `fs.existsSync` 对死链接返回 **false** —— 现在先按 `lstat` 认出死链接、清掉再复制；
  - `rescue-strings.zh.json` 的 `restore.snapshotSuffix` 有 2 个占位符、调用只传 1 个参数 → 快照配置坏了的时候脚本不是报「这份快照不是 profile」而是格式化报错直接挂掉。

### 2026-11-03 桌面档演练失败与三处修正

**演练失败读数（12:49:19 → 12:51:51，原样）**：12:49:19 的 `last-watchdog-report.json` = `result: armed`、`tier: none`、`arbiter: v1`、`armOutcome: failed`、`armError: null`、`armFailedSteps: []`；`watchdog-pending.json` **从未出现**；12:49:25 新宿主读坏清单崩溃（**崩溃日志本机找不到**：`.dsh` 全树按 12:45–12:55 扫描只看到 `clear-cookies.log` 与 `last-cookie-clear.json`（均 12:49:24）、`restart-276.cmd` 与 `restart-gate.json`（均 12:49:19），`.dsh\logs` 里最新的启动日志停在 10-31）；12:51:51 兜底计划任务 `LastResult = 1`、**脚本一行没跑**；之后两次手工跑 `restore-profile` **只还原了 `config/`**，`node_modules` 没还原 → 插件全丢。

**三处修正**：

- **布防不再依赖清单**（t65 → 收口 t66）：布防阶段不再需要读那份可能已经坏掉的清单。全量 **1451 / 1451**；新增测试 **3** 条；证伪 A / B / C / D；CodeKG `diff ok`、verify **70 / 70**。
- **体检 → 按需修复**（t67 + t69）：`lib/profile-health.js` 给出**三种答案**；**只补缺的**，改完**回读**，**幂等**；还原脚本支持 `-CheckOnly`；看门狗判定 fine 时**不还原**；补 parity 测试，证伪「只改一边 → parity 必红」。自跑 verify **64 / 63 / 0 / 1 skip，exit 0**。
- **报告不再说假话**（t60–t62）：看门狗**每落地一个事实就写一次进度报告**，撤防按「是否真的救过」判 `recovered` / `disarmed`，不再把 `restored` / `relaunched` 抹成 `false`。

**一条纪律（写下来，别再犯）**：**在用户正在使用的 profile 上做「注入坏清单」演练本身不成立**——故障材料与布防材料是同一份文件，注入故障等于把布防材料一起弄坏。以后**只许在隔离实例上做**，且**故障必须出现在布防之后**。

### 2026-11-03 隔离 WSL 实例上的复验（t71–t74）：布防 → 还原 → 拉起走通了

桌面档演练失败之后，同一天在**隔离的 WSL 实例**上重做了这件事（WSL `Ubuntu-22.04` / 用户 `fg`；profile `~/.dsh/profiles/web`，链接安装；状态目录 `~/.dsh/storages/dsh-autorestart`；守护循环 `~/supervise-web.sh`；布防入口 `POST /__dsh_autorestart/park`，**body 必须带 `{"sessionId":"…","restart":true}`**，否则只答 `restartRequested: false`）。

- **布防成功（t71 → t73）**：坏清单下 `watchdog-pending.json` **出现了**（t+10s…t+240s 每次采样 `pending=YES`），报告 `result: "armed"` / `armOutcome: "armed"` / `armError: null` / `armFailedSteps: []`（旧代码是 `armOutcome: failed` / `tier: none` / `armFailedSteps: ['there is no profile directory to restore into']`）。
- **布防要拿 profileDir，而 profileDir 也是从清单推出来的（t72 + t73）**：真机读数 `error: the profile directory is unknown` → 宿主每次**成功启动并确定 profileDir 之后**把它作为**事实**持久化（复用既有 `state.json`，带 `at` 与来源）；布防按 **运行时内存 > 持久化记录 > 快照** 三条取路，三条都失败时把**各自的原因**逐条写进 `armFailedSteps`。修完：`state.json` 里出现 `"profileDir": { "dir": "/home/fg/.dsh/profiles/web", "at": 1793690696061, "source": "profile bundles scan" }`（旧代码没有这项），布防 `armOutcome: "armed"`。
- **快照失败不再关掉还原点（t74）**：快照失败时仍然对既有副本调用 `selectRestoreTarget`，挑不到时把**拒因逐条写清**并给下一步。真机读数（15:43:00–15:47:29）：`restored: true`、`restoreTarget: /home/fg/.dsh/storages/dsh-autorestart/backups/2026-11-03T04-16-19-152Z`（磁盘上 `intervention=false`、`boot={started:true, contentMatched:true}` 的那份）、`restoreBlocked: false`、`restores: 1`、`error: null`、`restoreCandidates: [{name: "2026-11-03T04-17-07-466Z", exclusion: "intervened"}]`；**t+250s：`listening=1`、`manifest=3120c71a90877bfc…`、新 bootId `bb888192-b3c3-40c2-88a3-b8a1e45a1bef`**；清单 sha 回到原件、**不需要手工放回**、health `{"ok":true,…}` → **实例已恢复正常**。
- **两处口径如实说明**：报告里的 `restoredFrom` 仍是 `null`（这份报告用 `restoreTarget` 承载「还原自哪一份」）；`relaunched: false` —— 宿主是**自己回来的**（守护循环在它起来后把看门狗撤防了）。
- **全量**：**1475 / 1474 pass / 0 fail / exit 0**；CodeKG `diff ok`（27 处改动全部在 allow 内）。

**本轮未实测 / 未观察到的（如实列出）**：`@goodandready/dsh-goal@0.2.33`、`dsh-dispatch-guard@0.2.1` 本轮**未实测**（证据库里没有它们的记录）；**POSIX parity 在本机被 skip**（本机没有 POSIX shell）。

**文档**：两份实测文档合成一份 —— 看门狗各轮真机读数（R1–R55）**全文并入** `docs/real-machine-verification-0.8.6.md`，原文读数逐条保留，原来标着「未验」的仍然标着未验；`npm` 描述里那句「起不来就还原」也收窄成「**这次重启**没回来才还原」。

### 2026-10-30 的首批改动

#### 看门狗：修掉「只许跑一次 / 拉起前不通行证 / 报告不落盘」三个毛病（用户拍板：只改看门狗，守夜人不进主线）

- **① 看门狗任务用真 node 启动，不再拿客户端当解释器。** 注册一次性任务时原来是手拼命令：`'"' + process.execPath + '" "…watchdog.mjs" …'`。在桌面版里 `process.execPath` 就是 `DeepSeek Harness.exe`（Electron 客户端），于是这个"看门狗"每次都会**再开一整个客户端**，看门狗根本没跑过。现在统一走 `buildWatchdogTaskCommand`（`lib/watchdog-schedule.js`）：解析到**真 node**（进程本身是 node → 安装目录自带的 runtime node → PATH），解析不到就**拒绝注册**并把原因写进日志，**绝不退回 exe**。Windows 计划任务把程序与参数交给 XML 的 `<Command>` / `<Arguments>`（不再 `cmd /c` 套壳，引号不会被吃掉）；systemd 那档拿 `[node, script, --state-dir, …]` 数组；detached 那档拿按 `CommandLineToArgvW` 规则加引号的命令行。
- **② 每一轮拉起之前先清 `dsh-auth-*` 通行证 cookie。** 清理顺序固定在 `lib/watchdog.js` 里：还原快照 → **清 cookie** → 拉起 → 等 ready。带着 71 个过期 cookie 拉起来就是再死一次（Cookie 头撑过 16 KB → 431 → 客户端报 "Web authentication failed"）。清理脚本永不阻塞救援（自己 exit 0），但**结果一定写进报告**：清不掉绝不能看起来像清过。
- **③ 失败也一定落报告。** 无论 recovered / not-needed / abandoned / decided / failed / 次数用尽，每一轮都写 `<stateDir>/last-watchdog-report.json`（哪一档、`healthCheck`、试了几次、每次的 `restored` / `cookieClear` / `relaunched` / `ready` / 退避、以及为什么停）。
- **可在有上限的次数内重试，不再"只许一次"**：`maxAttempts`（默认 **3** 次，硬上限 **10** 次 —— `lib/watchdog.js` 的 `DEFAULT_MAX_ATTEMPTS` / `MAX_ATTEMPTS_CEILING`）声明在 pending 标记里；每轮开始前重新问那三个问题（ready / 有实例活着 / health 应答），两次尝试之间的退避是 **15s → 45s**（封顶 45s，`DEFAULT_BACKOFF_MS = [15000, 45000]`；尝试次数更多时沿用最后一档）。快照只在第一轮还原（同一快照再拷一遍改变不了什么），**cookie 每次拉起前都清**。

#### cookie 清理：可覆盖 / 可观测 / 可自证

- **删除条件放宽**：`host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'`，**不再要求 `path = '/'`**。官方代码总是写 `Path=/`，但漏删一个 cookie 它照样会发到 127.0.0.1、照样占满 16 KB 头；多删一个的代价只是一次重新登录。
- **可观测**：清理脚本把结果写成 `<stateDir>/last-cookie-clear.json`（`{at, atIso, ok, removed, reason}`，`.tmp` + rename 原子写），插件健康路由新增 `cookieClear` 字段暴露「上次清理结果」。**不谎报当前 cookie 张数**：运行中的浏览器锁着 cookie 库，所以 `live` 恒为 `null`，`liveNote` 写明原因；"还没清理过"和"清理失败"是两个不同答案，都不当成成功。
- **可自证**：版本号升到 **0.8.6**；`health` 的 `version` 与 `package.json` 一致（`pluginVersion()` / `PLUGIN_VERSION_FALLBACK` / 包版本三者对齐，有单测钉住），真机上一眼能看出新代码是否真的被加载。

#### 覆盖边界（这次也写进 README 与中文 README）

看门狗是一个**窗口**，不是常驻保安：它只在**我们自己要重启宿主**的那一刻布防，宿主起来后立刻撤掉。**窗口之外没有任何人看着** —— 凌晨被系统杀掉的宿主、手动双击启动即崩的客户端、早上发现 0 进程，都不会被拉回来（插件随宿主一起死了，也没有一次性项被注册过）；那时只剩 `scripts/restore-profile.cmd` 可以手动双击。看门狗也只还原一份快照 + 拉起宿主，修不了宿主自己的 bug。

> 覆盖"窗口之外"的常驻守夜人（0 进程 + profile 被 `sanitizeProfile` 清空）在本仓库里是一份**未接线的备用件**（`lib/sentry.js` / `lib/sentry-install.js` / `supervisor/sentry.js`，见 `docs/sentry.md`）：**不注册任何工具、不会自动安装、没有 clean-exit 钩子**，启用需要另开任务。

## 0.8.5 — 2026-10-30

### 备份

- **每份备份都有身份，自动回滚只认其中一种**（用户决定，2026-10-30）：备份目录里多了一张 `meta.json`，把每份拷贝标成 `known-good`（这份是在一次重启之前拍的，而那次重启的健康检查后来应答了）/ `snapshot`（本次快照）/ `unknown`（旧备份，身份层之前的）。身份记的是「拍完之后发生了什么」，不是对插件可用性的评价。第一次安装时种子一份 `known-good`；每次启动后健康检查应答时，把这次重启前拍的那份提升为 `known-good`；重启失败时只回到最新的 `known-good`——**本次快照永远不会被当成回滚目标**，因为它可能正是坏掉的那一份（改坏插件再点重启就是这个场景）。
- **没有可回滚的身份就不动任何文件**：回滚前先找 newest `known-good`，找不到就零还原，报告里写 `no-known-good: <原因>`，看门狗也不 arm（没有可还原的目标，挂上去只会再写一遍坏配置）。
- **保留 3 份，其中一种身份不参与 prune**：默认 `maxBackups = 3`，超出删最旧的那份，但 `known-good` 不会被 prune 掉。
- **旧备份不会被自动回滚**：没有 `meta.json` 的拷贝（身份层之前的版本）标成 `unknown`，只展示、不参与自动回滚。
- **设置页看得见身份**：备份列表每行先写「身份 · 版本」（`known-good` / `snapshot` / `unknown`），下面是原有的时间与大小；列表上方加一段中文说明，讲清三种身份各自记录了什么、看门狗只还原 `known-good`、第一次安装会种子一份、最多保留 3 份、`unknown` 不会被自动回滚、手动回退会先二次确认再重启。`?state=1` 与 `health?state=1` 的 `backups.items[]` 因此多了 `kind` 与 `version` 两个字段。（0.8.6 起备份列表的行上**不再显示**身份与版本，也不再显示每份的大小——用户决定 2026-11-02，理由是不由插件判定哪一份安全；一行就是「备份时间 + 回退到这一份」，总占用改成列表上方的一句汇总「实际占用 {size}，当前 {n} 份」。`kind` / `version` 仍由宿主给出、仍供自动回滚读取。）
- **可以手动回退到任意一份备份**（含更早、后面没有启动记录的那份）：列表每行多一个「回退到这一份」按钮，点了先弹二次确认（写清还原哪一份、当前状态会被覆盖、还原后会自动重启），**确认后才动**；取消则什么都不发。服务端新增 `POST /__dsh_autorestart/rollback-to`，只接受**备份目录名**（必须是本机列表里的那一份，路径 / 路径穿越直接拒绝），顺序是：①先把当前状态存一份快照（`reason: before-manual-rollback`，所以这次回退本身还能再退回来）②还原选中的那份 ③写 `last-manual-rollback.json` 回执（何时 / 哪一份 / 结果 / 第 ① 步存下的那份快照）④走既有重启流程请求一次重启（插件自己绝不 kill 进程）。当前状态存不下来、或看门狗正持有回滚锁时直接拒绝（409），不会出现「还原了一半」。

### 现场

三次真机反馈说的是同一件事：**浮层说的不是真话**。先是重启被打断、备份早就结束了，「DSH 重启前备份中」却一直挂着不消失；修完这个，又出现备份做完后**整整 25 秒**界面（浮层和底部胶囊）一起说「正在重启…」而实际什么都没在重启——宿主把重启交给了 detached helper，helper 还在等自己的空闲复查，被拒之后才把阶段改回等待；再后来是「被打断之后我还有大活要干，一直悬浮很烦人」。

### 修复

- **阶段必须有去有回**：新增 `deferRestartStage()`，把「重启被推迟」的每一条路径都写成 `waiting`：闸门回收（又有会话忙）、detached helper 拒绝杀进程、重排重试、helper 调度失败；记录里带 `reason`（`deferred: conversation-active` 之类），事后能看出是推迟而不是在跑。放弃重启时一并清掉阶段。
- **`snapshotting` 只在真拷贝期间存在**：备份函数一返回（拷完 / 取消 / 抛错），阶段立刻离开 `snapshotting`——拷完就标 `restarting`，取消就清空，抛错就走推迟。以前从拷贝结束到真正执行重启之间那一整段（arm watchdog、写判定记录、调度 helper）都还挂着 `snapshotting`，一旦推迟就再也回不来。
- **`restarting` 只表示「即将 / 正在杀进程」**：备份一结束、标记它**之前**先当场复查一次空闲门，被挡就在同一次 tick 退回等待（`deferred: conversation-active after snapshot: …`），命令行不跑、watchdog 不 arm；进入 `restarting` 之后（等 helper / 等调度）**每 350ms** 复查一次，一有会话忙立刻降级回等待（`deferred: conversation-active while restarting`）并重新排上——几十秒的假 `restarting` 窗口没有了。
- **残留中间态不许跨进程继承**：启动时读到 `snapshotting` / `restarting` 一律改写——新进程起来是 `back`，同一进程里插件重载则是 `waiting`（`reason: boot: …`）。
- **同一次重启请求不重复备份**：快照是这次重启的回滚点，不因为重启要等待就作废。请求里记下本次已完成快照（`state.restart.snapshot`：请求时刻 + 目录 + 体积/文件数），重试时三个条件都满足就直接复用——**同一请求**、**目录还在**、**manifest 体积对得上**；任一不满足才重新拷贝。请求被取消 / 完成，标记随请求对象一起消失，下次重新备份。用户那次 205 MB 白拷一遍的事故不会再有。
- 新增 `restartPhase.reason`（状态路由与 health 简报都带）。

### 界面

- **被暂缓就说被暂缓，绝不说「正在重启」**：`waiting` 且 `reason` 以 `deferred:` 开头时，浮层文案是「**有新会话在跑，重启已暂缓**」+ 小字「等它结束会自动继续 · 已等 N 个会话」（英文 `A conversation just started — restart postponed` / `It will retry automatically when idle`）；渲染优先级最高，同一次渲染里阶段还写着 `restarting` 也直接画暂缓文案，旧词一帧不留。「正在重启…」只在真的进入杀进程阶段才出现。
- **暂缓卡片是通知，不是进度条**：显示 **4 秒**后自动收起（胶囊继续显示「待重启 · 等待 N 个会话」），新的暂缓（新的阶段时间戳）会再通知 4 秒；「备份中」「正在重启…」不受影响，活儿还在就一直显示。
- **陈旧保护**：`snapshotting` 必须 10 秒内有过更新（拷贝期间每个进度 tick 都刷新 `at`），任何中间阶段 15 秒内 `at` 没变就当过期，**直接不画**。
- **状态轮询跟着状态提速**：重启进行中（`pendingRestart` 且阶段是等待 / 备份中 / 正在重启）时，共享轮询从 2 秒临时降到 **500ms**，被新会话打断这件事一秒内就能反映到浮层；重启结束立刻恢复 2 秒。页面隐藏时不轮询，可见性恢复立刻补查一次；同一时刻只允许一个在途请求。

### 文档

- **npm 一句话描述换成新口径**（`package.json` 的 `description`）：原来只讲「等空闲→重启→续跑」，现在把「重启前快照 + 起不来自动还原 + 倒计时关机 + Windows 桌面 / 托管 dsh web（Windows / WSL / Linux）都可用」一起讲清；这句是 npm 搜索结果那一行，**必须随新版本发布才生效**。
- **README（英）/ docs/README.zh.md 补行为说明**：被打断时显示「重启已暂缓」而不是「正在重启」、暂缓卡片 4 秒后收起、阶段超过 15 秒无更新视为过期不再显示（胶囊仍显示等待数）。

### 验证

- `node --test plugins/dsh-autorestart/test/*.test.mjs` → **全绿**（细节见本次提交说明）。
- 宿主侧新增用例：拷完被拒的重启最终是 `waiting` 且 arm watchdog 那一刻已是 `restarting`；helper 门禁拒绝后阶段回到 `waiting`；另一进程残留的 `snapshotting` 不带进新进程；同进程重载残留的 `restarting` 被重置；备份完成后会话立刻变忙 → 同一次 tick 就是等待；`restarting` 期间会话变忙 → 守卫回调一触发即降级（复查周期断言落在 300–500ms）；备份完成 → 暂缓 → 重试**不产生第二个快照目录**且 `snapshotBytes` 不变；取消后重新请求 → 重新备份；快照目录被删 → 重新备份。
- 界面侧新增用例：15 秒 / 10 秒陈旧边界；`snapshotting` 15 秒无更新不渲染、3 秒内有更新正常渲染；`waiting` + `deferred:` 渲染「重启已暂缓」且不含「正在重启」（中英各一条）；真 `restarting` 仍「正在重启…」；降级后下一次渲染即改口；暂缓卡片 4 秒后收起、再暂缓再出现；运行中的卡片不会被收起；轮询 500ms / 2000ms 切换、隐藏页不发请求、慢响应单飞。
- 真机复现路径由主会话验证（打断一次重启，看浮层是否立刻改口、是否 4 秒后收起、重试是否不再拷一遍）。

## 0.8.4 — 2026-10-29

**只改文档与版本号，行为没有变化。**

### 文档

- **README（英）/ docs/README.zh.md 补齐 0.8.3 的真实界面行为**（npm 页面上原来还是 0.8.2 时代的旧描述）：
  - 重启阶段显示在**主界面居中浮层**（centered overlay card），**只排队等空闲时不出现**，只在真的备份 / 重启时出现，回来显示 1.5 秒后消失；
  - 胶囊只有**一句短话**（≤12 字），长句降级为 tooltip，详情在点开的面板里；
  - 备份进度是**真进度**（MB + 百分比），单位自适应（`92 KB` / `156 MB`），**备份快就一闪而过、不人为拉长**；
  - 设置改动有回执：保存成功后**设置在面板内部顶部**（面板自己的 sticky 条）显示绿色「已生效 / Saved」+ 时间，3 秒淡出；失败红色「没保存成功 / Not saved」并保留宿主给的原因；
  - 备份列表改成两行：`备份时间 / Backup time 2026-10-29 22:08`、`备份大小 / Backup size 156 MB（含已装插件 / plugins included）`，**不显示时区偏移**。
  - 槽位表补上 `shell.overlay` 里的重启阶段浮层，并说明保存回执渲染在设置面板内部（不占窗口级浮层）。

### 版本号

- `package.json` 与 `index.js` 的 `PLUGIN_VERSION_FALLBACK` 同步到 **0.8.4**，两份 README 的「当前版本」同步。

## 0.8.3 — 2026-10-29

**重启阶段搬到界面正中：不再挤在输入框那一行被截断，靠数字说话，也不是常驻。**

### 现场（真机截图）

阶段那行字挤在输入框工具行的小胶囊里（22px 高、一行宽）。窗口不宽时「正在等待所有会话空闲…（还有 1 个会话在忙）」被省略号吃掉，用户看不出卡在哪、还要不要等。另一次截图里浮层上的「等待会话空闲」挂了十分钟不消失——那笔重启只是在**排队等空闲**，其实什么动作都没在跑。

### 改

- **阶段改为主界面居中浮层**（`shell.overlay` 槽位，id `autorestart-restart-overlay`）：320px 固定宽、水平垂直居中、圆角、半透明，`pointer-events: none`——点哪里都照样点到下面的界面，不挡输入。
  - `snapshotting`：「DSH 重启前备份中」+ **真实进度条** + 「12.3 / 40 MB」+ 百分比（数字来自拷贝循环的实测字节，没测到就一个数字都不写）；
  - `restarting`：「正在重启…」，一直挂着，直到宿主真的退出；
  - `back`：「已回来」，**1.5 秒**后自动消失；
  - `waiting`：**浮层不出现**——只是排队等空闲，没有任何动作在跑，会话数交给胶囊去说；
  - state.json 里残留的旧阶段（`pendingRestart === false`）和页面的第一帧，都**不画**。
- **窄窗按字号缩放，不截断**：浮层里没有 `text-overflow`、没有省略号、不换行；窗口不够宽时用 `clamp()` 缩字号，数字永远完整可读。
- **底部胶囊恢复短句**（≤12 字、单行）：等空闲时「待重启 · 空闲后自动重启」/「待重启 · 等待 N 个会话」；备份中 / 重启中 / 回来时整行换成「重启前备份中」/「正在重启…」/「已回来」。长句只留 tooltip，细节全部交给浮层。
- **胶囊与面板的数字同源**：修掉「胶囊说还有 1 个会话、点开面板却说等 0 个任务」。两处现在读同一个 `blocking` 数字——Host 在 `restartPhase.blocking` 里单独报出它，不再只藏在句子中。
- **设置修改有回执**：改完设置，面板里给回执——成功是绿色「已生效」+ 时间；失败是红色并保留原因、不自动消失。
- **回执贴在设置面板内部顶部**（`position:sticky` + `top:0`，往下滚动设置内容也一直可见；条高 30px，覆盖不挤压表单），不再浮到窗口层——`shell.overlay` 上那条注册已删，提示只出现在本插件的设置页里，关掉设置页即清空。
- **口径统一**：悬停提示里的「任务」改成「会话」（英文 session(s)），和胶囊、面板保持一致。
- **体积按大小自动选单位**：一份 92 KB 的 profile（Web/WSL）如果按 MB 印就是「0 MB」甚至「0.0 MB」，等于把一次真的备份说成什么都没干。现在 `92 KB` / `156 MB` / `12.3 MB` / `0 B` 各按大小选单位，进度行两侧也各带单位（`12.3 MB / 40 MB`）。浮层**没有任何保底显示时长**：备份快就一闪而过，慢就一直在，出现与消失完全跟随真实阶段（用户拍板：「浮层不用保底时间，短就算了，不用硬加长」）。Host 侧 `restartPhase.snapshotBytes` 仍跨阶段记录真实体积，供界面与诊断使用。
- **说清是什么备份**：光看「正在备份」看不出备份的是什么，所以浮层改成「DSH 重启前备份中」、胶囊改成「重启前备份中」（英文 "Backing up before DSH restart" / "Backing up…"），进度条与 MB 数字不变。设置页与 tooltip 那句长句也一起改成同一个说法：「DSH 重启前备份中（预计 X 秒，已完成 Y MB）…」（英文 "Backing up before DSH restart (about Xs, Y MB done)…"），「慢就明说」那条也把主语补成「DSH 重启前备份比预期慢…」，全产品不再出现孤立的「正在备份」。

### 验证

- 单元测试 **760 → 801 项全绿**（新增 `test/restart-overlay.test.mjs` 19 条、`test/settings-save-notice.test.mjs`、`test/pill-count-source.test.mjs`）。
- 两个演练仍是 exit 0：`node scripts/drill-watchdog.mjs`、`powershell -File scripts/drill-rescue.ps1`。
- 客户端 bundle 仍是整文件一个 IIFE（`test/client-bundle-isolation.test.mjs` 守着）。

## 0.8.2 — 2026-10-29

**线上缺陷修复：宿主起来之后没有撤销看门狗，会把好环境回滚掉。**

### 事故现场（真机，19:19–19:21）

触发重启 → `watchdog-pending.json` 写入、`dsh-autorestart-watchdog` 计划任务注册成功、报告写 `armed`；新宿主 19:20:20 起来，health 连打 3 次都是 200；**但 `watchdog-ready.json` 从头到尾没出现**，`watchdog-pending.json` 还在、计划任务还在 `Ready`。当时是人工 `Unregister-ScheduledTask` 拆掉的——没人管的话，90 秒后它会还原快照并再拉起一个实例，**把一个健康的环境回滚掉**。

### 根因（已复现）

health 路由里那段"写 marker + 撤看门狗"的代码读的是 `stateDirOf()`——那是 runtime 工厂内部的闭包变量，**模块级函数根本看不见它**。所以每次请求都在第一行就抛 `ReferenceError: stateDirOf is not defined`，外面那个 `catch {}` 把异常吞了：路由照样回 200，marker 没写、pending 没清、计划任务没删，任何地方都没有痕迹。

- 复现方式：用测试上下文调真实的 health 路由，断言 marker 出现——旧代码失败（`ready written: false`）。
- 同源的第二个坑：`clearPending` / `readPending` 当时也没被 import，`armWatchdog` 注册失败的回滚分支同样会抛 `ReferenceError`。

### 修

- **health 路由不再靠闭包**：状态目录改由 `runtime.stateDir` 提供（`runtime` 上新增 `stateDir` / `pluginVersion`）。这类"路由看不见工厂内部变量"的错误从此没机会重演。
- **撤销拆成独立模块**（`lib/watchdog-disarm.js`），三件事分开做、都留痕：
  1. **先写 ready marker**（同步、read-back 校验）——它是唯一能阻止回滚的东西，绝不再依赖计划任务是否删成功；
  2. 清 `watchdog-pending.json`；
  3. 按 pending 自己写的 tier/taskName 删调度项（不再硬编码名字），删完**回查**（`schtasks /Query`）确认真的没了。
- **失败必须重试并留痕**：默认 3 次、退避 120ms/240ms；每次失败都带 `error.name` + `message`，写进 `watchdog-disarm.json`、health 响应、诊断文本（"报告一个问题"），不再静默。
- **开机就撤销，不等任何人来问**：`apply()` 里注册完路由立刻跑一次 disarm。即使一次 health 都没人打，宿主起来就会把看门狗撤掉；health 路由仍是第二道保险（后台清理，不拖慢响应）。
- **兜底（最要紧的一条）：看门狗回滚前必须自己问一次 health**。`runWatchdogFlow` 新增 3b 步：直接 HTTP 问 `127.0.0.1:<port>`（端口依次取实例记录 `access.json`、pending 里的 port、旧 `healthUrl`），**只要有一台在应答就绝不回滚**（`result: not-needed`）；一个端口都问不到时，额外再等一轮、复查 ready marker 与 pending，仍然没动静才允许回滚。
- **顺手修掉的版本号 bug**：runtime 里那份 `pluginVersion()` 读的是 `../package.json`（插件目录的上一层），永远返回 `unknown`；health 于是把 `unknown` / 硬编码常量当版本报出来。现在统一走模块级读取，`health.version` 是真正加载的版本。

### 演练

`node scripts/drill-watchdog.mjs` 从三个场景扩到**四个**，新增：

- **场景 ④「宿主起来了但没写 ready marker」**（就是这次事故）：假宿主只应答 health、绝不写 marker，并且**真实注册一个 Windows 计划任务**；断言 watchdog `result: not-needed`、`healthCheck: healthy`、**一次还原都没有**、pending 已消失、**计划任务真的被删掉**（`schtasks /Query` 查不到）。

### 重启阶段化 UI（同版发布：点下去 1 秒内就有反馈，备份有真实进度）

用户反馈："点『0 秒后重启』之后十几秒什么都不动，其实在备份 156MB，我会以为按钮没反应 / 0 秒是假的 / 有 bug。"

- **四个阶段立刻可见**：`waiting`「正在等待所有会话空闲…」→ `snapshotting`「正在备份配置和插件（预计 X 秒，已完成 Y MB）…」（0.8.3 起改为「DSH 重启前备份中（预计 X 秒，已完成 Y MB）…」）→ `restarting`「正在重启，稍后自动继续…」→ `back`「已回来，接着干」。阶段写在 checkpoint（`restartPhase`）里，点击的**同一次调用**就把 `waiting` 落盘并 persist，界面下一次轮询（2 秒一次，且点击后立即再拉一次）就能看到。
- **备份进度是真的**：`createBackup` 改成**文件级拷贝循环**（原来是 `fs.cpSync` 一次性拷完，既没进度也不能取消），边拷边报 `{ files, bytes, total }`，`total` 是拷之前量出来的真实总量；拷贝过程**每 120ms / 每 40 个文件让出一次事件循环**，所以取消请求能在拷贝途中被服务，进度也能在拷贝途中到界面。
- **备份阶段可取消**：取消后拷贝在下一个文件处停下，**半成品快照目录被删掉**（不留一个看着能还原的假备份），请求被撤回、宿主不重启；**进入 `restarting` 后取消被拒绝**（HTTP 409 + `reason: not-cancellable` + 原因），界面按钮置灰并说明"正在重启，已经不能取消了"。
- **两处都能读到**：`/__dsh_autorestart/health?state=1` 与 `/health` 都带 `restartPhase`（阶段、双语文字、可取消性、`slow`）和 `progress`（files/bytes/total/percent/ageMs）。
- **慢就明说**：备份超过 300 秒，或字节数 60 秒没动 → 显示「备份比预期慢（可能磁盘很忙），还在继续…」，绝不假装正常进度。
- **界面**：composer 那颗 pill 多一行阶段文字（含进度），设置页「重启设置」组标题下常驻一行同样的状态（pill 只在有待办重启时出现，设置页那行一直都在）。

### 验证

- 单元测试 **740 → 753 项全绿**（新增 `test/watchdog-disarm.test.mjs`：事故复现、开机自动撤销、marker 读写与 read-back、失败/重试/留痕、按 pending 选调度项、诊断文本、流程里"健康就不回滚"、问不到端口多等一轮）。
- 阶段化 UI 再加 **`test/restart-phase.test.mjs`（6 项，累计 760 项全绿）**：①点击后 1 秒内可读到 `phase='waiting'`（含 state 文件与 state 路由两处）②备份中 `progress.bytes` 单调增长且等于最终写入量 ③备份中取消 → 半成品目录消失、宿主没重启、请求被撤回 ④`restarting` 阶段取消被 409 拒绝并给出原因 ⑤慢拷贝两种文案 ⑥里程碑：健康拷贝报真实 MB 与预计秒数、没有测量前不报任何数字。
- 演练四场景 + 三档调度真机触发全部 exit 0。

## 0.8.1 — 2026-10-29

**修复打包遗漏**：0.8.0 的 npm 包按 `package.json` 的 `files` 白名单打包，而那份白名单只收了 `scripts/*.ps1` 与 `scripts/*.cmd`——**三个 POSIX 自救脚本（`restore-profile.sh` / `emergency-disable.sh` / `drill-rescue.sh`）、`scripts/README.md`、`scripts/rescue-strings.zh.json` 全都没进包**。Linux / WSL 用户装完 0.8.0 后，文档让他去双击/运行 `scripts/restore-profile.sh`，那个文件却不存在。

现在把白名单补齐（`.sh`、`.mjs`、`scripts/README.md`、`scripts/rescue-strings.zh.json`、`CHANGELOG.md`），并用 `npm pack --dry-run` 逐项确认：**54 → 61 个文件**，三个 `.sh` 都在。单元测试 740 项仍全绿。

0.8.0 的内容与行为没有其它变化；只是那个包缺文件。

## 0.8.0 — 2026-10-29

这一版把"出事之后怎么办"做成真正的闭环：**起不来就自动还原、再拉起、留下报告**，并且桌面端与各种 Web 托管端（Windows / Linux / WSL）都覆盖。

### 新增

- **看门狗（watchdog v2）**：重启前登记一个一次性监护者；新实例按约定报到就算过关，否则**先复查一次**（防误判），确认真的没起来才**自动还原重启前的快照 → 再自动拉起一次 → 把结果写进报告**。最多还原一次、拉起一次，绝不死循环；回滚前先探活，绝不双开。
- **三档调度，跨环境都可用**：Windows 一次性计划任务 → Linux/WSL 的 systemd-run → 自建后台进程（setsid nohup）。都没有时**明确告知"没有自动回滚"**，绝不假装有保护。
- **同一时刻只有一个监护者**：v2 可用时不启动旧的 v1；v2 不可用时才回落 v1；报告里记 arbiter 字段，出事能一眼看出当时是谁在监护。
- **POSIX 版自救包**：restore-profile.sh / emergency-disable.sh / drill-rescue.sh（与 Windows 的 .cmd/.ps1 同一套规则：先把坏的那份挪走留证、还原后回读校验、路径闸门、不自动重启）。
- **设置页「出事了怎么办」**：按平台显示对应的救命脚本绝对路径，可复制、可打开文件夹；Windows 还能一键在桌面放一个快捷方式（只有你点才创建）。
- **装上就告诉你有没有兜底**：第一次启用时真的建一个空计划任务验证能力（建 → 回读校验 → 删 → 再确认删掉），不能用就直接说清"会丢失：重启后起不来时不会自动恢复"。
- **平台能力矩阵**：docs/platform-matrix.md 列出 13 条能力 × 5 个平台，逐格标清能用、有前提（并写明用户会看到什么）与做不到。

### 修复

- **同一次重启出现两个看门狗会互相废掉**：旧的 PowerShell 看门狗只还原不拉起，若它先抢到锁，新的看门狗会放弃 → 结果是"配置回滚了却没有任何东西在运行"。已改成仲裁者，同一时刻只允许一个。
- **集成测试会往真实机器注册计划任务**（留下空壳任务）。测试改为注入，不再碰系统。
- 计划任务的触发时间曾写成 UTC，导致**任务会晚 8 小时才触发**；改为本地时间。
- 看门狗里一个忘记 await 的探活判断让 Promise 恒为真，看门狗每次都"放弃"；已修并加回归用例。

### 文档

- 讲清**关机倒数会关掉哪台机器**：Windows 桌面 / Windows web → 关这台 Windows；**WSL 里的 web → 关掉整台 Windows**（不是关 WSL）；容器里没有可靠的关机方式（界面会这么说）。
- 自救包补齐"Windows 用哪个、Linux/WSL 用哪个"，并写明 restore-profile 与 emergency-disable 的分工与选择口诀。
- 记录写 POSIX 脚本踩过的三个坑（dash 数单引号里的括号、双引号里的 sed 转义被吃、嵌套 JSON 平铺 grep 找不到）。

### 验证

- 单元测试 **740 项全绿**（node --test plugins/dsh-autorestart/test/*.test.mjs）。
- 看门狗演练（三档都真触发）+ Windows 自救演练 + **WSL 里的 POSIX 自救演练** 全部 exit 0。
- 全部脚本字节级纯 ASCII（rescue-strings.zh.json 无 BOM），机器上无残留计划任务。
- 未真关电：POSIX 的关机链路只验证到"计划层"（用户决定不为一条常识证据断开会话），矩阵里如实标注。

## 0.7.0 — 2026-10-29

这一版的主题是**认得出自己在什么环境里、并且永远不双开**，外加一个用户真能点到的问题反馈入口。
