---
name: dashboard-update
description: 更新「个人工作进度看板」（work-dashboard）：先跑 npm run dashboard:prepare 拉取飞书/Codex/DSH 三数据源并打包 update-context.json，读取 docs/KNOWLEDGE_BASE.md 后做增量分析，产出 workflow/ops.json 变更建议，经 npm run dashboard:apply --dry-run 预演、dashboard:apply 执行、dashboard:verify 校验。看板数据实时写入 Supabase，无需重新部署。用户说「开始更新/应该更新了」时使用本技能。
---

# 更新个人工作进度看板

仓库：`/Users/zongyi/work-dashboard`（唯一入口见 `workflow/README.md` 与 `AGENTS.md`）。

## 流程

1. `cd /Users/zongyi/work-dashboard && npm run dashboard:prepare`
   - 自动：飞书增量导出 + Codex 摘要 + DSH 摘要 + 当前看板 + 知识库 → `workflow/update-context.json` + `workflow/latest-report.md`
2. 读 `docs/KNOWLEDGE_BASE.md`（任务别名映射/已确认事实/目录映射）与 `workflow/update-context.json`
3. 增量分析（三数据源都要看，飞书无消息不代表 Codex/DSH 没新工作；命中别名表则更新不新建；新事实先记入「待确认区」）
4. 产出变更建议 `workflow/ops.json`（格式见 `workflow/operation.schema.json`）
5. `npm run dashboard:apply --dry-run` → 确认 → `npm run dashboard:apply`
6. `npm run dashboard:verify`
7. 新别名/新确认事实回写 `docs/KNOWLEDGE_BASE.md`（待确认区 → 用户确认后移入已确认）并 git commit

## 红线

- 状态类修改只走专用命令：进度 `progress`、排期 `schedule`、阻塞 `block`(必填 reason)/`unblock`、完成 `complete`；`status` 只允许普通状态；`update` 只改非状态字段（标题/描述/现状/优先级/开始日期）。
- 所有变更自动生成时间线（原子写入）；排期调整记录 old→new 与原因。
- `SUPABASE_SERVICE_ROLE_KEY` 只在本地 `.env`，绝不写入代码/文档/前端。
- 不执行 `delete` 除非用户明确要求。
