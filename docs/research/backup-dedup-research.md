# 备份去重调研：「内容没变」到底该怎么判

> 调研对象：dsh-autorestart 的「重启前比对，没变化就跳过备份」为什么时灵时不灵。
> 产出时间：2026-11-07 · 环境约束：Windows + Node.js（**不能假定 rsync / borg / restic 可用**，只能借鉴算法自研）
> 本文件只做调研与建议，**不改任何代码**。

---

## 0. 一句话结论

成熟工具里**没有一个**把「文件时间」当作「内容是否相同」的证据链主干：

- rsync 默认也是 `size + mtime`，但它把 mtime 只当**快速排除**，一旦需要确定就用 `--checksum`（读内容算哈希）；
- borg / restic / git 全部以**内容哈希**给它产的每个对象取 ID，去重是「同一个哈希 ⇒ 同一个对象」的副产品；
- Time Machine / timeshift / ZFS 快照按**时间表 + 写时复制**，根本不判断内容，所以「同内容重复快照」不是它们的 bug 而是它们的定义；
- 我们的实现恰好选了一条最不稳的组合：**`path + size + round(mtime/1000)` 直接进哈希，且备份副本靠 `utimes` 把源 mtime 写回来维持可比**——这条链上任何一个环节被第三方碰一下（编辑器保存、pnpm 安装、我们自己的构建/建图、Windows 属性更新），比对就会翻脸。

结论：**该换的是判据，不是参数**。建议把 mtime 降级为「候选提示」，用「size 相同而 mtime 不同」时的**按需内容哈希**替代它做最终裁决（详见 §6、§7）。

---

## 1. 本地同类实现：`@michengai/dsh-archive-manager`（重点）

路径：`~/.dsh/profiles/desktop/node_modules/@michengai/dsh-archive-manager`（v1.2.0，`main: lib/index.js`）

**它是干什么的（如实说）：它是「会话归档器」，不是「备份/去重器」。**

- `package.json` 自述：*Archive, restore, favorite, and permanently delete sessions, and diagnose damaged session logs.*
- 关键词：`archive, session-management, workspace, cordis, typert`——没有 backup / snapshot / dedupe。
- 依赖的是 DSH 的服务（`workspaceRegistry`、`sessionMoveInvocations`、`cacheRebuildInvocations`），操作对象是**会话（session）**，不是 profile 目录树。

### 它涉及的「变化」判定（读源码得到的确切事实）

| 关注点 | 它的做法 | 源码位置 |
|---|---|---|
| 何时该归档一个会话 | **按时间**：`session.updatedAt <= now - days*864e5`，再叠加「不是收藏 / 不是当前 / 没在跑 / 没有挂起交互」等前置条件 | `lib/archive-organizer.js` 的 `idleArchiveCandidate()` |
| 是否复制内容 | **不复制**：归档/迁移用 `rename` 原地移动（`node:fs/promises` 的 `rename`），没有 `cpSync` / 深拷贝 | `lib/session-move.js` |
| 内容完整性 | 会话工件是 **zstd 帧，且写入时开 `ZSTD_c_checksumFlag: 1`**；读之前先校验帧头魔数 `0xFD2FB528`、描述符与帧长度，坏帧直接报错而不是「当成空内容」 | `lib/session-move.js`（`ZSTD_MAGIC`、`CHECKSUM_OPTS`、`scanFirstZstdFrame`） |
| 去重 / 命名 | **没有内容去重**，也没有「快照目录」概念 | 全库无 `sha1/sha256`、无 `dedupe`、无快照 manifest |
| 保留策略 | 由「归档态 + 空闲天数」表达，不是「保留 N 份」 | `lib/workspace.js` / `archive-experience.js` |
| 还原路径 | 会话级「移回工作区 / 取消归档」，靠 `workspaceRegistry` 的会话移动语义；不是文件回滚 | `lib/session-move.js`、`lib/workspace.js` |
| 缓存一致性 | 派生缓存交给 `@deepseek-ai/dsh-session-projection-cache`（`lib/projcache.js` 只是再导出），自己不维护 mtime 指纹 | `lib/projcache.js` |

**可以借鉴的两点（都很便宜）**

