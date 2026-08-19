# 飞书通知（任务二：留言通知与网站回复的端到端闭环）

## 一句话定位

- **飞书 = 提醒入口**：Leader/你收到「有反馈要处理」的即时提醒（卡片）。
- **Workboard（看板网站）= 讨论与留档入口**：真正的回复、跟进、解决都在网站内完成。
- **自定义机器人只负责「推」**，不支持双向对话；请勿在飞书里直接回复并期待同步到网站。

## 数据流（谁 → 谁 → 谁）

```text
网页发起反馈 / 回复 / 标记解决      或      Agent CLI 更新任务时间线
        │                                        │
        ▼                                        ▼
task_feedback_messages / threads        task_updates
        │ 数据库触发器（after insert/update）        │ 触发器（按 notify_mode 分流）
        ▼                                        ▼
              notification_outbox（唯一事件源；幂等键 = 源记录 id）
        │
        ▼ 投递触发器（pg_net 异步调用 Edge Function，带 x-dashboard-secret）
        │
        ▼ feishu-notify Edge Function
        │   验签 → 幂等 claim（pending→sending）→ 加载任务/原反馈 → 建卡 → 发飞书
        │   成功 → outbox=sent；失败 → outbox=failed（可重试）
        ▼
        飞书私有工作群（卡片，按钮深链接回网站对应线程）
```

## 通知规则（事件分层 + Agent 显式声明推送意图，无时间窗口）

| 事件 | 触发 | 卡片 | 投递 |
| --- | --- | --- | --- |
| `feedback_created` | Leader 在网站发起反馈（线程首条消息） | 「💬 发起了新反馈」+ 任务名 + 正文；按钮**查看反馈并回复** → `#/task/:id?thread=:thread` | 即时 |
| `feedback_replied` | 负责人在线程下回复 | 回复摘要 + **原反馈摘要**（上下文完整）；按钮同上 | 即时 |
| `feedback_resolved` | 线程被标记解决 / 重新打开 | 低噪音状态卡（绿/橙） | 即时 |
| `task_update`（blocked/unblocked/completed/schedule_change/interrupt/urgent/deurgent/**progress 单条**/`current_status` 实质变化） | 任务关键变化 + 普通进度 | 任务简报卡（**单条进度也秒推**，不再等窗口）；按钮**查看任务详情**（逾期任务变「去更新进度」） | 即时 |
| `task_nudged` | Leader 点「催进度」（或 CLI `nudge`） | 橙色「⏰ 有人催进度了」卡 + 附言 | 即时 |
| `task_update_progress`（**批量合并卡**） | Agent `batch` 命令 / `--merge 批号` 的批量进度 | 聚合摘要「任务进度更新（N 条）」，批末 `flush_merge` **立即投递**（不延迟；未 flush 由 cron 2 分钟兜底） | 批末即发 |
| `note`（备注） | CLI `note --type note` | **不即时推送**，只写时间线、进 19:30 日报汇总；`--notify` 可强制即时 | 静默 |
| `note`（进展） | CLI `note` 默认类型或 `note --type progress` | 作为真实进展即时推送；批量进度应优先使用 `progress` 命令以获得合并卡 | 即时 |
| 历史补记 | CLI `--at` 回填 | 只写时间线，**永不推送**（触发器忽略时间早于当前 10 分钟的记录） | 静默 |
| `decision_response_submitted` | 决策表单收到一份新答卷 | 「🔔 收到新的决策答卷」+ 表单名 + 提交人；按钮**查看决策结果** → `#/decisions/:slug/export` | **仅个人机器人** |

### 投递分层（默认策略）

- **群机器人**：任务进展、排期、阻塞、反馈、加急、催办和工作日日报。它们需要让 Leader 或协作者看到操作回执。
- **个人机器人**：决策表单答卷提交。答卷内容和结果属于 Leader 的收件信息，不回群。
- 加急和催办即使由 Leader 触发，也保留群内卡片；否则触发者无法确认按钮是否生效。
- 个人机器人缺失时，决策答卷**不会降级发群**，而是进入 outbox failed，避免隐私事件误投。

**推送意图由 Agent 显式声明**（`task_updates.notify_mode`）：`immediate` 秒推 / `merge` 同批合并 / `silent` 静默——不再用时间窗口猜测是否批量。

## 已部署内容（2026-08-20）

