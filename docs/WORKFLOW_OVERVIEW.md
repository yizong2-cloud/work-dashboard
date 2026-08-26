# 个人工作进度看板 · 工作流程全景（v3，2026-08-23）

> **本文档是整套系统的总入口与自包含说明**，供人类、维护 Agent、以及**负责审查本工作流的审查 Agent** 阅读。
> 目标读者尤其包括：接手维护的新 Agent、以及被要求"指出这套工作流缺什么、哪里不可靠"的审查方。
> 阅读顺序：本文件 → `docs/AGENT_GUIDE.md`（命令手册）→ `docs/UPDATE_WORKFLOW.md`（一条龙流程）→ `docs/KNOWLEDGE_BASE.md`（任务知识库）→ `docs/SETUP.md`（部署）→ `docs/FEISHU_NOTIFICATIONS.md`（通知）。

---

## 0. 一句话定位

> 一个向 Leader 持续透明展示个人任务/进度/排期/阻塞/变化原因的轻量个人工作看板。
> 维护方式：本人说「开始更新」后，Agent 自动采集、分析并生成更新预览；**只有本人明确回复「确认推送」后**，才更新看板并触发飞书通知。
> 核心难点：把散落在飞书/Codex/DSH/本地文件里的真实工作，**可靠、无遗漏**地提炼成看板上的任务进展。

> **治理方式**：除“开始更新”外，Agent 还可运行只读 `dashboard:steward` 主动发现处理箱、过期现状、排期缺口与数据不一致。它只产生整理队列；任何事实改写仍必须有证据与用户确认，不能让 Agent 自行编造工作状态。

## 1. 系统架构

```text
数据源（四类，互相印证）
  ① 飞书聊天   ~/Workspace/feishu_export/daily/range_*.md/.json   （沟通/排期/阻塞/需求）
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
        │ 无歧义 → publish-preview.json 冻结拟写入/飞书意图 → 用户「确认推送」后才 apply
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
| 飞书聊天导出 | `~/Workspace/feishu-export-public/bin/feishu-export` | 公开仓库提供聊天核心；`~/Workspace/feishu_export/cookies.json` 提供本机认证，结果写回本地目录 |
| prepare / 审查简报 | `workflow/prepare.mjs` / `workflow/review-brief.mjs` | 拉四类输入 + 打包 context；按明确无关/低歧义/需判断生成紧凑全量审查入口 |
| 待确认计划 | `workflow/pending.mjs` | 保存逐项确认单；确认后原子修正单个 source_id，不重写整份 ops |
| 发布审批 | `workflow/publish.mjs` | 生成可读预览，绑定快照和 ops 指纹；只有用户明确确认才允许 apply |
| apply/verify | `workflow/apply.mjs` / `verify.mjs` | 执行 ops.json / 校验不变量 |
| 定时任务 | `workflow/install-cron.mjs`（launchd） | 工作日 3 次自动 prepare（--no-advance） |
| Agent 治理体检 | `workflow/stewardship.mjs` | 只读发现处理箱、陈旧任务、排期缺口与数据完整性问题 |
| 数据库契约 | `supabase/schema.sql` | 建表 + RLS + 触发器 + 约束（幂等） |
| 通知 Edge Function | `supabase/functions/feishu-notify/` | 事件→飞书卡片（分级投递） |
| 任务知识库 | `docs/KNOWLEDGE_BASE.md` | 别名映射/已确认事实/待确认区/目录映射 |
| 反馈/计划 | `src/lib/feedbackService.ts` 等 | Leader 反馈线程、日粒度计划块/日程 |
| 部署 | `.github/workflows/deploy.yml` | push main → GitHub Pages |

> 飞书导出器位于 Workboard 仓库之外，需单独维护。公开仓库是聊天核心的源码主线；本地 `feishu_export` 目录保存 Cookies、导出结果及表格/专项工具，不再维护平行的 Workboard 聊天实现。公开核心在页面结构不兼容时会快速失败，并对临时会话切换失败做有限重试；`prepare` 还会拒绝带有会话级失败的部分导出。`WORKBOARD_FEISHU_BIN` 只供紧急诊断覆盖。

## 3. 数据模型（唯一契约，与 schema.sql 一致）

- **tasks**：id、title、description、status(planned/in_progress/blocked/paused/completed/cancelled)、priority(**urgent**/high/normal/low)、progress(0-100)、start_date、expected_end_date、actual_end_date、current_status(一句话现状)、block_reason、is_interrupt_task、created_at、updated_at
- **task_updates（时间线）**：id、task_id、type(progress/status_change/schedule_change/blocked/unblocked/interrupt/note/completed/**urgent/deurgent/nudge**)、content、old/new_expected_end_date、created_at、created_by、**notify_mode(immediate/merge/silent)**、**merge_key**
- **task_feedback_threads**（协作反馈 / Agent 指令）：`kind` 为 `leader_feedback` 或 `agent_instruction`，均有 status(open/in_progress/resolved)
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
② 读取 KNOWLEDGE_BASE + dashboard:review-brief，对每个 source_id 全量对账；仅歧义项展开原始证据
③ 增量分析 + 产出变更建议 ops.json（含 snapshot_id、全量 reconciliation；先 --dry-run）
④ 有 needs_confirmation → dashboard:pending hold 输出人类可读的 Q1/Q2 确认单并停止
⑤ 用户用自然语言确认 → dashboard:pending resolve 只修正对应证据（不重新 prepare）
⑥ 无待确认 → dashboard:publish preview 输出拟写入内容与飞书意图，发给用户后停止
⑦ 用户明确「确认推送」→ dashboard:publish confirm → dashboard:apply 执行
⑧ dashboard:verify    校验不变量并推进本次已结案快照游标
⑨ 更新 KNOWLEDGE_BASE（新事实入待确认区）+ commit
⑩ 汇报（含机器校验后的对账计数、通知意图与实际队列状态）
```