1. **把校验和写进产物本身**（zstd frame checksum），而不是事后拿「外部元数据」推断内容——这正是我们该学的方向：**让备份自己带着「我这份内容是什么」的证明**。
2. **就地移动 + 原子语义**：它不产生「近似副本」，所以没有「副本与源到底一样不一样」的问题。我们的痛点恰恰来自「复制后再回头比对」。

**不能借鉴的**：它根本没有「判断内容是否变化」的机制（按时间归档），所以它**不是**我们的参照答案。这个结论要如实写：本地只装了一个备份/归档类插件，而它是会话归档器。

---

## 2. 生态检索：DSH 插件里确实存在的备份类实现

### 2.1 检索式与结果数（如实记录）

| 检索 | 检索式 | 结果 |
|---|---|---|
| npm registry 搜索 | `https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin%20backup&size=20` | HTTP 200，`total = 13058`（关键词搜索会泛化，实际返回 20 条里约 **12 条是真备份/快照类**） |
| npm registry 搜索 | 同上，关键词 `dsh-plugin` + `snapshot` / `restore` / `sync` 变体 | 与上表高度重叠，新增 `dsh-plugin-repo-snapshot`、`dsh-undo-savepoint` |
| 网页检索（GitHub / 生态站） | `npm "dsh-plugin" backup snapshot plugin deepseek harness`；`"dsh-plugin" github backup restore profile plugin` | 返回 8 条有效来源（见下表与 §9 链接） |

### 2.2 确实存在的备份/快照类插件及其做法

