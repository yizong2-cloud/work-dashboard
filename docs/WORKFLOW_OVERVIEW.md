# 个人工作进度看板 · 工作流程全景（总览）

> 本文档是整套系统的**总入口与自包含说明**，供人类、未来 Agent、以及**审查 Agent** 阅读。
> 阅读顺序建议：本文件 → `AGENT_GUIDE.md`（命令手册）→ `UPDATE_WORKFLOW.md`（一条龙流程）→ `KNOWLEDGE_BASE.md`（任务知识库）→ `SETUP.md`（部署）。

---

## 1. 一句话定位

> 一个用于向 Leader 持续透明展示个人任务、进度、排期及变化原因的轻量级个人工作看板。
> 维护方式是：**本人用自然语言告诉 Agent，Agent 自动更新网站**，本人不做手动网页维护。

## 2. 系统架构

```text
┌─────────────────────────────────────────────────────────┐
│  数据源（三个，互相印证）                                 │
│  ① 飞书聊天（沟通/排期/阻塞）  ~/feishu_export/           │
│  ② Codex 会话（实际开发）     ~/.codex/sessions/          │
│  ③ DSH 会话（DSH 处理的问题） ~/.dsh/sessions/            │
└──────────────┬──────────────────────────────────────────┘
               │ 读取器（scripts/）
               ▼
┌─────────────────────────────────────────────────────────┐
│  Agent（LLM）分析：结合 KNOWLEDGE_BASE 识别/合并任务       │
│  产出：结构化变更建议（对应 CLI 命令）                     │
└──────────────┬──────────────────────────────────────────┘
               │ Agent CLI（scripts/agent.js）
               ▼
┌─────────────────────────────────────────────────────────┐
│  Supabase PostgreSQL（tasks / task_updates，RLS 全开放） │
└──────────────┬──────────────────────────────────────────┘
               │ 前端 anon key 动态读取（无需重新部署）
               ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Pages 静态站点（React + Vite）                   │
│  https://yizong-boop.github.io/work-dashboard/           │
└─────────────────────────────────────────────────────────┘
```

## 3. 核心组件清单

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| 前端（看板页面） | `src/` | Dashboard / TaskDetail，打开即看即改 |
| 数据层 | `src/lib/` | local（浏览器演示）/ supabase 双实现，统一接口 |
| 任务领域服务 | `src/lib/taskService.ts` | 更新语义统一（进度/排期/阻塞/完成自动写时间线） |
| **Agent CLI** | `scripts/agent.js` | 结构化命令，Agent 更新线上数据的唯一通道 |
| 飞书读取 | `scripts/lib/store.js` + 外部工具 | 数据落库 |
| **Codex 摘要器** | `scripts/codex-summary.js` | 读 `~/.codex/sessions` 提炼会话摘要 |
| **DSH 摘要器** | `scripts/dsh-summary.js` | 读 `~/.dsh/sessions` 提炼会话摘要（zstd 解压） |
| 数据库脚本 | `supabase/schema.sql` | 建表 + RLS 全开放 + updated_at 触发器 |
| 任务知识库 | `docs/KNOWLEDGE_BASE.md` | 任务别名映射 / 已确认事实 / 依赖关系 / 目录映射 |
| 部署 | `.github/workflows/deploy.yml` | push main 自动构建发布 GitHub Pages |

## 4. 数据模型（唯一契约）

**tasks**：id(uuid)、title、description、status(planned/in_progress/blocked/paused/completed/cancelled)、priority(high/normal/low)、progress(0-100)、start_date、expected_end_date、actual_end_date、current_status（一句话现状）、block_reason、is_interrupt_task（临时插入）、created_at、updated_at

**task_updates（时间线）**：id、task_id、type(progress/status_change/schedule_change/blocked/unblocked/interrupt/note/completed)、content、old_expected_end_date、new_expected_end_date、created_at、created_by

**核心规则（违反 = 看板失真）**：
1. 任何变化都追加时间线，绝不只覆盖字段
2. 排期调整必须记录 old → new 日期与原因
3. 完成 = status=completed + progress=100 + actual_end_date=今天
4. 阻塞必须写原因；解除时清空
5. 临时任务打 interrupt 标记，并说明影响了哪个原任务

## 5. Agent 接口（CLI 命令全集）

```bash
npm run agent -- list [--status X] [--interrupt] [--json]     # 看任务
npm run agent -- get <id>                                     # 任务详情+时间线
npm run agent -- create --title ".." [--description] [--priority] [--start] [--end] [--interrupt] [--note]
npm run agent -- progress <id> --to 70 [--note ".."]           # 改进度（自动记时间线）
npm run agent -- status <id> --to in_progress [--note]         # 改状态
npm run agent -- update <id> --title/--description/--current_status/--priority/--start_date/--status/--progress/--actual_end_date [--note]
npm run agent -- schedule <id> --end YYYY-MM-DD [--note]       # 调排期（记录 old/new）
npm run agent -- block <id> --reason ".." / unblock <id>       # 阻塞/解除
npm run agent -- complete <id> [--note]                        # 完成
npm run agent -- note <id> --content ".." [--type X] [--at "时间"]  # 追加时间线（--at 回填历史）
npm run agent -- delete <id>                                   # 删除（慎用）
npm run agent -- batch --file ops.json                         # 批量执行
npm run agent -- seed --force                                  # 仅本地演示模式
```

所有命令支持 `--dry-run` 预演；`--json` 机器输出。数据模式：`.env` 配了 `SUPABASE_URL`(或 VITE_SUPABASE_URL) + `SUPABASE_SERVICE_ROLE_KEY` 则直连线上库，否则本地 `data/local.json`。

## 6. 一条龙更新流程（用户说「开始更新」触发）

