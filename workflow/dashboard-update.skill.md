---
name: dashboard-update
description: 更新「个人工作进度看板」（work-dashboard）。用户说「开始更新/应该更新了」时使用：生成紧凑审查包、全量对账、按需展开证据、应用或无变更结案、校验。看板数据实时写入 Supabase，无需重新部署。
---

# 更新个人工作进度看板

唯一流程契约：本文件。仓库：`/Users/zongyi/Workspace/work-dashboard`。

飞书采集由两部分组合，但只有一条 Workboard 工作流：

- 日常更新只能运行 `npm run dashboard:prepare`；不要直接调用任何 `feishu-export`。
- 聊天采集核心是 `/Users/zongyi/Workspace/feishu-export-public/bin/feishu-export`。
- `/Users/zongyi/Workspace/feishu_export` 保存本机 Cookies、导出结果和表格/专项脚本；它向聊天核心提供私有运行数据，不是第二套 Workboard 流程。
- 本 Skill 的个人级安装副本位于 `~/.agents/skills/dashboard-update`，由 `npm run dashboard:skill:install` 从本文件同步；不要直接维护安装副本。`~/.codex/skills` 不再保留同名兼容副本，避免 Codex 重复发现。

## 流程

1. `cd /Users/zongyi/Workspace/work-dashboard && npm run dashboard:prepare`
2. 先执行只读预检 `npm run dashboard:status -- --json`。若快照不存在、`snapshot_health=degraded`、`coverage.complete=false`、快照过期或来源健康未记录，不得读取知识库/审查条目，也不得生成 ops 或 apply；但“停止看板写入”不等于“停止排障”。快照健康同时要求四类采集来源、当前看板 JSON 和知识库均可读取，任一解析/读取失败都必须降级。
   - 飞书诊断 JSON 含 `failedChats` 且 Cookies 仍有效时，在同一任务内先用公开聊天核心和 `--chat-id` 隔离重试，必须带 `--no-update-state`。隔离成功后重新运行一次 `dashboard:prepare`。
   - 若隔离成功但完整采集继续随机换不同会话 `openfail`，将其视为批量切换缺陷：在 `/Users/zongyi/Workspace/feishu-export-public` 复现、修复并补回归测试，再重新运行 `dashboard:prepare`；不要把某个联系人误报为“会话损坏”，也不要只汇报失败后结束任务。
   - 只有登录态/Cookies 失效、飞书外部状态持续不可用，或完成一次有回归测试的代码修复后完整采集仍失败，才报告 JSON 中的 `next_action` 并停止。排障期间始终保留安全闸门，不得使用部分导出或旧健康快照 apply。
   - 状态中若出现 `last_healthy`，它只是采集故障的诊断参照；不得读取它来生成 ops，也不得用它替代当前快照 apply。
3. 仅在预检通过后读取 `docs/KNOWLEDGE_BASE.md`，再运行 `npm run dashboard:review-brief`。
   - 新快照的审查简报包含当前快照的**每一条** Codex / DSH 会话、飞书群与本地文件证据组，按明确无关、低歧义和需判断分组，并带候选任务 ID；它是审查入口，不会弱化全量对账。本地同目录文件可合并展示，但成员覆盖数必须完整。已被同一 `changeset` 完整对账的旧快照默认只显示紧凑结案信息；仅做审计时才加 `--full` 展开。
   - `workflow/review-packet.json` 仍是机器校验的完整契约；仅在简报字段不足、需要检查包元信息时读取它。
   - 不得直接读取或打印整个 `update-context.json`、完整飞书导出、会话列表或工具源码。
   - 某项含义不清才执行 `npm run dashboard:evidence -- --id <source_id>`；一次只展开该证据。`suggested_decision=irrelevant` 仅适用于 source-map 显式维护的非业务来源，仍须在 reconciliation 写出该结论。
4. 对审查包中每个 `source_id` 给出唯一结论：
   - `mapped`：证据会支持任务写入；单任务用 `task_id`，同一群聊/会话涉及多个任务时用 `task_ids`，不得强迫用户二选一。
   - `reviewed_no_change`：已读且与任务有关，但没有足够的新事实需要改看板。
   - `irrelevant`：确实与看板无关。
   - `needs_confirmation`：只有用户答案会实质改变拟写入内容且现有证据无法判断时才用；不能把“Agent 懒得核对”转嫁给用户。
   命中别名映射则更新既有任务，不新建；新事实先写知识库待确认区。
5. 写 `workflow/ops.json`：
   ```json
   {
     "snapshot_id": "<review-packet 的 snapshot_id>",
     "reconciliation": [{ "source_id": "codex:0", "decision": "mapped", "task_ids": ["<任务 UUID 1>", "<任务 UUID 2>"], "evidence": "简短依据" }],
     "ops": []
   }
   ```
   `ops` 有变更时写操作；没有变更时保持空数组，仍表示本快照已完整审查。