**定时任务**（launchd，工作日 11:00/15:30/19:30）：只执行 `prepare --no-advance`——**机械拉取打包，不推进任何增量游标、不分析**；分析写入始终等用户说「开始更新」由 Agent 做（半自动设计，避免 LLM 误判自动写库）。

### 增量游标的三层机制（const=弱点集中地，审查重点）
| 层 | 位置 | 语义 |
| --- | --- | --- |
| `.analysis-state.reviewed_at` | `workflow/.analysis-state.json` | Codex/DSH/本地文件的分析增量窗口起点；仅在同一健康快照已成功 apply 且 verify 通过后推进 |
| `update-context.generated_at` / `captured_at` | `workflow/update-context.json` | 本次采集快照生成时间和快照 ID；记录事实，不是任何增量游标 |
| 飞书 `.state.lastSync` | `~/Workspace/feishu_export/daily/.state.json` | 独立运行飞书 CLI 时的本地缓存游标；Workboard 一律传 `--no-update-state`，不把它作为更新流程游标 |
| 会话文件 mtime | ~/.codex/sessions | 摘要器收集用 mtime 过滤（续旧对话也能读到） |

### 第四条铁律：每次「开始更新」必须全量对账（防漏）
背景：曾因「增量数=0 就跳过」「文件名日期过滤漏续对话」「cron 推游标」「只审查前几条详情」反复漏工作。故规定：**分析完成前必须核对 review-packet 中每个 Codex/DSH/飞书/本地 source_id**，逐项结论写入 `ops.json`，回复只报机器生成摘要。摘要器按最后活动时间纳入跨窗口长会话，标准 JSON 已含审查文本，不再重复扫描 detail 副本。宁可多报"无关"，不可漏报"有工作"。