| 插件 | 一句话 | **怎么判断「变了」/ 怎么去重** |
|---|---|---|
| [`@caesarloo/dsh-config-git-backup`](https://www.npmjs.com/package/@caesarloo/dsh-config-git-backup) v0.2.9 | 配置/技能/插件源码备份到本地 git 仓库（backup = sync + commit） | **交给 git**：内容寻址对象 + tree/blob 哈希；「没变化」= `git commit` 无事可做。判据是**内容**，mtime 完全不参与 |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) v0.14.2（周下载 ~1898） | 全 `~/.dsh` 备份/恢复/迁移、定时备份、**升级前快照**、进程外救援 | 以「归档 + 定时 + 事件（升级前）」为触发；有 `verify`（校验归档可读）与 `doctor`；去重不是核心，靠**快照批次**与校验而非内容哈希 |
| [`dsh-backup-rescue`](https://github.com/xiaoxin3309/dsh-backup-rescue) v0.4.6 | 整个 `$DSH_HOME` 备份/恢复，设置页一键归档 + 独立还原器 | 归档式（每次一个包），不做内容去重 |
| [`@wildusk/dsh-backup`](https://github.com/usertoandy/dsh-backup) v0.1.4 | `/backup` `/backup-list` `/backup-restore`，把 `~/.dsh` 打成时间戳 `tar.gz` | **纯时间戳归档**，不去重 |
| [`dsh-plugins-git-sync`](https://socket.dev/npm/package/dsh-plugins-git-sync) v0.2.9 | 插件清单/配置推到自己的 git 仓库，双向同步 + 历史回滚 | **git 内容寻址**；冲突时停下来让人选，不自动裁决 |
| [`@weibaohui/dsh-sync`](https://github.com/weibaohui/dsh-sync) v0.4.11（+其参考实现 `weibaohui/dsh-sync`、[`minghuo/dsh-github-sync`](https://github.com/minghuo/dsh-github-sync)） | Git / WebDAV / 本地目录三种协议；`backup/<实例ID>/` 布局；快照本地优先 | **git 分支/PR + 快照**；纯备份协议与 git 布局一致，冲突结构性避免（每机器一个目录） |
| [`@aiwayds/dsh-vault`](https://github.com/fan56/dsh-vault) v0.8.0 / [`fan56/dsh-vault`](https://github.com/fan56/dsh-vault) | 配置**加密**备份到私有 GitHub 仓库，可跨机恢复/迁移 | 加密包（scrypt + AES-256-GCM）+ git 传输；去重靠 git |
| [`dsh-plugin-repo-snapshot`](https://raw.githubusercontent.com/isayrhythm/dsh-plugin-repo-snapshot/1d59bb28e88b9019fa77f92ddd46e84cb8fc626e/README.en.md) | 把当前工程（含 `.git`）打包加密，存本地或自有 OSS | 打包式快照；「变没变」不是它的问题域 |
| [`dsh-undo-savepoint`](https://socket.dev/npm/package/dsh-undo-savepoint/overview/0.3.5) v0.3.5 | ���置/插件代码快照，undo/redo，DSH 起不来时用离线 CLI/GUI | **「配置与插件文件变化时自动快照」**——注意：这是「变化就快照」，与我们要的「没变化就不快照」正好互补；其触发面（文件变化侦测）值得对照 |
| [`dsh-backup-sync`](https://github.com/Arlenman/dsh-backup-sync) / `dsh-nutstore-backup` / `dsh-backup-migrator` / `@having5548/dsh-backup` | 各有侧重：可视化备份、坚果云增量、GitHub 迁移、ZIP 整包 | 多为「归档 + 清单」，`dsh-nutstore-backup` 自称**增量**（按文件集差异，未在源码层面确认到内容哈希粒度） |

**生态结论**：备份类插件**很多**，但**没有一个把「内容相同 ⇒ 不产生新快照」当作核心承诺**。凡是「没变化」语义可靠的（`*-git-*`、`dsh-vault`、`dsh-sync`），都是**把判据外包给 git 的内容寻址**；凡是自己打归档的，都是「时间戳/事件触发，不做内容去重」。也就是说：**可靠的那一类全都放弃了自研指纹**。

---

## 3. 成熟工具的「判据」与「去重」做法（参照组）

| 工具 | 判断「变了没」的判据 | 去重 / 快照怎么产生 | 代价 | 误判风险 |
|---|---|---|---|---|
| **rsync** | 默认 `size + mtime`（可加 `-u` 等细化）；`--checksum` 才逐文件算滚动/强哈希。**注意：rsync 的默认判据和我们一样，但它明确提供一个「不信 mtime 就校验内容」的开关** | 无内容去重；靠 `--link-dest` 做硬链接级快照（同 inode 不占空间） | 默认判据 O(stat)；`-c` 变 O(读全量) | 默认判据下**mtime 被 touch 就会误报「变了」**——正是我们的症状；社区共识是「要么信任 mtime，要么 `-c`」 |
| **borg** | 以 **chunk ID = 内容哈希**为准；文件变不变由 chunk 是否命中已知 ID 决定 | 仓库里 chunk 只存一次 → **内容去重是天然的**，快照=文件树清单 | 需读全部内容算哈希（首次贵）；有 chunker 参数 | 几乎无「内容相同却判变」；风险在**哈希碰撞**（可忽略）与安全（需加密/MAC） |
| **restic** | 同上但用 **CDC（内容定义分块）** | 同一份内容哪怕整体位移也能命中相同 chunk | 首次全量读 + 索引内存 | 同上；真正风险是**索引损坏**而非误判 |
| **git** | **内容寻址**：blob = `sha1(content)`，tree = 子树哈希；工作区「脏不脏」由 index 与内容比对决定 | 对象只存一次；commit 是树清单 | 首次算全部内容；大二进制不友好 | 几乎无内容误判；`git status` 的 `assume-unchanged` 是**人主动放弃校验**，不是默认 |
| **Time Machine** | **不判断内容**：按小时/天/周排班 + FSEvents 触发 | 目录硬链接/clonefile 共享未变块；同一份内容重复出现只是**同一批硬链接** | 磁盘成本由 APFS 快照承担；无内容哈希开销 | 「同内容也产生一个快照点」= 设计如此；不会因为 mtime 抖动多拷数据 |
| **timeshift** | **不判断内容**：按 schedule（每小时/每天/开机） | rsync 或 btrfs 快照 + 硬链接去重 | 依赖文件系统能力 | 同 Time Machine：按时间，不按内容 |
| **ZFS / btrfs 快照** | **完全不判断**（写时复制，快照即指针） | 块级 COW | 需要文件系统支持 | 无内容判据，也就无「误判」；但**不解决跨机/跨卷**问题 |

**从参照组抄得到的三个可用结论**

1. **判据分两层**：便宜的 stat 只用来「快速排除不可能相同」，最终「相同」必须由内容哈希背书——rsync 的默认判据 + `-c` 备用通道就是这个结构，且**它能解释我们为什么时灵时不灵**。
2. **可靠实现都让产物自带内容证明**（borg/restic/git 的对象 ID、archive-manager 的 zstd frame checksum）。
3. **「没变化就不产生快照」本质是内容寻址系统免费得到的能力**，不是额外做的优化；我们想在没有内容寻址的架构里实现它，就必须补上「内容证明」这一环。

---

## 4. 我们的现状（用于对比的事实基线）

| 环节 | 我们现在的做法 | 代码位置 |
|---|---|---|
| 插件树判据 | `sha256( path + '\0' + size + '\0' + Math.round(mtimeMs/1000) + '\0' )`（遍历时跳过 `BACKUP_SKIP_NAMES`，即 `.git`） | `lib/backup.js` `pluginTreeDigest()` |
| 配置判据 | 三个配置文件（`cordis.patch.yml` / `package.json` / `pnpm-lock.yaml`）的**名字 + 长度 + 内容** | `contentFingerprintOf()` / `digestOfTrees()` |
| 让两侧可比的手段 | 复制时 **`fs.utimesSync(副本, 源atime, 源mtime)`**，把源 mtime 写回副本 | `copyTreeWithProgress()` |
| 选哪份当基准 | 最新的**同范围**完整副本（`includePlugins=true` 时要求副本真含插件树） | `findUnchangedBackup()` + `copyHoldsPluginTree()` |
| 保留 | 按份数 + 认证/固定位裁剪 | `pruneBackups()` |
| 可观测性（t32 刚加） | `changed` 会带 `compareReason`（config-differs / plugin-tree-differs / no same-scope copy）与 ≤5 条 `{path, kind}` 差异 | `findUnchangedBackup()` / restart verdict |

**真机现象复核**：两份备份逐文件对比「新增 0 / 消失 0 / 大小变 0」却判 `changed`，而 `pluginTreeDigest` 的哈希里**唯一的非内容成分就是 `mtime`**。所以当 size 与路径集合都一致时，`changed` 只能来自 **`mtime` 不同**——这不是猜测，是判据本身排除法得到的唯一可能。

**最可能的那个 mtime 漂移源**（按可能性排序，均已在本仓代码里找到机制）：

1. **副本的 mtime 是「复制那一刻的源 mtime」**。备份之后源文件若被任何东西重写（内容相同也算：编辑器保存、pnpm 安装、`codekg_build`、构建产物、`git checkout` 触碰），源的 mtime 就前进了，而副本留在旧值 → **必然 changed**。这和「内容没变」不矛盾，因为判据里根本没有内容。
2. **秒级取整的边界效应**：`Math.round(mtimeMs/1000)` 会把 `x.499s` 与 `x.500s` 分到不同秒；NTFS 到 `utimes` 的往返偶尔有 1ms 级抖动（t23 已经为此改成秒级），但秒级取整本身在「跨半秒边界」时仍会翻面。
3. **备份自身的元数据**（`manifest.json` / `meta.json`）不参与插件树哈希——真机上观察到的「只有这两个文件 mtime 不同」其实是**副本之间的差异**，不直接参与判据；它更像是「两次备份相邻」的证据，而不是原因（这一点要诚实：它不能解释 changed）。

---

## 5. 对比表：我们 vs 参照，差在哪、可采纳什么

| # | 维度 | 我们的做法 | 参照做法 | **我们差在哪** | **可采用的改进（不改代码，仅建议）** |
|---|---|---|---|---|---|
| 1 | 「内容相同」的最终证据 | 只有 `path+size+mtime` 哈希，**没有内容** | git/borg/restic：内容哈希即身份；rsync：`-c` 时读内容 | 把「时间」当「内容」的替身，**任何 touch 都会伪造出「变了」** | 引入**按需内容校验**：先用 `path+size` 分组，凡 `size` 相同而 `mtime` 不同的文件，读内容算 `sha256`；全部相同 ⇒ 判 `unchanged`（reason: `content-equal`）。只对「可疑文件」付读盘成本（通常是个位数文件） |
| 2 | 让两侧可比的手段 | 复制时 `utimes` 把 mtime 写回副本 | borg/restic/git **不做**这种对齐；它们比内容 | 我们靠**写回时间**维持契约，链上任何一方不配合就断 | 把「可比锚点」从 mtime 换成**副本 manifest 里记录的内容摘要**（`manifest.files[path]={size,sha256}` 可选字段）；比对不再依赖文件系统时间 |
| 3 | mtime 的角色 | 直接进哈希（**硬判据**） | rsync：仅快速排除；Time Machine/timeshift：不判内容 | mtime 被赋予了它承担不起的权威 | 明确降级为「**提示位**」：`mtime` 不同只触发第 1 条的按需校验，不再单独决定 `changed` |
| 4 | 不可变证据 | 无（哈希是即时算的） | archive-manager：zstd frame **内建 checksum**；restic：索引文件 | 事后无法证明「这份副本当时是什么」 | 备份写入时把 `filesDigest`（或 `{path→sha256}` 摘要的摘要）写进 `manifest.json`；比对时可**只信 manifest**，不必重算整棵树 |
| 5 | 判定结果的可解释性 | t32 已能说出 reason + ≤5 条差异 | rsync `--itemize-changes`、borg `diff`、git `status` | 已接近，但**没有「内容相同、仅时间不同」这一类** | 增加 reason `content-equal-mtime-differs`，并在差异里标注 `kind:mtime, contentMatch:true`——真机上「明明没变」的核心诉求从此有名字 |
| 6 | 边界与预算 | `limits.files` / `limits.ms`，超预算判 `unusable` 并照旧备份 | rsync `-c` 全读、borg 全读 | 我们的「预算」逼得不能读内容 | 预算分级：**stat 阶段**用现有预算；**内容校验阶段**单独给「最多校验 N 个可疑文件 / M 字节」的预算，超了退回「判有变化」（保守方向，符合「宁可多备一次，不能该备没备」） |
| 7 | 「没变化」的对外承诺 | 依赖上述判据，偶发失效 | git 类插件：把承诺外包给 git，天然可靠 | 我们在自研体系里承诺了内容寻址级的能力 | 若允许引入依赖，最省心的路是**把清单交给 git**（`dsh-config-git-backup` / `dsh-sync` 的做法）；不允许则按 #1 自研 |
| 8 | 跨平台 | Windows + Node，`cpSync` + `utimes` | rsync/borg 在 POSIX | Windows 上路径大小写、短名、属性更新都会改写 mtime | 在按需校验里对路径做**大小写归一化**（参考 archive-manager 的 `normalizePath()`：win32 转小写），避免「同名不同大小写」被判 added+removed |

---

## 6. 建议的落地路线（按性价比排序，均不改本次代码）

### 方案 A（推荐，最小改动、直接消灭症状）：`size 相同 + mtime 不同 ⇒ 读内容裁决`

- 判据：`path` 集合先比；`path` 相同则比 `size`；**`size` 相同而 `mtime` 不同时**，对这两个文件算 `sha256`（流式，4KB 块）；
- 结论：全部可疑文件内容相同 ⇒ `state=unchanged`，`reason='content-equal-mtime-differs'`；任何一条内容不同 ⇒ `changed`，`reason='plugin-tree-differs'`，差异里 `kind:'content'`；
- 代价：读到的是**可疑文件**，通常 < 20 个、< 1 MB；预算可用「最多 64 个文件 / 16 MB」封顶，超限退回保守判 `changed`；
- 风险：极低。它只会在「原本会多备一次」的场景里改判 `unchanged`，而内容已证明相同——**这正是「宁可多备」原则允许的例外**（漏备风险为 0，因为内容确实相同）。
- 与 t32 的关系：`compareReason` / `compareDifferences` 已经就位，只需新增一个 reason 取值与 `kind:'content'`。

### 方案 B（治本）：把「内容摘要」搬进副本，比对不再依赖文件系统时间

- 备份写入时，为每个文件记录 `{size, sha256}`（或只记对 `path` 排序后的摘要）到 `manifest.json`（**新字段，向后兼容：老副本没有就回落到方案 A 的按需校验**）；
- 比对时：先比 manifest 摘要（零读盘），不一致再用方案 A 定位；
- 代价：备份时多读一遍源（本来就要复制，可复用同一次读循环，几乎零额外 IO）；manifest 体积增加（每文件几十字节，几千文件 ~100KB，但 slim 副本只有百来个文件）；
- 收益：**mtime 彻底退出判据**，`utimes` 写回这条脆弱链可以保留也可以删除（保留只影响还原保真度）。

### 方案 C（架构级，若允许依赖）：把「清单」交给 git

- 参考 `@caesarloo/dsh-config-git-backup` / `dsh-plugins-git-sync` / `@weibaohui/dsh-sync`：每次重启前 `git commit` 一次配置与插件清单，`git` 自己回答「有没有变化」（`git diff --quiet`）；
- 代价：需要引入 git 二进制或纯 JS 实现（生态里已有「纯 REST、不要 git 二进制」的先例，说明这在 Windows 上是可解的问题）；仓库体积需要 prune；
- 收益：可靠性外包给被验证 20 年的内容寻址实现；
- 与我们当前设计（slim 副本 + manifest + 认证位）冲突较大，属于「下一代架构」而非补丁。

### 方案 D（兜底）：不做内容校验，只把「会误判」讲清楚

- 保留现有判据，但把 `reason` 明确成 `mtime-differs`（而非笼统 `plugin-tree-differs`），并在设置页说明「触碰过文件时间会多备一次」；
- 代价：用户仍会遇到「明明没变却多备」；收益：诚实、零风险。**若不做 A/B，这是唯一可接受的做法**——但按「要么可靠要么不做」的口径，A 的成本远低于此。

---

## 7. 判定「该不该改」的一条硬标准

在任何方案落地前，用真机 `last-restart-verdict.json` 的 `compareReason` / `compareDifferences`（t32）确认一次：

- 若 `kind` 全是 `mtime` 且 `size` 全等 ⇒ 方案 A 直接解决，改；
- 若出现 `added` / `removed` / `size` ⇒ 是真实变化（或路径归一化问题，见 §5 #8），**不要**用「容忍 mtime」的方式掩盖；
- 若 `reason` 是 `config-differs` ⇒ 问题在配置半段（`pnpm-lock.yaml` 常被 `pnpm` 改写），与 mtime 无关。

---

## 8. 附：本报告的方法与局限

- 本地只装了**一个**归档/备份类插件（`@michengai/dsh-archive-manager`），且它**不是**备份去重实现——这一点如实记录，未当作成果。
- 生态检索以 npm registry 关键词搜索 + 网页检索为主，**未逐个 clone 源码**：除 archive-manager 外，上表「怎么判断变了」一列来自各包 README/描述与生态页（已在 §9 给链接），属于**文档级证据**，不是源码级证据；若要把某个实现当范本落地，需要再读源码确认。
- 参照组（rsync/borg/restic/git/Time Machine/timeshift/ZFS）为公开的稳定设计事实，不依赖本机是否安装。

## 9. 来源

- [@michengai/dsh-archive-manager（本地已装，v1.2.0）](file://C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@michengai/dsh-archive-manager) — 源码：`lib/archive-organizer.js`、`lib/session-move.js`、`lib/projcache.js`
- [dsh-plugin-repo-snapshot README](https://raw.githubusercontent.com/isayrhythm/dsh-plugin-repo-snapshot/1d59bb28e88b9019fa77f92ddd46e84cb8fc626e/README.en.md)
- [fan56/dsh-vault](https://github.com/fan56/dsh-vault) · [@aiwayds/dsh-vault](https://socket.dev/npm/package/@aiwayds/dsh-vault)
- [minghuo/dsh-github-sync](https://github.com/minghuo/dsh-github-sync)
- [dsh-plugins-git-sync](https://socket.dev/npm/package/dsh-plugins-git-sync)
- [dsh-undo-savepoint](https://socket.dev/npm/package/dsh-undo-savepoint/overview/0.3.5)
- [xiaoyuyu6420/dsh-backup README](https://raw.githubusercontent.com/xiaoyuyu6420/dsh-backup/main/README.en.md)
- [npm registry 搜索（keywords:dsh-plugin backup）](https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin%20backup&size=20) — `total = 13058`，本次取前 20 条逐条判读
