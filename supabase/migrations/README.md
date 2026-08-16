# 数据库迁移

- `0001_initial_schema.sql`：当前全量 schema（幂等，可重复执行）。包含：任务/时间线、反馈线程（任务一）、通知 outbox + 触发器 + pg_cron 投递（任务二）、日粒度计划（任务三）。
- 变更策略：新功能改动先写在这里的 `0001` 之外的增量文件（`NNNN_description.sql`），同时把变更同步回 `supabase/schema.sql`（一键全量入口）。
- 部署：Supabase SQL Editor 执行，或 `npx supabase db push`（需 CLI 与本地迁移目录）。