### 待确认续办闸门（2026-08-22）
`needs_confirmation` 不是普通汇总数字，而是当前更新的暂停态：`dashboard:pending hold` 将来源类型、时间、工作目录/群聊/文件名、短证据、候选任务、问题影响和 Agent 建议冻结到 `pending-plan.json`，对用户只显示 Q1/Q2；`codex:3` 等 source_id 仅折叠为题末追踪信息，绝不作为用户需要理解的题目。`apply` 与 `verify` 会拒绝带未解决确认项的快照，`prepare` 也会拒绝用新快照覆盖它。用户回答后，`dashboard:pending resolve --question Q1` 以原子方式只更新对应 reconciliation；只有用户明确放弃并执行 pending cancel 后，才能重新采集。

一条证据不再被强迫只归属一个任务：`mapped` 支持 `task_ids`；与任务有关但没有新事实可写时用 `reviewed_no_change`，不要把它误报成“无关”。这样飞书群或长会话跨多个任务时，Agent 能完整对账而不制造假二选一。

### 发布审批闸门（2026-08-23）
“开始更新”只授权采集、分析和生成预览，不授权写库或飞书投递。`dashboard:publish preview` 按任务聚合为 T1/T2，把拟写入内容、每项飞书意图、快照 ID 与内容指纹冻结到本地审批记录；同一任务的进度百分比和当前情况必须在同一组、一次原子写入中展示。Agent 必须将完整预览发给用户并停止。用户可以直接说“去掉 T2”或“T3 静默写入”，Agent 修改 ops 后重新生成预览。仅当用户明确回复「确认推送」后，Agent 才能运行 confirm，再执行 apply。apply 会校验审批记录与当前快照、reconciliation、ops 的指纹完全一致，因此任何改动都会自动作废旧确认；`--force` 也不能绕过这条闸门。

百分比进度必须声明来源口径 `progress_basis`：用户明确给出的 `user_explicit`、按清晰里程碑计算的 `milestone_ratio`，或会在预览中醒目标注的 `agent_estimate`。看板写入与通知由 `notify_mode` 解耦：通用操作可选 `immediate|silent`，批量 progress 还可选 `merge`；“不要推送”只代表静默写入，不得删除正确的看板事实。

### Agent 托管与日常整理（2026-08-24）

看板的日常维护者是 Agent，而不是人手表格维护者。为避免“主动维护”退化为擅自改写，职责分为两层：

1. **治理层（随时可运行，只读）**：`npm run dashboard:steward -- --json` 产生统一待办：Agent 处理箱、逾期需核实、长期未更新、缺一句话现状、未排期、近期到期未拆日计划、完成不一致、精确重复候选与孤儿时间线。它不写库、不推送。
2. **事实层（受控写入）**：Agent 先从用户指令或数据源证据确认事实，再使用结构化 CLI；涉及来源驱动的一批变更时，仍必须走 `dashboard-update` 的全量对账、预览和「确认推送」。标题/描述/现状的“润色”属于事实表达改写，必须先展示前后对比；合并或删除永远需要单独明确授权。