6. **确认闸门**：若存在任一 `needs_confirmation`，先运行 `npm run dashboard:pending -- hold`，将该命令输出的每一道完整问题直接发给用户，然后停止。
   - 对用户只使用 `Q1/Q2` 作为回答锚点。每题必须自包含地写清：来源类型、时间、仓库/群聊/文件名、原始内容摘要、为什么无法判断、答案会影响什么、候选任务和 Agent 建议。
   - `codex:3`、`dsh:2`、`feishu:5` 等只是折叠在题末的内部追踪信息；**绝不能**用“codex3 是什么任务”这类内部编号直接向用户提问，也不能要求用户按 `codex:3=...` 的格式回答。
   - 不得只在汇报里写“待确认 N 项”。若无法生成上述完整上下文，Agent 应先用 `dashboard:evidence` 自行补证据，而不是让用户猜。
   - 此时 `ops.json` 与 `pending-plan.json` 是冻结的可续办计划；任何 `dashboard:prepare` 都会被机器阻止，避免新快照静默覆盖问题。用户回复后先运行 `npm run dashboard:pending -- show`，再对每项使用 `dashboard:pending resolve --question Q1 --decision mapped|reviewed_no_change|irrelevant --task <uuid> --reason "<用户确认>"`；涉及多个任务时改用 `--tasks <uuid1,uuid2>`。只有用户明确放弃本轮时，才能运行 `dashboard:pending cancel --reason "<原因>"` 后重新采集。
   - 所有待确认项解决后，才继续 dry-run/apply/verify。
7. 先运行 `npm run dashboard:apply -- --dry-run`；通过后运行 `npm run dashboard:publish -- preview`。
   - 将 `dashboard:publish -- preview` 的**完整输出**发给用户：它是待写入看板和待进入飞书投递队列的唯一预览，运行本身不写数据库、不发飞书。
   - 预览发出后立刻停止。不得运行 `dashboard:apply`、`dashboard:verify`，也不得以“已更新”“已推送”措辞汇报。
   - 预览按任务分组为 `T1/T2/...`，同一任务的进度和现状必须在一组中展示；用户说“去掉 T2”或“T3 静默写入”时，Agent 应修改对应 ops，重新 dry-run 与 preview，不让用户接触 UUID 或 JSON。
8. 只有用户在当前对话明确回复 **「确认推送」**，才依序运行：`npm run dashboard:publish -- confirm --phrase "确认推送"` → `npm run dashboard:apply` → `npm run dashboard:verify`。
   - “可以”“继续”“看起来没问题”等泛泛回复不构成确认；用户要求修改、补充或重新分析时，修改 `ops.json` 后必须重新 dry-run 和 preview。预览、快照、ops 或 reconciliation 任一变化都会使旧确认自动失效。
   - apply 会拒绝遗漏、重复、旧快照、未知 source_id、未解决待确认项或没有当前预览确认的写入；无变更也需要确认后才记录审查结案。`--force` 不能绕过来源健康或人工确认闸门。
   - `dashboard:verify` 只有退出码 `0` 且输出 `status=closed` 才表示本轮真正结案；`verified_not_closed` / 退出码 `2` 说明数据不变量虽通过，但匹配快照尚未成功 apply，必须回到确认与 apply 闸门，不能汇报“已更新”。
9. 仅有新别名/新确认事实时回写 `docs/KNOWLEDGE_BASE.md`，再只提交本次相关文件。
10. 推送后汇报 apply 对账摘要、通知意图和 `dashboard:notify-status` 的实际队列状态；不要把“进入投递队列”表述成“已送达”。逐项审计证据以 `ops.json` 与 changeset 为准。

## 红线

- 状态类修改只走专用命令：进度 `progress`、排期 `schedule`、阻塞 `block`(必填 reason)/`unblock`、完成 `complete`；`status` 只允许普通状态；`update` 只改非状态字段（标题/描述/现状/优先级/开始日期）。
- 所有变更自动生成时间线（原子写入）；排期调整记录 old→new 与原因。
- `SUPABASE_SERVICE_ROLE_KEY` 只在本地 `.env`，绝不写入代码/文档/前端。
- 不执行 `delete` 除非用户明确要求。
- 自动化 `apply` 不接受 `delete`；即使需要删除，也必须由用户单独执行手动删除命令。
- `snapshot_health=degraded` 时默认不 apply；不要用 `--force` 跳过全量对账。
- 含“进度提升到 80%”这类百分比事实，必须使用 `progress { to, note }` 真正更新任务字段；`note(type=progress)` 只能记录阶段性事实，不能冒充百分比变更。即时通知表示“已进入投递队列”，不得在未检查 `dashboard:notify-status` 前表述为“已送达”。
- 每个 `progress` 必须写 `progress_basis`：`user_explicit`（用户明确百分比）、`milestone_ratio`（按清晰里程碑计算）或 `agent_estimate`（Agent 估算）。“进度不错”等模糊措辞不能伪装为用户明确百分比；使用 `agent_estimate` 时预览必须明确标成“需你确认”。
- 同一任务同时更新百分比和 `current_status` 时，写在同一个 `progress` 操作中，保证一次原子字段更新和一条时间线，不得拆成 progress + update 两条重复记录。
- 看板写入与飞书通知相互独立：除 `create` 外每项必须显式写 `notify_mode=immediate|silent`，批量 `progress` 还可用 `merge`。用户要求“不推送”只代表静默写入，不能因此删除本该写入看板的事实；历史 `at` 补记始终不推送。
