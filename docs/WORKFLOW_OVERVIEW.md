# 个人工作进度看板 · 工作流程全景（v2，2026-08-17）

> **本文档是整套系统的总入口与自包含说明**，供人类、维护 Agent、以及**负责审查本工作流的审查 Agent** 阅读。
> 目标读者尤其包括：接手维护的新 Agent、以及被要求"指出这套工作流缺什么、哪里不可靠"的审查方。
> 阅读顺序：本文件 → `docs/AGENT_GUIDE.md`（命令手册）→ `docs/UPDATE_WORKFLOW.md`（一条龙流程）→ `docs/KNOWLEDGE_BASE.md`（任务知识库）→ `docs/SETUP.md`（部署）→ `docs/FEISHU_NOTIFICATIONS.md`（通知）。

---

## 0. 一句话定位

> 一个向 Leader 持续透明展示个人任务/进度/排期/阻塞/变化原因的轻量个人工作看板。
> 维护方式：**本人用自然语言说「开始更新」，Agent 自动更新网站**；本人不做手动网页维护。
> 核心难点：把散落在飞书/Codex/DSH/本地文件里的真实工作，**可靠、无遗漏**地提炼成看板上的任务进展。

## 1. 系统架构

```text
数据源（四类，互相印证）
  ① 飞书聊天   ~/feishu_export/daily/range_*.md/.json   （沟通/排期/阻塞/需求）
  ② Codex 会话 ~/.codex/sessions/**/rollout-*.jsonl      （实际开发记录）
  ③ DSH 会话   ~/.dsh/sessions/**/session.jsonl.zstd     （DSH 处理的问题）
  ④ 本地新文件 ~/Downloads 等（apk/pdf/md 需求文档/素材）  ← prepare 白名单扫描元数据（snapshot.sources.local_files）
        │ 读取器 scripts/ (codex-summary.js / dsh-summary.js / feishu-export 外部工具)
        ▼
   prepare.mjs ──打包──▶ workflow/update-context.json + review-packet.json（单次扫描 + 跨窗口活动兜底）
        │ 定时任务(lunchd)：工作日 11:00/15:30/19:30 跑 prepare（--no-advance 只拉不推进游标）
        ▼
   Agent(LLM) 分析：结合 docs/KNOWLEDGE_BASE.md 识别/合并任务 → 产出变更建议
        │ 遵守「第四条铁律：全量对账」；逐项对账写入 ops.json，回复只报摘要
        │ 遇 needs_confirmation → pending-plan.json 保存问题 → 用户确认后原快照续办（不重采集）
        ▼
   Agent CLI scripts/agent.js（唯一写入口，原子 RPC）
        ▼
   Supabase PostgreSQL（tasks / task_updates / feedback / plan，RLS 全开放）
        │ 触发器 ──▶ notification_outbox ──pg_net──▶ feishu-notify Edge Function ──▶ 飞书群卡片
        ▼
   GitHub Pages 静态站（React+Vite，HashRouter）
        https://yizong2-cloud.github.io/work-dashboard/
```