`dashboard-steward` Skill 由 `workflow/dashboard-steward.skill.md` 为唯一契约，运行 `npm run dashboard:steward-skill:install` 安装到 `~/.agents/skills/dashboard-steward/`。它与 `dashboard-update` 并列：前者负责发现、整理、接手；后者负责采集与受控落库。

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
- `progress.to` 是唯一的任务百分比变更；带百分比的文字不能只写 `note(type=progress)`。publish preview 与 apply 会记录通知**意图**（入队/静默/历史），送达状态须由 `dashboard:notify-status` 单独检查。

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
2. **数据源覆盖仍有边界**：飞书 Cookies 会过期；Codex/DSH 仅覆盖本机可见会话；本地文件目前只扫描 Downloads/Desktop/Documents 的一级白名单目录并只采元数据，嵌套目录、外部盘和文件正文仍需按需展开。
3. **采集与语义判断有意分层**：cron 只拉不分析，不能替代用户发起的「开始更新」。任务归属、进度与排期仍需 Agent 进行语义判断；但这已不是单纯软约束：健康快照、每个 source_id 的完整 reconciliation、待确认暂停态、冻结预览 + 用户「确认推送」、apply 前置条件及 verify 共同拦截写库、投递和游标推进。剩余风险是“结构合法但语义错误”的映射，应通过候选线索、知识库纠正和用户确认降低，不能假装已被机械校验消除。
4. **通知模式仍有语义判断风险**：workflow apply 已拒绝漏传/非法 `notify_mode`，预览也逐项显示通知效果；但 Agent 仍可能在 `immediate` 与 `silent` 之间选错，最终以用户确认的任务级预览兜底。
5. **测试覆盖仍不均衡**：已有 CLI、工作流、纯函数与关键页面契约测试，默认测试输出已压缩以降低日常上下文成本（完整明细可用 `npm run test:verbose` 查看）；但 DB 触发器、真实通知投递和 React 交互仍缺浏览器级自动化回归，继续以最小线上冒烟验收兜底。
6. **schema 部署仍需显式执行**：增量迁移已纳入 `supabase/migrations/` 并由 `dashboard:release-status` 对账，但 GitHub Pages 部署不会自动执行 `supabase db push`；涉及数据契约的发布必须单独验证远端迁移状态。
7. **并发写入无锁**（个人使用影响小）。
8. **无 Realtime**：Leader 手动刷新（有意为之）。
9. **增量边界仍需审计**：当前以 `analysis-state.reviewed_at` 为统一分析起点，并通过会话 mtime/最后活动时间与重叠窗口兜底；虽然已不再依赖飞书 `.state.lastSync`，仍需防止外部导出器或本机文件时间异常造成边界遗漏。

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
3. **apply 加固**：① source-health 闸门（快照 degraded——有数据源拉取失败——一律拒绝）；② 当前审查包所有 source_id 必须有且仅有一个 reconciliation（机器全量对账证据）；③ 当前预览必须有用户「确认推送」的同指纹审批；④ 预条件校验（任务必须存在、状态迁移合法、日期/字段）；⑤ 执行后写 `workflow/last-changeset.json` 可追溯，支持无变更结案。
4. **第四数据源纳入 prepare**：白名单目录（Downloads/Desktop/Documents）扫描自分析游标以来的新文件，仅收集元数据（path/mtime/size/ext），输出到 `snapshot.sources.local_files`，不再靠人工记忆。
5. **manifest/snapshot**：`update-context.json` 现含 `captured_at`、`snapshot_health`、`sources`（各源 ok/失败 + 计数 + 本地文件）。
6. **通知**：真实进展与关键事件即时、纯 note 备注和普通字段编辑静默、批量显式 merge——由 CLI 命令类型内置默认 notify_mode 实现。
7. **文档/schema 漂移修复**：cron 时间注释（工作日 11/15:30/19:30）、测试数口径、operation.schema.json 补 `urgent`。

仍待办 / 需用户拍板：
- **候选提示已落地**（prepare 基于 `workflow/source-map.json` 规则化产出目录/群→任务线索 + 未映射/未排期/逾期提醒，进 `update-context.candidates` 与报告）。映射表可迭代，用户随时提调整。
- **RLS 写权限收紧**（外部审查 P0：禁匿名写）：用户于 2026-08-24 再次确认内部协作以免登录、免反复验证为优先；当前不引入会阻断分享/填写的权限门槛。仅在对外开放或出现敏感数据时重新评估 token、登录或角色限制。

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
| `workflow/prepare.mjs` / `pending.mjs` / `publish.mjs` / `apply.mjs` / `verify.mjs` / `install-cron.mjs` | 流水线、归属确认与发布审批闸门 |
| `scripts/agent.js` + `scripts/*.test.js` | CLI 与测试 |
| `scripts/codex-summary.js` / `dsh-summary.js` | 摘要器 |
