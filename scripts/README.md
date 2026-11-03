# 自救包（scripts）

DSH 起不来的时候，这个文件夹里的东西**不用 DSH 自己**就能救自己。

## 按宿主挑文件（**别拿错宿主的**）

| 你的宿主 | 还原 profile | 摘掉本插件 |
|---|---|---|
| **Windows**（桌面客户端 / Windows 上的 `dsh web`） | 双击 `restore-profile.cmd` | 双击 `emergency-disable.cmd` |
| **WSL / Linux**（托管端） | `sh scripts/restore-profile.sh` | `sh scripts/emergency-disable.sh` |
| **macOS** | `sh scripts/restore-profile.sh` | `sh scripts/emergency-disable.sh` |

macOS 用同样的两个 POSIX `sh` 脚本；从未在真 Mac 上跑过，属于未验，不作承诺。

Linux/WSL 的机器上**没有** `.cmd` 文件，Windows 的机器上**没有** `.sh` —— 设置页的
「出事了怎么办」只显示**这台机器上真有的**那两个路径，不会给你一条走不通的死路。
每个平台到底有什么能力，看 [平台能力矩阵](../docs/platform-matrix.md)。

- **双击哪个**：DSH 起不来（插件升级把 profile 弄坏了）→ 还原；只是想把本插件摘掉 → 摘插件。
- **找不到它们？**：设置页里有一组「出事了怎么办」，上面写着这两个脚本的**绝对路径**（可以一键复制、可以一键打开所在文件夹；Windows 上还能放一个桌面快捷方式）—— DSH 真打不开、连 README 都打不开的时候，那一栏就是给你指路的。
- **它会做什么**：`restore-profile.cmd` / `restore-profile.sh` 把最新的那份快照（`<stateDir>/backups/` 里带 manifest 的）放回 profile —— 先把现在的 profile 整份挪到 `<profile>.broken-<时间戳>`，再复制快照里的配置和插件树，最后回读校验（package.json 能解析、`dsh.profile.bundles` 有内容、插件版本号读得到）；校验不过就如实报错，并告诉你原来那份还在哪个目录。**它不会替你重启 DSH**（重启由你自己来，免得"救一次挂一次"）。
- **会留下什么**：一个 `<profile>.broken-<yyyyMMdd-HHmmss>` 目录（出事之前的那份 profile 原封不动地留着，确认没问题后可以自己删掉），加上最后一行"已还原到 …… 现在可以重新打开 DSH"的结论。

## 两条硬规矩（有意收紧，不是 bug）

- **目标 profile 目录必须已经存在**：还原器把快照放回一个**已经存在**的 profile，**不会凭空新建**一个 profile（也不会替你建 `profiles` 目录）。路径写错的时候，宁可报错，也不留一个空壳 profile 在那儿。
- **插件版本号的校验看配置说话**：profile 的 `dsh.profile.bundles` 里**没有** `dsh-autorestart` → 这一项**跳过**；**声明了**、但 `node_modules/dsh-autorestart` 不在 → **必须失败**（配置说一套、磁盘是另一套，这是真坏，不能放过）。

## 演练（不碰你正在用的 profile）

| 平台 | 命令 |
|---|---|
| Windows | `powershell -NoProfile -ExecutionPolicy Bypass -File .\drill-rescue.ps1` |
| Linux / WSL | `sh scripts/drill-rescue.sh` |

两个演练是**同一套断言**（Windows 的 `.ps1` 与 POSIX 的 `.sh`）：在临时目录里造一个假 profile → 故意把 `package.json` 写坏、删掉插件目录 → 调还原脚本救回来 → 断言（能解析、插件版本读得到、`broken-*` 目录存在、非 profile 目录被拒绝、目标目录不存在时被拒绝、"配置说装了却没装"时必须失败、**还原脚本的输出里真的有中文**）→ 清理临时目录。全绿时退出码是 0。

演练的目录纪律（**并发跑也互不干扰**）：每次跑用一个带完整 GUID 的**唯一**目录，目录由本次演练自己创建（已存在就报错退出），目录里放一个独占的锁文件 `.lock`；清理**只删自己那一个绝对路径**，**绝不按前缀/通配符扫临时目录** —— 那会踩到同时在跑的另一个演练。成功、断言不过、抛错中断，走的都是同一个 `finally`，一定会清理；清理不干净就把残留路径打印出来。