| 步骤 | 命令/动作 | 产出 |
| --- | --- | --- |
| ① 拉飞书 | `npm run update:export`（feishu-export --incremental） | `~/feishu_export/daily/range_*.md` |
| ② 拉 Codex | `npm run update:codex` | Codex 会话摘要（cwd/用户请求/commit） |
| ③ 拉 DSH | `npm run update:dsh` | DSH 会话摘要（用户用 DSH 处理的问题） |
| ④ 读上下文 | KNOWLEDGE_BASE + 当前看板 `agent list` | 识别既有任务、目录映射 |
| ⑤ 分析 | Agent/子 Agent 增量分析（过滤闲聊，合并同名任务） | 结构化变更建议 |
| ⑥ 写入 | `npm run agent -- ...`（可先 --dry-run） | 线上库实时更新 |
| ⑦ 回写 | 新别名/事实追加 KNOWLEDGE_BASE 并 commit | 知识库持续累积 |
| ⑧ 汇报 | 总结更新内容与不确定点 | 用户刷新即见 |

## 7. 任务知识库（KNOWLEDGE_BASE）的作用

解决两个核心痛点：
1. **跨群同任务误判**：同一任务在不同群有不同的叫法（如「成就系统」在 fantasy成就群/高琦私聊/黄思杰群都出现）→ 靠「任务别名映射表」合并，命中则不新建。
2. **飞书外信息**：面聊、口头确认、领导指示（如「成就→Farm→fantasy 优先级」「排行榜分工」「周报工具已叫停」）→ 记入「已确认事实」，分析时优先于聊天推断。
3. **目录 ↔ 任务映射**：`npm run update:codex/dsh` 看到的会话 cwd（如 `~/jigsolitaire-cms`）→ 对应哪个看板任务。

维护规则：每次分析后把新发现追加进去，持续累积。

## 8. 部署与运维

- **数据库**：Supabase（项目 `work-dashboard`，区域 Singapore，免费套餐）；`supabase/schema.sql` 在 SQL Editor 执行一次即可（幂等）。RLS 全开放（本人与 Leader 使用，无敏感数据）。
- **前端**：React+Vite，GitHub Actions 自动部署到 GitHub Pages（仓库 `yizong-boop/work-dashboard`，站点 `https://yizong-boop.github.io/work-dashboard/`）。
- **Secrets**（GitHub Actions）：`SUPABASE_URL`、`SUPABASE_ANON_KEY`。
- **本地 `.env`**（gitignored）：`VITE_DATA_MODE=supabase`、`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`（仅本机，供 Agent CLI）。
- **数据动态生效**：所有修改直接写 Supabase，刷新网页即见，无需重新部署。

## 9. 安全红线

- ❌ `SUPABASE_SERVICE_ROLE_KEY`（数据库万能钥匙）绝不进前端/不进仓库/不进任何文档。
- ✅ 前端只用 anon key（本就公开）。
- ❌ 未经用户明确要求不执行 `delete`。
- ⚠️ 本看板无登录无权限控制（用户明确要求）；若未来内容敏感需加权限，改 schema.sql 的 RLS 策略。

## 10. 已知边界与改进空间（供审查 Agent 参考）

**已识别的边界/风险**：
1. **分析依赖 LLM 判断**：飞书/Codex/DSH 的原始数据是自然语言，任务提炼与合并靠 Agent 语义理解，可能存在误判（历史上出现过：跨群任务误判、把麻将逆向与华容道动画逆向混淆、把已完成标成阻塞）。缓解：KNOWLEDGE_BASE 持续累积纠正。
2. **数据源覆盖范围**：Codex/DSH 只覆盖本地会话（网页版/其他设备的会话读不到）；飞书依赖 cookies（会过期，需用户重新导出）。
3. **时间线历史回填**：`--at` 可回填历史时间，但批量导入的时间线 `created_by` 统一为「分析导入」，无法区分每次更新的具体来源。
4. **无自动化流水线**：「开始更新」目前由 Agent 手动执行各步骤；未做 cron 定时触发（用户当前按需触发）。
5. **并发写入**：网页与 CLI 同时更新同一任务时无锁，可能互相覆盖（个人使用场景影响小）。
6. **无测试**：CLI 与前端无自动化测试（TS 严格编译 + 手工冒烟测试）。
7. **schema 无版本迁移机制**：改表结构需手动执行 SQL（当前脚本幂等，可重复执行）。
8. **未接 Supabase Realtime**：Leader 页面需手动刷新才能看到新数据（第一版明确不做，见 PROJECT_PLAN §27.1）。

**可扩展方向**（均已在 PROJECT_PLAN 预留）：Realtime 自动刷新、日报/周报自动生成、排期时间轴/Gantt、数据统计、定时自动更新流水线。

## 11. 文件索引

| 文件 | 内容 |
| --- | --- |
| `README.md` | 项目入口简介 |
| `docs/WORKFLOW_OVERVIEW.md` | **本文件**：全景总览 |
| `docs/AGENT_GUIDE.md` | Agent 命令手册 + 自然语言→命令翻译示例 |
| `docs/UPDATE_WORKFLOW.md` | 一条龙流程步骤 + 实测踩坑记录 |
| `docs/KNOWLEDGE_BASE.md` | 任务知识库（别名映射/事实/目录映射） |
| `docs/SETUP.md` | 部署上线教程（含新手步骤） |
| `docs/PROJECT_PLAN.md` | 原始方案文档（需求来源） |
| `docs/analysis/2026-08-01-16_飞书任务分析.json` | 首次飞书分析结果归档 |
| `supabase/schema.sql` | 数据契约 |
| `scripts/agent.js` | Agent CLI 主入口 |
| `scripts/codex-summary.js` / `scripts/dsh-summary.js` | 工作记录摘要器 |
