# 看板更新「唯一入口」

> 目标：让任何 Agent（或人）只需一条命令即可完成看板更新准备；让定时任务无人值守拉数据。
> **分析（LLM 判断）与写入由 Agent 按需触发**——需要语义理解，且用户确认更稳。

自动化 `apply` 不接受删除操作；删除任务仍保留为独立的手动命令，避免一次普通更新误删数据。

## 命令总览

> 机器消费 JSON 时请使用 `npm --silent run <命令> -- --json`，或直接调用对应的 `node workflow/*.mjs --json`；普通 `npm run` 会先打印 npm 自身的脚本提示。

| 命令 | 作用 |
| --- | --- |
| `npm run dashboard:prepare` | 拉取四数据源并生成两层产物：原始快照 `update-context.json` 与紧凑审查包 `review-packet.json`。飞书 Cookies 缺失/失效会明确提示且不复用旧数据。**可无人值守** |
| `npm run dashboard:status [-- --json]` | 只读查看最近快照、四个来源、审查游标和 apply 匹配状态；不展开原始快照、不写数据库。 |
| `npm run dashboard:health [-- --json]` | 一次只读汇总采集/审查、发布、通知队列和受管工作区；不调用采集器、不写库、不发通知。 |
| `npm run dashboard:notify-status [-- --json]` | 只读查看 Supabase 通知 outbox 的 pending/failed/重试摘要；仅使用本机 service role，不输出 payload。 |
| `npm run dashboard:release-status [-- --json]` | 只读核对本地迁移与线上迁移、`feishu-notify` 版本；不执行部署。 |
| `npm run dashboard:evidence -- --id <source_id>` | 仅在审查包不足以判断时，展开当前快照的一条原始会话/飞书群/本地文件元数据。 |
| `npm run dashboard:publish -- preview` | 冻结并输出拟写入内容及飞书通知意图；不写库、不推送，供用户审核。 |
| `npm run dashboard:publish -- confirm --phrase "确认推送"` | 记录用户对当前预览的明确确认；快照或 ops 变化会使确认失效。 |
| `npm run dashboard:apply -- --file ops.json` | 仅在当前预览已获确认时执行；`-- --dry-run` 可随时预演，不写入。 |
| `npm run dashboard:verify` | 校验数据不变量 + 输出健康报告 |
| `npm run dashboard:cron:install` | 安装定时任务（macOS launchd，工作日 11:00/15:30/19:30 自动 `prepare` + 通知，无状态不推进游标） |
| `npm run dashboard:cron:uninstall` | 卸载定时任务 |

飞书导出默认超时 600 秒（完整刷新可能覆盖多个活跃会话）；确需更短或更长时间时可设置 `WORKBOARD_FEISHU_TIMEOUT_MS`。导出器对单个会话另有独立预算，登录态失效、单会话失败或总超时都不会复用旧导出。聊天采集核心固定为 `~/Workspace/feishu-export-public/bin/feishu-export`；Cookie 为 `~/Workspace/feishu_export/cookies.json`，输出为 `~/Workspace/feishu_export/daily`。也就是说，公开仓库提供代码，本地目录提供私有认证与运行数据。`WORKBOARD_FEISHU_BIN` 只供紧急诊断显式覆盖，不构成第二套例行工作流。

日常只运行 `npm run dashboard:prepare`，不要直接运行任一 `feishu-export`。仓库内 `workflow/dashboard-update.skill.md` 是唯一 Skill 源文件；修改后运行 `npm run dashboard:skill:install`，并以 `npm run dashboard:skill:check` 确认 `.agents`/`.codex` 副本没有漂移。

`dashboard:prepare` 会实时透传飞书导出器的会话序号、名称、耗时与失败状态；Codex / DSH 等短步骤仍保持紧凑输出，避免长采集阶段看起来无响应。

每次健康采集还会保留 `last-healthy-context.json` 与 `last-healthy-review-packet.json`。后续采集失败时，当前 `update-context.json` / `review-packet.json` 仍记录失败并阻止 apply；健康副本不会被覆盖，只能用 `npm run dashboard:evidence -- --id <source_id> --last-healthy` 做排障对照，不能作为写入依据。

## 一条龙流程（用户说「开始更新」时）

```text
prepare → Agent 分析 review-packet.json（结合 KNOWLEDGE_BASE；按需展开 evidence）
        → 产出 workflow/ops.json → apply --dry-run → publish preview → 用户确认
        → confirm → apply → verify → 回写知识库 → 汇报
```

对应命令序列：

```bash
npm run dashboard:prepare                        # ① 拉数据，生成 review-packet.json
# Agent 读取 review-packet.json + docs/KNOWLEDGE_BASE.md；有歧义才展开原始 evidence
# 产出 workflow/ops.json：每个 source_id 一条 reconciliation，ops 可为空（无变更结案）；回复使用 apply 输出的摘要，不重复粘贴逐项表格
npm run dashboard:apply -- --dry-run             # ② 预演
npm run dashboard:publish -- preview             # ③ 将完整预览发给用户；到此停止，绝不写入/推送
# 用户明确回复“确认推送”后：
npm run dashboard:publish -- confirm --phrase "确认推送"
npm run dashboard:apply                          # ④ 写入，并由 outbox 触发通知
npm run dashboard:verify                         # ⑤ 校验
# 新别名/事实回写 KNOWLEDGE_BASE 并 git commit
```

## 定时任务（工作日每天 3 次自动准备）

- 安装：`npm run dashboard:cron:install`（**周一至周五** 的 **11:00 / 15:30 / 19:30** 自动跑 `prepare`，完成后发 macOS 通知）
- 健康采集会提示「活跃任务未排期数量」；采集失败则明确提示修复来源，不会误报“数据已就绪”
- 你看到通知后说「开始更新」→ Agent 走上面的一条龙（分析+写入）
- 日志：`~/Library/Logs/work-dashboard-prepare.{out,err}.log`
- 卸载：`npm run dashboard:cron:uninstall`；状态：`launchctl list | grep workdashboard`

> 说明：定时任务只做**机械的拉取与打包**（安全、无写入）；分析判断交给 Agent 在你确认后执行，
> 避免 LLM 误判直接自动写库。如后续要「全自动分析写入」，需要接入 LLM API + 高风险变更人工闸门。

## Dashboard Skill

`workflow/dashboard-update.skill.md` 是唯一维护源。运行 `npm run dashboard:skill:install` 会把它复制到标准个人目录 `~/.agents/skills/dashboard-update/SKILL.md`；`npm run dashboard:skill:check` 用于检查副本漂移。不要直接编辑安装目录中的副本，也不要在 `~/.codex/skills` 保留同名兼容副本，以免 Codex 重复发现。
