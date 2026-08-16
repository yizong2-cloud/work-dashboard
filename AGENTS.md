# AGENTS.md —— 本仓库的 Agent 工作说明

> 任何 Agent（或新加入的人）接手本仓库前先读本文件。
> 详细手册：`docs/WORKFLOW_OVERVIEW.md`（全景）、`docs/AGENT_GUIDE.md`（CLI 命令）、`docs/UPDATE_WORKFLOW.md`（一条龙流程）、`workflow/README.md`（唯一入口）。

## 这是什么

**个人工作进度看板**：向 Leader 透明展示个人任务/进度/排期/变化原因的轻量工具。
- 数据：Supabase（`tasks` / `task_updates`，RLS 全开放，无登录）
- 前端：React+Vite，GitHub Pages（`https://yizong-boop.github.io/work-dashboard/`）
- 维护：**用户用自然语言说「开始更新」，Agent 自动更新**；本人不做手动网页维护

## 唯一入口

```bash
npm run dashboard:prepare   # 拉取三数据源 + 打包 update-context.json（可定时无人值守）
npm run dashboard:apply     # 校验并执行变更建议 ops.json（先 --dry-run）
npm run dashboard:verify    # 校验数据不变量
npm run dashboard:cron:install | uninstall   # 定时任务（每天 18:00 自动 prepare）
```

完整流程见 `workflow/README.md` 与 `docs/UPDATE_WORKFLOW.md`。

## 三条铁律

1. **任何变化都要写时间线**（`task_updates`），且字段+时间线原子写入（数据库 RPC）。状态类修改只用专用命令：`progress`/`schedule`/`block`(必填原因)/`unblock`/`complete`；`status` 只允许普通状态；`update` 只改非状态字段（都会自动记时间线）。
2. **分析前必读 `docs/KNOWLEDGE_BASE.md`**：任务别名映射（跨群合并）、已确认事实（面聊/口头优先）、目录↔任务映射。新事实先入「待确认区」，用户确认后移入已确认。
3. **`SUPABASE_SERVICE_ROLE_KEY` 绝不进前端/仓库/文档**；不执行 `delete` 除非用户明确要求。

## 数据源

| 来源 | 命令 | 说明 |
| --- | --- | --- |
| 飞书 | `npm run update:export` | 沟通/排期/阻塞 |
| Codex | `npm run update:codex` | 实际开发记录 |
| DSH | `npm run update:dsh` | DSH 处理的问题（需本机 zstd） |

三源互相印证；飞书无新消息不代表 Codex/DSH 没新工作。

## 质量

- `npm test`：Agent CLI 测试（12 用例，本地隔离，绝不碰线上）
- `npm run build`：TS 严格编译 + Vite 构建
- 数据库 CHECK 约束兜底：`completed→progress=100 且 actual_end_date 非空`、`blocked→block_reason 非空`