1. **数据库**（`supabase/schema.sql`，已执行）：
   - `notification_outbox` 表（pending/sending/sent/failed/skipped、attempts、last_error、sent_at）；`decision_response_submitted` 由迁移 `0010` 加入
   - 三个触发器：`notify_task_update_trigger`（按 immediate/merge/silent 分流）、`notify_feedback_message_trigger`（首条=created，其余=replied）、`notify_feedback_status_trigger`（resolved/重开）
   - `public.retry_failed_notifications(max_attempts)`：把 failed 且未超次数的事件重新置 pending（webhook 监听 UPDATE 会重新投递）
   - pg_cron：每 5 分钟兜底投递 pending，每 15 分钟重试 failed（最多 5 次）；failed 按 attempts 递增退避；迁移 `0008_notification_delivery_cron.sql` / `0009_notification_retry_backoff.sql` 补齐调度与退避
2. **Edge Function**（`supabase/functions/feishu-notify/`，线上 version 14，卡片构建抽到 `cards.ts` 纯函数可单测）：
   - 验签 `x-dashboard-secret`；幂等 claim（只有 pending 能抢到）；失败回写 outbox=failed（**不靠 webhook 自动重试**，避免重复推送；由 retry 函数可控重试）
3. **本地测试**：`npm test`（含 `scripts/notify-cards.test.js`：事件分类、深链接、原反馈摘要、聚合卡、不泄露密钥）

## 投递方式（已自动配置，无需控制台）

- 采用 **pg_net 触发器**（`notify_outbox_deliver`）在 outbox 新事件时异步调用 Edge Function，
  不需要在控制台配置 Database Webhook（Management API 无 webhook CRUD 端点）。
- 群投递目标（函数 URL + `x-dashboard-secret`）存在 `public.webhook_endpoint` 表（RLS 禁止 anon 读取），
  值在部署时写入，不落仓库；**与函数 Secrets `DASHBOARD_WEBHOOK_SECRET` 保持一致**。
- 更换 secret：重新生成 → `supabase secrets set DASHBOARD_WEBHOOK_SECRET=<新值>` → `update public.webhook_endpoint set secret='<新值>' where id=1`。
- 个人机器人配置为 Edge Function Secrets：`FEISHU_PERSONAL_BOT_WEBHOOK_URL`、`FEISHU_PERSONAL_BOT_SIGNING_SECRET`。二者只供 `decision_response_submitted` 使用；任一缺失都会失败入队，不回退群机器人，也不发送无签名请求。

## 端到端验证清单

```text
网站创建测试反馈 → 数据库 feedback 记录成功 → outbox 出现 feedback_created（pending）
→ webhook 调 Edge Function → 飞书群收到「[Workboard 测试]」卡片 → 点击按钮进入 #/task/:id?thread=:thread
→ 网站回复 → outbox feedback_replied → 飞书群收到带原反馈摘要的回复卡
→ 标记解决 → 飞书群收到低噪音状态卡
```

- 测试消息会明确标注测试来源；验收后清理数据库测试数据（outbox/反馈/临时任务）。
- 已发送的飞书测试消息无法自动撤回，验收后手动删除群消息或忽略。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 飞书没收到卡片 | ① 查 `notification_outbox` 是否有 pending/failed 行（没行 = 触发器/webhook 未触发）；② 查 Edge Function 日志（Dashboard → Edge Functions → feishu-notify → Logs）；③ 检查 webhook Header 与 Secret 是否一致 |
| 想快速查看通知健康 | 本地运行 `npm run dashboard:notify-status`（需要 `.env` 中的 `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY`；只读，不输出 payload） |
| outbox 有 failed | 看 `last_error`；可执行 `select public.retry_failed_notifications();`，系统 cron 也会按 attempts 退避重试；任务/线程已不存在的永久错误会标记为 skipped |
| 重复收到卡片 | 函数有幂等 claim，同一 outbox 行只会发一次；确认 webhook 没配成重复 |
| Agent 批量更新刷屏 | 批量命令/`--merge` 显式合并成一条（`task_update_progress`）；普通单条进展即时，纯备注静默 |
| 签名校验失败 | 确认 webhook Header `x-dashboard-secret` 与 Secret `DASHBOARD_WEBHOOK_SECRET` 一致 |

## 安全红线

- 飞书 webhook、签名密钥、App Secret、Service Role Key **绝不**进入 `VITE_*`、前端 bundle、测试快照或 Git。
- 自定义机器人建议开启「签名校验」；签名密钥只放 Supabase Secrets。
- Edge Function 必须校验 `x-dashboard-secret`（已实现）。
- 如 webhook 泄露：飞书重新生成 → 更新 Supabase Secret → 更新 webhook Header。
