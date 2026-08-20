---
name: dashboard-update
description: 更新「个人工作进度看板」（work-dashboard）。用户说「开始更新/应该更新了」时使用：生成紧凑审查包、全量对账、按需展开证据、应用或无变更结案、校验。看板数据实时写入 Supabase，无需重新部署。
---

# 更新个人工作进度看板

仓库：`/Users/zongyi/work-dashboard`。

## 流程

1. `cd /Users/zongyi/work-dashboard && npm run dashboard:prepare`
2. 先执行只读预检 `npm run dashboard:status -- --json`。若快照不存在、`snapshot_health=degraded`、`coverage.complete=false`、快照过期或来源健康未记录，立即报告 JSON 中的 `next_action` 并停止；此时不要把知识库或审查条目加载进上下文。
   - 状态中若出现 `last_healthy`，它只是采集故障的诊断参照；不得读取它来生成 ops，也不得用它替代当前快照 apply。
3. 仅在预检通过后读取 `docs/KNOWLEDGE_BASE.md` 与 `workflow/review-packet.json`。
   - 审查包包含当前快照的**每一条** Codex / DSH 会话、飞书群、本地文件，及候选任务和短摘录。
   - 不得直接读取或打印整个 `update-context.json`、完整飞书导出、会话列表或工具源码。
   - 某项含义不清才执行 `npm run dashboard:evidence -- --id <source_id>`；一次只展开该证据。
4. 对审查包中每个 `source_id` 给出唯一结论：`mapped`（需 `task_id`）、`irrelevant` 或 `needs_confirmation`。命中别名映射则更新既有任务，不新建；新事实先写知识库待确认区。
5. 写 `workflow/ops.json`：
   ```json
   {
     "snapshot_id": "<review-packet 的 snapshot_id>",
     "reconciliation": [{ "source_id": "codex:0", "decision": "mapped", "task_id": "<任务 UUID>", "evidence": "简短依据" }],
     "ops": []
   }
   ```
   `ops` 有变更时写操作；没有变更时保持空数组，仍表示本快照已完整审查。
6. `npm run dashboard:apply -- --dry-run` → `npm run dashboard:apply` → `npm run dashboard:verify`。
   - apply 会拒绝遗漏、重复、旧快照或未知 source_id 的对账；无变更会写审查结案，不改任务数据，verify 仍可安全推进游标。
   - `snapshot_health=degraded` 或 `coverage.complete=false` 时不要 apply，也不要用 `--force` 绕过；先修复采集或重新 prepare。
7. 仅有新别名/新确认事实时回写 `docs/KNOWLEDGE_BASE.md`，再只提交本次相关文件。
8. 汇报使用 `dashboard:apply` 输出的对账摘要（总数/已映射/无关/待确认）；不要把 `ops.json` 的逐项 reconciliation 再复制到聊天上下文。逐项审计证据以 `ops.json` 与 changeset 为准。

## 红线

- 状态类修改只走专用命令：进度 `progress`、排期 `schedule`、阻塞 `block`(必填 reason)/`unblock`、完成 `complete`；`status` 只允许普通状态；`update` 只改非状态字段（标题/描述/现状/优先级/开始日期）。
- 所有变更自动生成时间线（原子写入）；排期调整记录 old→new 与原因。
- `SUPABASE_SERVICE_ROLE_KEY` 只在本地 `.env`，绝不写入代码/文档/前端。
- 不执行 `delete` 除非用户明确要求。
- 自动化 `apply` 不接受 `delete`；即使需要删除，也必须由用户单独执行手动删除命令。
- `snapshot_health=degraded` 时默认不 apply；不要用 `--force` 跳过全量对账。
