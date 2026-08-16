# 飞书任务简报接入

## 推荐架构

```text
Agent / 网页 / Leader 留言
          ↓
task_updates INSERT（唯一事件源）
          ↓ Supabase Database Webhook
feishu-notify Edge Function
          ↓
飞书任务简报卡片 → 查看详情 → Workboard 任务页
```

仓库规定任何有意义的任务变化都必须新增 `task_updates`，所以通知只监听这一张表的 `INSERT`。这样不会因为 `tasks UPDATE` 与时间线写入而重复推送，网页留言也自动进入相同链路。

## 选择哪种飞书机器人

### A. 群自定义机器人（建议先用）

- 上线最快，不需要企业管理员审批。
- 只能推送到机器人所在的指定群。
- 卡片支持「查看详情」链接，但不支持把表单结果回传给服务端。

适合先创建一个只有本人、Leader 和机器人的「工作进度」群，验证提醒频率和卡片内容。

### B. 企业自建应用机器人

- 可以给 Leader 的 `open_id` 直接发送单聊卡片。
- 需要创建企业自建应用、开启机器人能力并申请 `im:message:send_as_bot` 等消息权限。
- 凭证和接收者 ID 均放在 Supabase Edge Function Secrets，不能进入前端或 Git 仓库。

Edge Function 已同时支持两种方式：配置 `FEISHU_BOT_WEBHOOK_URL` 时优先走自定义机器人；否则走应用机器人。

## 部署

前置条件：本机安装并登录 Supabase CLI，项目已 link。

```bash
supabase functions deploy feishu-notify --no-verify-jwt
supabase secrets set DASHBOARD_WEBHOOK_SECRET='<随机密钥>'
supabase secrets set DASHBOARD_BASE_URL='https://yizong-boop.github.io/work-dashboard/'
```

自定义机器人再设置：

```bash
supabase secrets set FEISHU_BOT_WEBHOOK_URL='<飞书群机器人 webhook>'
```

企业应用机器人改为设置：

```bash
supabase secrets set FEISHU_APP_ID='<app id>'
supabase secrets set FEISHU_APP_SECRET='<app secret>'
supabase secrets set FEISHU_RECEIVER_ID='<Leader open_id>'
supabase secrets set FEISHU_RECEIVER_ID_TYPE='open_id'
```

## 创建 Database Webhook

在 Supabase Dashboard → Database → Webhooks 新建：

- Table：`public.task_updates`
- Event：只选 `INSERT`
- URL：`https://<project-ref>.supabase.co/functions/v1/feishu-notify`
- Header：`x-dashboard-secret: <与 DASHBOARD_WEBHOOK_SECRET 相同的值>`

保存后用网页提交一条测试留言。飞书应收到「任务简报」卡片，按钮会跳转到对应任务的留言区。

## 频率建议

当前实现是每条时间线推送一张卡片。刚开始建议先运行一周观察噪音：

- 阻塞、完成、排期变化、Leader 留言：即时推送。
- 如果 Agent 一次批量更新会产生过多卡片，下一阶段可增加 `notification_outbox`，将 1–2 分钟内的普通进展聚合成一张摘要；不要在前端做防抖，因为更新也可能来自 CLI。

## 安全红线

- 飞书 webhook、App Secret、Leader Open ID 不进入 `VITE_*`、前端代码或 Git。
- Edge Function 必须校验 `x-dashboard-secret`。
- 如 webhook 泄露，立刻在飞书重新生成并更新 Supabase Secret。
