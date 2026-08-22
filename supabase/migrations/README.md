# 数据库迁移

- `0001_initial_schema.sql`：历史全量初始化 schema。
- `0002_notification_intent.sql`：同步通知意图契约（`notify_mode`/`merge_key`、即时进展、历史补记静默、`task_nudged`），修复 0001 与当前 `schema.sql`/CLI 的部署漂移。
- `0003_idempotent_daily_plan.sql`：日计划幂等创建与时间线原子审计。
- `0004_decision_center.sql`：决策中心（Decision Hub）数据表、约束、RLS 与原子 RPC（`create_decision_form`、`submit_decision_response`、`close_decision_form`、`open_decision_form`）。
- `0008_notification_delivery_cron.sql`：补齐通知 outbox 的 pending 兜底投递（每 5 分钟）与 failed 自动重试（每 15 分钟、最多 5 次）。
- `0009_notification_retry_backoff.sql`：failed 重试增加按 attempts 递增的退避，减少频控/外部故障时的重复撞击。
- `0010_decision_response_personal_notification.sql`：决策答卷写入 outbox，并由 Edge Function 分流到 Leader 专属机器人；不改变任务/催办的群内投递。
- `0011_split_feedback_and_agent_inbox.sql`：将 Leader 协作反馈与给 Agent 的处理指令以 `kind` 分流；已有线程保留为 Leader 反馈，Agent 指令不误发 Leader 群。
- 变更策略：新功能改动先写在这里的 `0001` 之外的增量文件（`NNNN_description.sql`），同时把变更同步回 `supabase/schema.sql`（一键全量入口）。
- 部署：Supabase SQL Editor 执行，或 `npx supabase db push`（需 CLI 与本地迁移目录）。
