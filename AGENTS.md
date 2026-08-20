# AGENTS.md —— 本仓库的 Agent 工作说明

> 任何 Agent（或新加入的人）接手本仓库前先读本文件。
> 日常「开始更新」只读 `workflow/dashboard-update.skill.md`；它已包含执行所需的最小指令。`docs/WORKFLOW_OVERVIEW.md`、`docs/AGENT_GUIDE.md`、`docs/UPDATE_WORKFLOW.md` 仅在改工作流、排障或需要查完整命令时阅读，**不得作为每次更新的固定上下文**。

## 这是什么

**个人工作进度看板**：向 Leader 透明展示个人任务/进度/排期/变化原因的轻量工具。
- 数据：Supabase（`tasks` / `task_updates`，RLS 全开放，无登录）
- 前端：React+Vite，GitHub Pages（`https://yizong2-cloud.github.io/work-dashboard/`）
- 维护：**用户用自然语言说「开始更新」，Agent 自动更新**；本人不做手动网页维护

## 唯一入口

```bash
npm run dashboard:prepare   # 拉取四数据源（含本地 Downloads 白名单）+ 打包 update-context.json + 候选提示（可定时无人值守，无状态不推进游标）
npm run dashboard:apply     # 校验并执行变更建议 ops.json（先 --dry-run）
npm run dashboard:verify    # 校验数据不变量
npm run dashboard:cron:install | uninstall   # 定时任务（工作日 11:00/15:30/19:30 自动 prepare，--no-advance 只拉不推进游标）
```

例行流程见 `workflow/dashboard-update.skill.md`。先读取紧凑审查包；只有不确定的 source_id 才展开一条原始证据，禁止整包倾倒原始快照。

## 三条铁律

1. **任何变化都要写时间线**（`task_updates`），且字段+时间线原子写入（数据库 RPC）。状态类修改只用专用命令：`progress`/`schedule`/`block`(必填原因)/`unblock`/`complete`；`status` 只允许普通状态；`update` 只改非状态字段（都会自动记时间线）。
2. **分析前必读 `docs/KNOWLEDGE_BASE.md`**：任务别名映射（跨群合并）、已确认事实（面聊/口头优先）、目录↔任务映射。新事实先入「待确认区」，用户确认后移入已确认。
3. **`SUPABASE_SERVICE_ROLE_KEY` 绝不进前端/仓库/文档**；不执行 `delete` 除非用户明确要求。

## 第四条铁律：每次「开始更新」必须全量对账（防漏）

**背景（8/17 反复漏的根因）**：prepare 的「增量窗口」假设"上次之后新开始的会话"，但用户是**长会话跨窗口干活**（一个 Codex 会话开十几个小时）+ **多工具并行**（Codex/DSH/飞书/本地文件）。只看「增量数」必漏；增量数=0 不等于没工作。

**每次「开始更新」分析完成前，必须对当前快照做全量核对并把逐项对账表写入 `workflow/ops.json`**：

完整逐项结论由 `ops.json` 保存并由 `dashboard:apply` 机器校验；回复不要重复粘贴整张表，只需报告机器生成的对账摘要（总数、已映射、无关、待确认，以及少量待确认 source_id）。这样减少上下文，同时保留完整审计证据。

1. `review-packet.json` 中每个 `codex:*` source_id：逐条标注归属（→ 任务 X / 工具维护 / 无关），**不许只看增量数或跳过**——摘要器按最后活动时间纳入跨窗口长会话。
2. 每个 `dsh:*` source_id：同上。标准 JSON 扫描已包含审查所需文本，不再重复生成 detail 副本。
3. 飞书增量每个会话：确认有无未映射到看板的消息。
4. **本地新文件（prepare 已自动白名单扫描 Downloads/Desktop/Documents 元数据 → `sources.local_files`）**：对 apk/pdf/md 等产物/需求结合 `source-map.json` 判断归属；不在候选提示里的新文件也要核对。
5. 回复输出格式：`对账共 N 项：已映射 A、无关 B、待确认 C；本次补录 X 项`，完整逐项记录保留在 `ops.json`。

**宁可多报"无关"，不可漏报"有工作"。**

## 数据源

| 来源 | 命令 | 说明 |
| --- | --- | --- |
| 飞书 | `npm run update:export` | 沟通/排期/阻塞 |
| Codex | `npm run update:codex` | 实际开发记录 |
| DSH | `npm run update:dsh` | DSH 处理的问题（需本机 zstd） |

四源互相印证；某源无新消息不代表其他源没新工作（含本地 Downloads 新文件）。

## 质量

- `npm test`：本地测试集（CLI/卡片构建/摘要器，本地隔离，绝不碰线上；数量以 `npm test` 实际执行为准）
- `npm run build`：TS 严格编译 + Vite 构建
- 数据库 CHECK 约束兜底：`completed→progress=100 且 actual_end_date 非空`、`blocked→block_reason 非空`
