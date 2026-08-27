---
name: dashboard-update
description: 更新「个人工作进度看板」（work-dashboard）。用户说“开始更新/应该更新了”时使用：完整采集四类来源，只分析上次确认后的增量，生成待确认预览；只有用户明确说“确认推送”后才写入看板和通知队列。
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
2. 以审查简报为入口分析每个 `source_id`。不要默认读取完整 `update-context.json`、飞书导出、全部知识库或工具源码。
   - 只有某项含义不清时才运行 `npm run dashboard:evidence -- --id <source_id>`。
   - 只有现有候选与事实冲突时，才用 `rg` 在 `docs/KNOWLEDGE_BASE.md` 定向查相关人名、任务或别名。
   - `*group:*` 是同一明确工作流的续接会话包；其 `member_source_ids` 已由机器纳入覆盖校验，不需要逐成员重复对账。
3. 写 `workflow/ops.json`：每个审查组恰好一个 reconciliation；结论为 `mapped`、`reviewed_no_change`、`irrelevant` 或 `needs_confirmation`。`mapped` 必须带 `task_id` 或 `task_ids`。命中既有任务别名时更新原任务，不重复创建。
4. 若存在 `needs_confirmation`，运行 `npm run dashboard:pending -- hold`，把命令生成的完整 `Q1/Q2...` 问题发给用户并停止。用户回答后按命令提示 resolve；不要让用户理解内部 source_id。
5. 对账完成后运行：
   ```bash
   npm run dashboard:update -- preview
   ```
   把完整预览发给用户并停止。此时尚未写看板、尚未触发飞书。
6. 只有用户在当前对话明确回复 **“确认推送”** 后才能运行：
   ```bash
   npm run dashboard:update -- confirm --phrase "确认推送"
   ```
   该命令依次消费确认、apply、verify 并检查通知队列；任一步失败都会停止。

## 写入规则

- 状态只走专用操作：`progress`、`schedule`、`block`、`unblock`、`complete`、`reopen`。已完成任务恢复时必须用 `reopen`，原子清除实际完成日期。
- 同一任务的进度和 `current_status` 放在同一个 `progress` 操作。每个百分比必须写 `progress_basis=user_explicit|milestone_ratio|agent_estimate`；Agent 估算只用 `0/10/25/50/70/85/95` 阶段锚点并在预览标为需确认，避免 92%/96% 伪精度。
- 除 `create` 外每项显式写 `notify_mode=immediate|merge|silent`。历史补记始终静默；“不推送”不等于“不写看板”。
- 不执行 `delete`，除非用户单独明确要求。不得用任何参数绕过来源健康、全量覆盖或人工确认闸门。
- 新别名或用户确认事实才更新知识库；仅提交本轮相关文件。汇报“进入投递队列”时不要表述成“已送达”。

Skill 唯一维护源是仓库内本文件。修改后运行 `npm run dashboard:skill:install`，不要直接编辑 `~/.agents/skills/dashboard-update`。
