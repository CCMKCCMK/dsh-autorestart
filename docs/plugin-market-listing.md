# 插件市场条目：本地速查

**完整的市场规则在工作区的 `docs/plugin-market-listing.md`**（哪个市场、怎么投、仓库与包的硬性要求、
提交前自检清单、已知坑）——那份是唯一的权威版本，AGENTS.md §5 指向的也是它。本文件只留**在本插件仓里
改得到**、而且最容易踩的那几条；两边冲突时以工作区那份为准。

本插件的条目草稿：[`market-entry.draft.yml`](./market-entry.draft.yml)（提交到
`awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/Eason-22__dsh-autorestart.yml`）。

## 硬性要求：`description.en` / `description.zh` 必须是单行

条目 yml 里的描述是**一个标量**，不是文档：写成 `|` / `|-` 多行块，站点生成器
`scripts/generate-readme.mjs` 会直接拒绝，PR 挂在 `PR check` 的第 9 步 `READMEs match data/plugins`。

真实报错原文（PR #11739 的 CI）：

```
data/plugins/Eason-22__dsh-autorestart.yml: "description.en" must be a single line
data/plugins/Eason-22__dsh-autorestart.yml: "description.zh" must be a single line

2 problem(s) in data/plugins — refusing to generate.
```

内容本身没问题也会挂：这是**格式违规**，不是文案违规。要分段就用一句话写完——多段之间用一个空格连接，
整段仍是一行（草稿里的 `description.en` / `description.zh` 现在就是这个写法）。

## 其它几条（摘要，细节看工作区那份）

- 只交 `data/plugins/` 下的那**一个** yml；两个 README 由脚本生成，**禁止手工编辑**；
- `description.en` 必填、必须以句号结尾；描述里每个具体声明都要能在代码里对上；
- 一个 PR 最多 3 条，超过被 CI 拒绝并要求拆分；
- 目录仓的条目文件名是 `owner__repo.yml`（子包是 `owner__repo--packages-<name>.yml`）。