## 2. 核心组件清单

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| 前端看板 | `src/pages/Dashboard.tsx` 等 | 总览/任务详情/日程；Leader 与本人共用 |
| 数据层 | `src/lib/db*.ts` | local/supabase 双实现，统一接口 |
| 任务领域服务 | `src/lib/taskService.ts` | 更新语义统一，自动写时间线 |
| **Agent CLI** | `scripts/agent.js` | Agent 更新数据唯一通道（60 行命令） |
| Codex 摘要器 | `scripts/codex-summary.js` | 读 `~/.codex/sessions` 提炼会话（**按 mtime 过滤**） |
| DSH 摘要器 | `scripts/dsh-summary.js` | 读 `~/.dsh/sessions`（zstd 解压） |
| 飞书导出 | 优先 `~/feishu-export-public/bin/feishu-export`，否则 `~/feishu_export/bin/feishu-export` | cookies + 无头 Chrome 拉聊天 |
| prepare | `workflow/prepare.mjs` | 拉四类输入 + 打包 context + 报告 + 增量游标管理 |
| 待确认计划 | `workflow/pending.mjs` | 保存逐项确认单；确认后原子修正单个 source_id，不重写整份 ops |
| apply/verify | `workflow/apply.mjs` / `verify.mjs` | 执行 ops.json / 校验不变量 |
| 定时任务 | `workflow/install-cron.mjs`（launchd） | 工作日 3 次自动 prepare（--no-advance） |
| 数据库契约 | `supabase/schema.sql` | 建表 + RLS + 触发器 + 约束（幂等） |
| 通知 Edge Function | `supabase/functions/feishu-notify/` | 事件→飞书卡片（分级投递） |
| 任务知识库 | `docs/KNOWLEDGE_BASE.md` | 别名映射/已确认事实/待确认区/目录映射 |
| 反馈/计划 | `src/lib/feedbackService.ts` 等 | Leader 反馈线程、日粒度计划块/日程 |
| 部署 | `.github/workflows/deploy.yml` | push main → GitHub Pages |

> 飞书导出器位于 Workboard 仓库之外，需单独维护。维护中的公开版本在页面结构不兼容时会快速失败，并对临时会话切换失败做有限重试；连续多个会话无法打开也会中止本次导出。`prepare` 还会拒绝带有会话级失败的部分导出，避免把不完整聊天记录当成正常增量。`WORKBOARD_FEISHU_BIN` 可显式覆盖默认选择。

## 3. 数据模型（唯一契约，与 schema.sql 一致）

