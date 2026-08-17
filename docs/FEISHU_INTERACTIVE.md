# 飞书交互卡片调研（档位 B：飞书内直接操作）

> 状态：调研文档（2026-08-17 编写）。web_search 工具当时不可用，内容基于飞书开放平台已知能力整理，
> 实施前请以官方文档为准核实（见文末链接）。
> 已落地的中间方案（档位 A：智能跳转 + 自动弹窗）见已部署代码，无需升级即可用。

## 1. 现状与限制

当前机器人是**自定义机器人**（webhook + 签名推送）。能力边界：

| 能力 | 自定义机器人 | 自建应用机器人 |
| --- | --- | --- |
| 向群推送消息卡片 | ✅ | ✅ |
| 卡片按钮跳转 URL（打开网页） | ✅ | ✅ |
| 卡片按钮**回调**（点击后回传数据、服务器处理） | ❌ | ✅ |
| 需要配置的东西 | webhook 地址 + 签名密钥 | 应用凭证 + 机器人能力 + 回调地址 |

**结论**：自定义机器人的卡片按钮只能"跳转网页"。要做"在飞书里点按钮直接操作看板"
（标记完成 / 回复反馈 / 加急 / 更新进度），必须升级为飞书**企业自建应用**机器人。

## 2. 目标能力（升级后）

Leader 在飞书卡片里直接：
- 点「完成 60%」→ 看板写入进度 + 时间线 + 反向通知
- 点「回复反馈」→ 卡片弹出输入框回填到反馈线程
- 点「取消加急」→ 直接改优先级
- 日报卡上点「标为已读 / 忽略」→ 只针对个人的已读状态（可选）

本质：把现在「跳网页 + 网页操作」的两步，压缩成「飞书内一步」。

## 3. 升级前置条件（需要管理员）

1. **创建企业自建应用**（飞书开放平台 → 企业自建应用）
   - 只有**飞书管理员**能在管理后台创建自建应用；个人开发者没有管理员权限则做不了。
2. **开启「机器人」能力**，并把机器人拉到目标进度群。
3. **配置权限**：`im:message`（发消息）、`im:message:send_as_bot` 等；若按成员定向推送还需通讯录权限。
4. **配置事件订阅回调地址**（HTTPS，带公网可访问的 URL + 验证 token/加密 key）：
   - 卡片按钮点击 → 飞书 POST `card.action.trigger` 回调到该地址。

## 4. 架构设计（复用现有资产）

```
飞书群（自建应用机器人）
   │ 交互卡片（带 callback 按钮）
   ▼
飞书开放平台 ── card.action.trigger 回调 ──▶ 回调端点（HTTPS）
   │                                          │ 验签（verification token）
   ▼                                          ▼
发消息（tenant_access_token + im/v1/messages）  Supabase Edge Function 处理动作
   ▲                                          │ 调用现有原子 RPC：
   └────── 操作结果卡片 / 通知 ◀─────────────┘   apply_task_update / add_feedback_reply / set_feedback_status
```

关键点：
- **回调端点可直接复用 Supabase Edge Function**（新增一个路由，如 `feishu-callback`），
  用飞书 verification token 验签，动作落到现有的安全 RPC（`apply_task_update` 等），
  天然满足「任何变化写时间线」的铁律。
- **发消息改用自建应用 API**：`tenant_access_token` + `im/v1/messages`（替代当前 webhook）。
  当前 `sendFeishu()` 已实现 app_bot 分支（`FEISHU_APP_ID/APP_SECRET/RECEIVER_ID` 环境变量），
  **发消息侧已就绪**，缺的是「卡片带 callback + 回调处理」。
- **按钮交互模型**：卡片元素 `{ tag: 'button', text, value: {op: 'complete'...}, confirm: {...} }`，
  回调里读 `value` 分发动作；敏感操作可加二次确认（飞书卡片原生 confirm）。

## 5. 工作量与风险

| 项 | 评估 |
| --- | --- |
| 管理员创建应用/权限 | 瓶颈，取决于组织（可能需要找 IT/管理员申请） |
| 发消息切换 app_bot | 小（sendFeishu 已有 app_bot 分支） |
| 交互卡 + 回调处理 | 中（新增 feishu-callback 函数 + cards 交互按钮 + 动作分发） |
| 群内定向/成员识别 | 中（Open ID 映射「Leader/本人」，需在表里维护 open_id ↔ 角色） |
| 测试 | 需要真实飞书环境，无法本地全量模拟 |

风险点：
- 组织策略可能不允许建自建应用（权限/审批）。
- 回调地址必须是公网 HTTPS；Supabase Edge Function 满足。
- 加密：回调建议开启 Encrypt Key，函数侧需解密（飞书 SDK 有现成实现）。

## 6. 建议

1. **档位 A（已上线）先用起来**：智能跳转 + 自动弹窗已覆盖 90% 的常用路径（看任务、更新进度、回复反馈）。
2. **档位 B 先找管理员确认可行性**：问一下能否建企业自建应用 + 开放机器人能力；能，再做。
3. 若确认可行，实施顺序：发消息切 app_bot → 卡片按钮加 value → feishu-callback 函数（验签 + 动作分发到现有 RPC）→ open_id 映射表 → 测试。

## 7. 官方文档（实施前核实）

- 消息卡片（介绍与交互）：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/overview
- 卡片回调（card.action.trigger）：https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/event-subscription-guide/card-action-trigger
- 应用机器人发消息：https://open.feishu.cn/document/server-docs/im-v1/message/create
- 企业自建应用指南：https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process