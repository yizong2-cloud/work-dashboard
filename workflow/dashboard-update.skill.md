---
name: dashboard-update
description: 更新「个人工作进度看板」（work-dashboard）。用户说“开始更新/应该更新了”时使用：完整采集四类来源，只分析上次确认后的增量，生成待确认预览；只有用户明确同意当前完整预览后才写入看板和通知队列。
---

# 更新个人工作进度看板

仓库：`/Users/zongyi/Workspace/work-dashboard`。本 Skill 只保留 Agent 必须知道的接口；采集顺序、完整性校验、游标、发布确认和验证均由 `dashboard:update` 封装。

## 日常流程

1. 运行：
   ```bash
   cd /Users/zongyi/Workspace/work-dashboard
   npm run dashboard:update -- start
   ```
   该命令完整扫描飞书、Codex、DSH 和本地文件，校验来源后只输出紧凑增量审查简报。命令失败时按输出的“下一步”排障；不得用旧快照或部分来源继续。
2. **先完整读取 `docs/KNOWLEDGE_BASE.md`**，再以审查简报为入口分析每个 `source_id`。不要默认读取完整 `update-context.json`、飞书导出或工具源码。
   - 只有某项含义不清时才运行 `npm run dashboard:evidence -- --id <source_id>`。
   - 多个互不依赖的歧义项需要展开时并行调用 evidence；不要一条一条串行等待。
   - 只有现有候选与事实冲突时，才用 `rg` 在 `docs/KNOWLEDGE_BASE.md` 定向查相关人名、任务或别名。
   - `*group:*` 是同一明确工作流的续接会话包；其 `member_source_ids` 已由机器纳入覆盖校验，不需要逐成员重复对账。
3. 写 `workflow/ops.json`：每个审查组恰好一个 reconciliation；结论为 `mapped`、`reviewed_no_change`、`irrelevant` 或 `needs_confirmation`。`mapped` 必须带 `task_id` 或 `task_ids`。命中既有任务别名时更新原任务，不重复创建。新建任务必须写 `creation_basis=source_explicit|user_explicit|owner_confirmed` 和当前快照里的 `source_ids`；只要 Agent 自己说“无法安全归类”，就必须用 `needs_confirmation`，不得直接 create。
4. 若存在 `needs_confirmation`，运行 `npm run dashboard:pending -- hold`，把命令生成的完整 `Q1/Q2...` 问题发给用户并停止。用户回答后按命令提示 resolve；不要让用户理解内部 source_id。
5. 对账完成后运行：
   ```bash
   npm run dashboard:update -- preview
   ```
   **最终回复必须逐项完整转发该命令生成的用户预览**，包括描述、状态、优先级、百分比、当前情况和飞书意图。不得只给数量摘要，不得只给 `ops.json`/预览文件链接，也不得假设折叠的工具输出对用户可见。此时尚未写看板、尚未触发飞书。
6. 只有用户在当前对话明确同意当前完整预览后才能运行；确认、可以更新、按这版推送等清晰表达都有效，无需固定口令。把用户的原话原样传给 `--phrase`：
   ```bash
   npm run dashboard:update -- confirm --phrase "<用户明确同意原话>"
   ```
   用户若在要求修改预览时同时明确说“改完就可以更新”，只有在最终预览没有增加其未见过的新内容时才可视为条件授权；否则仍需展示完整新预览后再确认。该命令依次记录确认、apply、verify 并检查通知队列。
7. 若 apply 因临时数据库/网络问题部分失败，完整 changeset 和原授权会保留。修复故障后运行 `npm run dashboard:update -- retry`；它只重试失败项，**不得要求用户再次确认，也不得手工删除已成功 ops 来重组 changeset**。

## 写入规则

- 状态只走专用操作：`progress`、`schedule`、`block`、`unblock`、`complete`、`reopen`。已完成任务恢复时必须用 `reopen`，原子清除实际完成日期。
- 同一任务的进度和 `current_status` 放在同一个 `progress` 操作。每个百分比必须写 `progress_basis=user_explicit|milestone_ratio|agent_estimate`；`user_explicit` 还必须写包含同一百分比的 `evidence_quote` 用户原话。只有“已完成/待验收”等阶段描述时，不得伪装成用户给了 96%；Agent 估算只用 `0/10/25/50/70/85/95` 阶段锚点，或只更新 `current_status`。
- 除 `create` 外每项显式写 `notify_mode=immediate|merge|silent`。历史补记始终静默；“不推送”不等于“不写看板”。
- 不执行 `delete`，除非用户单独明确要求。不得用任何参数绕过来源健康、全量覆盖或人工确认闸门。
- 用户纠正归属、合并关系、私人项目边界或任务现状时，这是已确认事实：**同一轮立即更新知识库（必要时同步 `source-map.json`），再重新生成预览**，不能只改 `ops.json`。仅提交本轮相关文件。汇报“进入投递队列”时不要表述成“已送达”。

Skill 唯一维护源是仓库内本文件。修改后运行 `npm run dashboard:skill:install`，不要直接编辑 `~/.agents/skills/dashboard-update`。