- **tasks**：id、title、description、status(planned/in_progress/blocked/paused/completed/cancelled)、priority(**urgent**/high/normal/low)、progress(0-100)、start_date、expected_end_date、actual_end_date、current_status(一句话现状)、block_reason、is_interrupt_task、created_at、updated_at
- **task_updates（时间线）**：id、task_id、type(progress/status_change/schedule_change/blocked/unblocked/interrupt/note/completed/**urgent/deurgent/nudge**)、content、old/new_expected_end_date、created_at、created_by、**notify_mode(immediate/merge/silent)**、**merge_key**
- **task_feedback_threads**（Leader 反馈线程）：status(open/in_progress/resolved)
- **task_feedback_messages**（线程消息）：author_role(leader/owner)
- **task_plan_blocks / task_plan_block_changes**（日粒度计划块 + 调整历史）

**核心规则（违反 = 看板失真）**：
1. 任何变化都写时间线，字段+时间线**原子**写入（数据库 RPC），绝不只覆盖字段
2. 排期调整记录 old→new 日期与原因
3. 完成 = status=completed + progress=100 + actual_end_date=今天
4. 阻塞必须写原因，解除时清空
5. 临时任务打 interrupt 标记并说明影响
6. 数据库 CHECK 兜底：`completed→100% 且 actual_end_date`、`blocked→原因非空`、priority/type/event 值域

## 4. Agent CLI 命令全集

```bash
npm run agent -- list|get <id>                      # 看任务/详情+时间线
npm run agent -- create --title ".." [--priority] [--start][--end][--interrupt][--note]   # 原子创建+时间线
npm run agent -- progress <id> --to 70 [--note] [--merge 批号]   # 进度（默认秒推；--merge 并入批聚合卡）
npm run agent -- status <id> --to X [--note]        # 仅普通状态；blocked/completed 用专用命令
npm run agent -- update <id> --title/desc/current_status/priority/start_date [--note][--notify]  # 标题/描述等普通字段静默；状态/优先级即时入队
npm run agent -- schedule <id> --end YYYY-MM-DD [--note]   # 排期（old/new + 可带开始日期）
npm run agent -- block <id> --reason / unblock      # 阻塞/解除
npm run agent -- complete <id> [--note]              # 完成
npm run agent -- note <id> --content ".." [--type][--at][--notify]   # 默认按 progress 即时推送；--type note 纯备注默认静默；--at 回填历史
npm run agent -- nudge <id> [--note]                 # Leader 催进度（飞书橙卡）
npm run agent -- urgent/deurgent（经 update --priority）  # 加急/取消加急（红卡，即时）
npm run agent -- delete <id> / batch --file ops.json / plan-* / seed   # 慎用/批量/计划块/本地演示
```

所有命令支持 `--dry-run`/`--json`。数据模式：`.env` 配了 Supabase 则写线上，否则本地 `data/local.json`。
**推送意图由 Agent 在写入时显式声明**（notify_mode）：immediate 秒推 / merge 同批合并 / silent 静默。

## 5. 一条龙更新流程（用户说「开始更新」触发）

```
① dashboard:prepare   拉四类输入 → 原始快照 update-context.json + 紧凑 review-packet.json
② 读取 KNOWLEDGE_BASE + review-packet，对每个 source_id 全量对账；仅歧义项展开原始证据
③ 增量分析 + 产出变更建议 ops.json（含 snapshot_id、全量 reconciliation；先 --dry-run）
④ 有 needs_confirmation → dashboard:pending hold 输出逐项确认单并停止
⑤ 用户确认 → dashboard:pending resolve 只修正对应 source_id（不重新 prepare）
⑥ dashboard:apply     执行；ops 为空时正式记录“无变更结案”
⑦ dashboard:verify    校验不变量并推进本次已结案快照游标
⑧ 更新 KNOWLEDGE_BASE（新事实入待确认区）+ commit
⑨ 汇报（含机器校验后的对账计数与通知意图）
```

**定时任务**（launchd，工作日 11:00/15:30/19:30）：只执行 `prepare --no-advance`——**机械拉取打包，不推进任何增量游标、不分析**；分析写入始终等用户说「开始更新」由 Agent 做（半自动设计，避免 LLM 误判自动写库）。

### 增量游标的三层机制（const=弱点集中地，审查重点）
| 层 | 位置 | 语义 |
| --- | --- | --- |
| update-context.generated_at | workflow/update-context.json | Codex/DSH 增量窗口起点（=上次「分析完成」时间，仅手动 prepare 推进；cron 用 --no-advance 不推进） |
| 飞书 .state.lastSync | ~/feishu_export/daily/.state.json | 飞书增量起点（cron 不推进） |
| 会话文件 mtime | ~/.codex/sessions | 摘要器收集用 mtime 过滤（续旧对话也能读到） |

### 第四条铁律：每次「开始更新」必须全量对账（防漏）
背景：曾因「增量数=0 就跳过」「文件名日期过滤漏续对话」「cron 推游标」「只审查前几条详情」反复漏工作。故规定：**分析完成前必须核对 review-packet 中每个 Codex/DSH/飞书/本地 source_id**，逐项结论写入 `ops.json`，回复只报机器生成摘要。摘要器按最后活动时间纳入跨窗口长会话，标准 JSON 已含审查文本，不再重复扫描 detail 副本。宁可多报"无关"，不可漏报"有工作"。

### 待确认续办闸门（2026-08-22）
`needs_confirmation` 不是普通汇总数字，而是当前更新的暂停态：`dashboard:pending hold` 将 source_id、短证据、候选任务和待决定事项冻结到 `pending-plan.json`，并要求 Agent 直接向用户逐项提问。`apply` 与 `verify` 会拒绝带未解决确认项的快照，防止一边有歧义一边写库或推进游标。用户回答后，`dashboard:pending resolve` 以原子方式只更新对应 reconciliation；同一健康快照内必须续办，不重新采集或重做全量分析。

## 6. 通知分层（2026-08-17 起，无时间窗口）

| 投递模式 | 谁声明 | 行为 | 到达 |
| --- | --- | --- | --- |
| immediate（默认/关键事件） | 单条 progress、status/block/complete/schedule、urgent/deurgent、nudge、反馈、排期 | 单条秒推 | 即时 |
| merge | Agent `batch`/`--merge 批号` | 同批进度合并 1 条聚合卡，批末 `flush_merge` 立即投递 | 批末即发（兜底 cron 2 分钟） |
| silent | `note --type note`、标题/描述等普通 `update`；`--at` 历史补记 | 只写时间线不推，进 19:30 日报 | 静默 |

- 触发器 `notify_task_update`：历史补记(created_at 早 10min) 静默；silent 静默；merge 合并；其余立即。
- 队列：`notification_outbox`（pending/sending/sent/failed/skipped）→ pg_net → feishu-notify → 按事件分流到群机器人或 Leader 个人机器人。
- **工作日日报卡**（cron 19:30 触发 `send_daily_report`）：已逾期/加急/阻塞/本周到期/未排期+原因/今日更新概览，逐条可点深链。
- 卡片按钮智能跳转：逾期任务按钮「⚠️ 去更新进度」+ `?action=progress` 自动弹快速更新；反馈深链带 thread。
- 历史补记(创建时点远早)不推送、拆分批不打扰：依赖 Agent 正确传 notify_mode。
- `progress.to` 是唯一的任务百分比变更；带百分比的文字不能只写 `note(type=progress)`。apply 会记录通知**意图**（入队/静默/历史），送达状态须由 `dashboard:notify-status` 单独检查。

## 7. 任务知识库（KNOWLEDGE_BASE.md）

解决三类痛点：
1. **跨群同任务误判**：同一任务不同叫法 → 别名映射表合并，命中不新建
2. **飞书外信息**：面聊/口头确认/领导指示 → 已确认事实，分析优先于聊天推断
3. **目录↔任务映射**：会话 cwd → 对应看板任务

规则：新发现先入「待确认区」（含来源时间），用户确认后移入「已确认事实」；**禁止把推测直接固化为永久事实**。

## 8. 部署与运维

- 数据库：Supabase（Singapore，免费）；`supabase/schema.sql` 幂等执行。
- 前端：React+Vite + GitHub Actions → GitHub Pages（`yizong2-cloud.github.io/work-dashboard`）。
- Secrets：GitHub Actions 用 SUPABASE_URL/ANON_KEY；本地 `.env` 有 SERVICE_ROLE_KEY（仅本机）。
- 数据动态生效：改 Supabase 即刷即见，无需重部署。
- Edge Function：`npx supabase functions deploy feishu-notify --project-ref <ref>`。
- Secrets（飞书/通知）：`DASHBOARD_WEBHOOK_SECRET`、`FEISHU_BOT_WEBHOOK_URL`、`FEISHU_BOT_SIGNING_SECRET`、`FEISHU_PERSONAL_BOT_WEBHOOK_URL`、`FEISHU_PERSONAL_BOT_SIGNING_SECRET` 经 Management API 配置（值已哈希，不落仓库）。其中个人机器人仅接收 `decision_response_submitted`。

## 9. 安全红线

- ❌ `SUPABASE_SERVICE_ROLE_KEY` 绝不进前端/仓库/文档。
- ✅ 前端只用 anon key。
- ❌ 未经用户明确要求不执行 `delete`。
- ⚠️ 无登录无权限（用户明确要求，仅本人与 Leader）。

## 10. 可靠性审计 —— 已知缺陷、历史修复、当前薄弱点（给审查 Agent 的核心）

> 审查 Agent 请把本章当作**清单**逐条评估：哪些是真问题、哪些缓解足够、你能提出哪些更简/更稳的设计。

### 10.1 已修复的历史 bug（教训库，审查关注的"复发模式"）
1. ~~增量只看会话 start 时间~~ → 长会话(start 早于窗口)永久漏 → 改 lastTs/mtime 兜底。
2. ~~收集按文件名日期过滤~~ → 续旧对话（文件名日期旧、mtime 新）漏 → 改按 mtime 过滤。
3. ~~cron prepare 推进游标~~ → cron 拉到数据却把下次窗口起点推走、丢增量 → 加 `--no-advance`（cron 只拉不推进游标）。
4. ~~飞书 --incremental 复用缓存会话列表~~ → 高琦 updateTime 陈旧被 skip 漏两周 → 加 `--refresh-chats`。
5. ~~只看增量数或前 5 条 detail~~ → 跨窗口会话被跳过 → 改按最后活动时间纳入，并以审查包全 source_id 对账。
6. ~~update 不写时间线~~ → 改原子 RPC + 自动变更摘要时间线。
7. ~~status 可直切 blocked/completed~~ → 强制 domain 命令 + DB CHECK 兜底。
8. ~~data 约束可绕过~~ → completed→100%&actual_date、blocked→reason 非空 的 DB CHECK。
9. ~~哈希 secret 写错~~ → 重新生成 + `supabase secrets set` + 表一致。
10. ~~通知：取消加急发红色"加急"卡~~ → 新增 `deurgent` 类型。
11. ~~通知：历史补记(如 completed)被当实时事件推、与任务状态矛盾~~ → 触发器忽略 created_at 早于 10min 的补记。
12. ~~通知：一次更新刷 2 条（progress + update 自动 note）~~ → update 自动时间线默认 silent。
13. ~~时区 bug：Codex/DSH metacreatedAt 按 UTC 显示~~ → 摘要器转 +8。
14. ~~GitHub Pages 刷新 404~~ → HashRouter。

### 10.2 已知但未解决的边界/风险
1. **【最大不可靠源】分析依赖 LLM 语义判断**：任务提炼/合并/排期/归属全靠 Agent 读自然语言。8/17 被用户多次纠正：
   - 成就系统：宗意是研发、商雯祺是产品经理，共同负责（Agent 曾以为只归某一人）
   - 试玩产品矩阵：Fantasy/Legacy(拼图组) vs Fun Color(涂色组不同部门)；张震威是投放(UA)组跨产品；AppLovin 归 Fun Color 不归 Fantasy
   - 用户职责边界：华容道项目里负责**后端+CMS**、不负责客户端（Jigslide 按钮动效需求不该记给他）
   → 缓解：KNOWLEDGE_BASE 持续纠正 + 待确认区 + 「有疑问拍板」。但**本质不可消除**，审查者请评估是否可引入半自动校验。
2. **数据源覆盖不完整**：飞书 cookies 会过期；Codex/DSH 仅本地会话；**本地 Downloads 新文件不在 prepare 范围**（靠对账人工补）。
3. **prepare 与分析脱节**：cron 只拉不分析；「开始更新」是否可靠完全取决于 Agent 是否严格执行对账铁律（软约束）。
4. **通知依赖写时正确声明 notify_mode**：Agent 漏/错传可能刷屏或该推不推。
5. **测试覆盖有限**：45 个测试均为 CLI 逻辑/卡片构建/摘要器本地断言；**DB 触发器、通知投递链路、React 前端逻辑无自动化测试**，靠手工端到端（真实飞书群）验证。
6. **schema 无版本迁移机制**：改表结构手动执行幂等 SQL；曾出现"建表内联约束残留"导致例约束并存（已修，但结构脆弱）。
7. **并发写入无锁**（个人使用影响小）。
8. **无 Realtime**：Leader 手动刷新（有意为之）。
9. **增量游标机制复杂度高**：三层（context.generated_at / 飞书 lastSync / 文件 mtime）牵一发动全身，是历史 bug 最集中处。

### 10.3 给审查 Agent 的关注问题（可选，供你针对性评估）
- 增量/游标能否用更简单、趋近"零状态"的设计（如：每次都全量扫最近 N 天文件+按最后活动时间，去掉多游标）？
- 分析环节的不可靠能否用规则化手段兜底（如：prepare 直接产出"候选任务/进度提示"，而非全靠 LLM 从原始文本提炼）？
- 通知是否应改为"关键事件即时 + 普通事件默认聚合/日报"，进一步减少对 Agent 正确声明 notify_mode 的依赖？
- 本地 Downloads 等第四数据源能否纳入 prepare 自动扫描？
- 测试能否扩展到触发器/前端（哪怕冒烟级），减少对"手工端到端"的依赖？

### 10.4 审查后的本轮改进（2026-08-17 第二次审查）

外部审查提出 P0/P1 后已完成：
1. **游标语义分离**：`captured_at`（采集快照时间）与 `.analysis-state.reviewed_at`（分析游标）分离；**仅 apply+verify 均成功、verify 通过时才推进分析游标**——分析中断不会再丢增量（此前手动 prepare 就会把游标前移）。
2. **verify 真正校验**：新增引用完整性检查（孤儿时间线/孤儿计划块，线上模式经 Supabase REST 查询）；发现问题 `exit(1)`，不再把违规当正常快照；通过后推进分析游标。
3. **apply 加固**：① source-health 闸门（快照 degraded——有数据源拉取失败——默认拒绝，需 --force）；② 当前审查包所有 source_id 必须有且仅有一个 reconciliation（机器全量对账证据）；③ 预条件校验（任务必须存在、状态迁移合法、日期/字段）；④ 执行后写 `workflow/last-changeset.json` 可追溯，支持无变更结案。
4. **第四数据源纳入 prepare**：白名单目录（Downloads/Desktop/Documents）扫描自分析游标以来的新文件，仅收集元数据（path/mtime/size/ext），输出到 `snapshot.sources.local_files`，不再靠人工记忆。
5. **manifest/snapshot**：`update-context.json` 现含 `captured_at`、`snapshot_health`、`sources`（各源 ok/失败 + 计数 + 本地文件）。
6. **通知**：真实进展与关键事件即时、纯 note 备注和普通字段编辑静默、批量显式 merge——由 CLI 命令类型内置默认 notify_mode 实现。
7. **文档/schema 漂移修复**：cron 时间注释（工作日 11/15:30/19:30）、测试数口径、operation.schema.json 补 `urgent`。

仍待办 / 需用户拍板：
- **候选提示已落地**（prepare 基于 `workflow/source-map.json` 规则化产出目录/群→任务线索 + 未映射/未排期/逾期提醒，进 `update-context.candidates` 与报告）。映射表可迭代，用户随时提调整。
- **RLS 写权限收紧**（外部审查 P0：禁匿名写）：与用户明确「不做登录/权限」的决策冲突，**需用户重新拍板**是否引入轻量写保护。

## 11. 文件索引

| 文件 | 内容 |
| --- | --- |
| `AGENTS.md` | 四条铁律（含全量对账）+ 入口 |
| `docs/WORKFLOW_OVERVIEW.md` | **本文件**：全景 + 可靠性审计 |
| `docs/AGENT_GUIDE.md` | 命令手册 + 自然语言→命令示例 |
| `docs/UPDATE_WORKFLOW.md` | 一条龙流程 + 踩坑记录 |
| `docs/KNOWLEDGE_BASE.md` | 任务知识库（别名/事实/待确认/目录映射） |
| `docs/FEISHU_NOTIFICATIONS.md` | 通知规则 + 投递 + 排障 |
| `docs/FEISHU_INTERACTIVE.md` | 飞书交互卡（档位 B 调研） |
| `docs/SETUP.md` | 部署教程 |
| `docs/PROJECT_PLAN.md` | 原始方案文档 |
| `supabase/schema.sql` | 数据契约 |
| `workflow/prepare.mjs` / `pending.mjs` / `apply.mjs` / `verify.mjs` / `install-cron.mjs` | 流水线与可续办确认闸门 |
| `scripts/agent.js` + `scripts/*.test.js` | CLI 与测试 |
| `scripts/codex-summary.js` / `dsh-summary.js` | 摘要器 |