`restore-profile.ps1` 的参数：`-DryRun`（只打印将要做什么）、`-Snapshot <目录>`（指定某一份快照）、`-ProfileDir <路径>`（演练用的隔离目录）、`-StateDir <路径>`（插件状态目录，默认 `<DSH_HOME>/storages/dsh-autorestart`）。
`restore-profile.sh` 的参数：`--dry-run`、`--snapshot <目录>`、`--profile <路径>`、`--state-dir <路径>`。`DSH_HOME` 可以用环境变量覆盖，但目标 profile 目录必须已经在那儿。

> 编码规矩（为什么脚本是英文的）：这台机器只有 Windows PowerShell 5.1，它按 ANSI 读**不带 BOM 的 UTF-8** —— 脚本里只要有一个中文字符，整份文件就变乱码、直接 ParserError，脚本连第一步都走不到。POSIX 那边同理（`/bin/sh` 也按字节读，而且中文注释会让不同的 shell 表现不一致）。这个坑一天之内踩了三次，所以现在是**根治**而不是"记得加 BOM"：**所有 `.ps1` / `.sh` / `.cmd` / `.mjs` 必须是纯 ASCII（所有字节 < 128、不带 BOM）**。面向用户的中文全部放在**一个文件**里：`scripts/rescue-strings.zh.json`（UTF-8、**不带 BOM**，带 BOM 会让 `JSON.parse` 直接失败），脚本运行时读它；读不到或读坏了，脚本会用**英文兜底**继续跑，并明确打印一行英文说明（不会崩成乱码）。
>
> **以后要改文案，改 `rescue-strings.zh.json`，不要往脚本里塞中文。** 键名是语义化的（`restore.title`、`restore.brokenKept`、`drill.passed`、`emergency.failed` …），值里可以用 `{0}`、`{1}` 这类占位符。这条规矩由 `test/scripts-encoding.test.mjs` 天天盯着：它会扫目录（不是写死文件名）、断言每个 `.ps1` / `.sh` / `.mjs` 都是纯 ASCII、断言 `.sh` 以 `#!/bin/sh` 开头并开着 `set -eu`、断言 JSON 无 BOM 且能被 `JSON.parse`、断言每个脚本里用到的键在 JSON 里都存在、断言 `.cmd` 调的是 `powershell.exe` 而不是 `pwsh`。

## 写 POSIX 脚本时踩过的三个坑（别再踩一次）

这三个都是**真跑出来的**（不是猜的），症状和原因都写在这儿：

1. **`/bin/sh`（dash）会数单引号里的括号。**
   一段 `$( ... )` 里如果有一段**单引号包起来的英文兜底文案**，而那个文案里有一个
   没配平的 `)`，整份脚本会直接语法报错（`Syntax error: ")" unexpected` / `expecting ")"`），
   **而且报错的位置在后面很远的地方**，很难看出是哪一行害的。
   → **兜底文案里不要出现括号**。要写就写成 `-` 或 `:`。
2. **双引号包起来的 sed 表达式会被 shell 吃掉转义。**
   `sed -n "s/.*\"$key\".../\1/p"` 里的 `\"` 会被 shell 先处理掉，表达式在引号那里被截断，
   sed 报 `unterminated 's' command`（而且报错只给 char N，看不出是引号的问题）。
   → **sed 表达式要么全单引号，要么用 `'...'"$var"'...'` 的拼接写法**。
3. **文案 JSON 是嵌套的**（`restore.title` 是一条路径，不是文件里的键）。
   用一条平铺的 sed 去找 `"restore.title"` 永远找不到 → 脚本会静悄悄地退回英文，
   **功能全对、只是没有中文**，特别难发现。
   → **按路径取值**：用 node 读 JSON（`process.argv[2].split(".")` 一层层取），
   顺便把 `{0}`/`{1}` 的占位符替换也交给 node —— 中文是 UTF-8，**按字节的 sed 会把它弄坏**。

这三个坑的共同点：**症状离原因很远**（语法错在后面、或者干脆不报错只是少了中文），
所以每个脚本都尽量把"取值"和"拼字符串"这两件事交给 node，只在 node 不在时才退回
那一小段 ASCII 兜底逻辑。
