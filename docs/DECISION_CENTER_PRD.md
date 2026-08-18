# 决策中心（Decision Hub）需求文档

> 版本：v1.0
> 日期：2026-08-19
> 状态：待实现
> 面向对象：需求/实现 Agent、产品经理、决策人
> 关联产品：Workboard（但数据、页面与任务看板解耦）

## 1. 背景与目标

当前的 Agent 协作经常会在需求模糊、规则冲突或范围未确认时暂停。现有解法是 Agent 输出 Markdown 决策单，人工转发、收集回复，再把结论复制回 Agent；过程不可交互、结果难复用，也无法形成稳定链接。

本功能提供一个可分享的**决策表单链接**，把“等待人拍板”变成可闭环的 Agent 工作流：

```text
执行 Agent 发现歧义
  → 产出 Markdown / 普通文本决策单
  → 表单生成 Agent 整理为结构化 JSON 并导入决策中心
  → 发起人转发链接
  → 决策人在线填写并提交
  → 发起人一键导出答案（Markdown / JSON）
  → 将导出结果回传执行 Agent，继续工作
```

v1 的成功标准不是做投票社区，而是让一个复杂的 PM 决策单（如 D1～D10）从发起到“Agent 可消费的结论”不再依赖手工重新排版或逐题抄写。

## 2. 产品原则与明确决策

1. **决策优先，不以票数取代拍板。** 多人可以提交意见，每一份反馈必须完整、可导出；提交身份可选，最终是否采纳由发起人/后续 Agent 决定。
2. **链接即协作入口。** 内部团队使用，v1 不要求登录、邀请或复杂权限；拿到链接的人可以阅读和填写。
3. **结构化结果优先于漂亮文档。** Markdown 仅是输入和导出格式，数据库与页面以题目、选项、答案为真源。
4. **面向 Agent 自动流转。** 创建、关闭、导出都必须有稳定的机器可读接口或命令；页面操作是补充，不是唯一入口。
5. **与任务看板独立。** 决策不强制绑定任务，也不要求人工更新任务。后续可选择把“已确认结论”写入任务时间线，但不属于 v1 的阻塞依赖。

### 非目标（v1 不做）

- 不做登录、组织架构、细粒度 RBAC、审批流或匿名投票统计。
- 不做“上传任意文档后前端自动调用 LLM 解析”。文档解析由表单生成 Agent 完成，导入端只做严格校验。
- 不做多人实时协作编辑、讨论串、催办通知、表单拖拽编辑器。
- 不做任务状态自动更新、飞书自动推送或结果自动驱动代码执行。

## 3. 用户与关键场景

| 用户 | 目标 | 关键动作 |
| --- | --- | --- |
| 执行 Agent | 遇到歧义后拿到确定、可引用的结论 | 读取导出的 Markdown/JSON 后继续执行 |
| 表单生成 Agent | 将决策文档转成稳定链接 | 输出结构化 payload，调用导入命令 |
| 发起人 | 快速收集并转交结果 | 分享链接、在决策收件箱查看自动沉淀的反馈、一键导出 |
| 决策人/PM | 不读原始长文档也能逐题拍板 | 选择、补充理由、提交 |

### 典型输入：拼图留存功能决策单

`D1`～`D10` 应成为十道独立题；每道题可以带背景、推荐项、A/B/C 选项、选项影响说明和“其他，请说明”。提交结果应能精确导出为：

```markdown
# 拼图积分与完成激励 — 决策结果

- 提交身份：PM
- 提交时间：2026-08-19 14:32 (Asia/Shanghai)

## D1. 连击如何累计和中断
- 选择：A（按竞品 5.0.21 源码确认后的事件口径）
- 补充：无

## D2. Hint / 自动放置是否得分、是否中断连击
- 选择：B（Hint 正常得分，但清零连击）
- 补充：与竞品一致。
```

这段输出可不经人工改写直接发送回执行 Agent。

## 4. 信息架构与链接

在现有 Workboard 内增加一级入口“决策中心”，但采用独立的页面语义、数据模型和视觉区域：

- `#/decisions`：决策中心入口，显示决策收件箱与表单卡片；反馈提交后自动沉淀到收件箱，不展示任务进度、日程或任务池。
- `#/decisions/:slug`：单份可分享决策表单。`slug` 为不可重复的、可读短名（例如 `puzzle-retention-incentives`）。
- `#/decisions/:slug/export`：导出页/导出面板；也可用同一页面中的“导出给 Agent”按钮打开。

分享的是第二种链接。GitHub Pages 继续使用 `HashRouter`，因此链接形态为：

`https://yizong2-cloud.github.io/work-dashboard/#/decisions/puzzle-retention-incentives`

## 5. 表单交互

### 5.1 表单头部

- 标题、背景摘要、发起人、创建时间、状态（草稿 / 收集中 / 已关闭）。
- 如有原始文档，提供“查看完整背景”折叠区，而非强迫决策人先读全文。
- 显示“已收到 N 份反馈”；不展示选项票数，避免把决策误导为投票。

### 5.2 题目类型

| 类型 | 适用情况 | 提交值 |
| --- | --- | --- |
| `single_choice` | A/B/C 中选择一个方案 | 一个 option id，可附补充文字 |
| `multiple_choice` | 可同时选择多项 | option id 数组，可附补充文字 |
| `free_text` | 需要自行定义口径/补充结论 | 必填文本 |
| `confirmation` | 例如“其余题按推荐方案执行” | 确认/不确认 + 说明 |

每题支持：编号（如 `D1`）、标题、背景/风险、是否必答、推荐项标识及推荐理由、选项标题、选项影响说明、允许“其他，请说明”。推荐项只做视觉提示，绝不自动代填。

### 5.3 填答与提交

1. 提交身份默认不填也可提交；如需署名，可选择 PM、运营或自定义身份（自定义时必填具体名称）。
2. 逐题作答；提交前校验所有必答题和“其他”说明。
3. 提交后显示不可歧义的摘要与提交时间，并可复制本人的答案。
4. 每次提交都生成一份独立反馈，不覆盖其他人的结果；反馈自动保存到决策收件箱。v1 不提供修改已提交反馈；需要调整时重新提交一份新反馈并在备注中说明。
5. 已关闭表单只读，不能再提交。

## 6. 创建、导入与生命周期

### 6.1 Agent 导入契约

表单生成 Agent 接收 Markdown 或普通文本后，负责归纳题目，生成下列 JSON payload。导入工具只接受此结构化 payload，不负责猜测文档含义。

```json
{
  "slug": "puzzle-retention-incentives",
  "title": "拼图积分与完成激励：请确认产品决策",
  "summary": "请逐题确认；未覆盖的口径请写在补充说明。",
  "source_document": "可选：原始 Markdown 正文",
  "created_by": "decision-form-agent",
  "questions": [
    {
      "code": "D1",
      "title": "连击如何累计和中断",
      "context": "策划案未定义一次操作如何计数。",
      "type": "single_choice",
      "required": true,
      "allow_other": true,
      "recommended_option_code": "A",
      "options": [
        {"code": "A", "label": "按竞品事件口径", "detail": "…"},
        {"code": "B", "label": "按底层事件计数", "detail": "…"}
      ]
    }
  ]
}
```

提供以下 CLI（名称可微调，但输入/输出语义不得改变）：

```bash
# 仅校验，供 Agent 先自检
npm run decision:validate -- --file decision.json

# 原子创建决策表单和所有题目/选项；成功后 stdout 只输出分享 URL 与 form id
npm run decision:create -- --file decision.json

# 输出某表单的全部答卷，默认 Markdown；可供执行 Agent 直接消费
npm run decision:export -- --slug puzzle-retention-incentives --format markdown
npm run decision:export -- --slug puzzle-retention-incentives --format json

# 关闭表单，停止收集新答卷（不删除历史）
npm run decision:close -- --slug puzzle-retention-incentives
```

导入必须是原子操作：slug、题目编号、选项编号重复或 payload 校验失败时，不得留下半份表单。

### 6.2 生命周期

```text
Agent payload → validate → draft（可选）→ open/收集中
                                       ↓
                             收到 0..N 份独立答卷
                                       ↓
                               close/已关闭 → 只读、可导出
```

v1 中 `decision:create` 创建后默认直接 `open`，以服务“生成即给链接”。如需检查排版，payload 可指定 `draft`，再通过 `decision:open` 发布。

## 7. 一键导出（本期核心）

单表单页必须提供“导出给 Agent”按钮，点击后打开导出面板：

- 选择范围：全部反馈（默认）或指定一份反馈。
- 格式：`Markdown`（默认，可复制与下载）和 `JSON`（下载）。
- Markdown 结构固定：表单元数据 → 每份反馈的提交身份（若填写）→ 每道题的题号、题目、所选 option code + label、自由文本/补充说明。
- JSON 保留稳定 id、题目 code、option code、原始文本、提交时间及可选的提交身份；不得只导出前端显示文案。
- 没有反馈时按钮禁用，并说明“尚未收到反馈”。
- 导出行为本身不改写表单和答卷数据。

“复制 Markdown”成功后显示短暂反馈。默认导出应按提交时间倒序；同名答卷人保留每次提交，不能擅自覆盖或合并。

## 8. 数据模型与服务边界

新增独立表，不复用 `tasks`、`task_updates` 或反馈线程：

| 表 | 关键字段 |
| --- | --- |
| `decision_forms` | `id`、`slug`、`title`、`summary`、`source_document`、`status`、`created_by`、`created_at`、`closed_at` |
| `decision_questions` | `id`、`form_id`、`code`、`sort_order`、`title`、`context`、`type`、`required`、`allow_other`、`recommended_option_id` |
| `decision_options` | `id`、`question_id`、`code`、`label`、`detail`、`sort_order` |
| `decision_responses` | `id`、`form_id`、`respondent_name`、`respondent_note`、`submitted_at` |
| `decision_answers` | `id`、`response_id`、`question_id`、`selected_option_ids`（JSON 数组）、`text_answer`、`other_text` |

约束：表单 slug 全局唯一；同一表单的题号唯一；同题选项 code 唯一；答案必须属于其答卷的表单；关闭表单后拒绝新增答卷。

前端通过 `DecisionService` 访问数据，风格上与现有 `TaskService` 分离。Supabase 端至少提供两个 RPC：

- `create_decision_form(payload jsonb)`：创建表单、题目、选项，整个过程原子执行。
- `submit_decision_response(form_slug text, respondent_name text, answers jsonb, respondent_note text)`：校验表单开放状态、必答题和选项归属，并原子写答卷与答案。

导出可以由只读查询服务实现，但格式化逻辑应为一个可测试的纯函数，CLI 和前端共用，避免同一答卷导出两种不同语义。

## 9. 权限与数据可见性

按本次确认，v1 沿用 Workboard 的内部协作模式：**不登录、不做严格角色限制**。持有表单链接的内部成员可以查看并填写；导出页面也不额外加门槛。

这不是安全隔离：链接被转发即意味着内容和答卷可能被查看或新增。因此界面要在分享链接旁明确标注“内部协作链接，请勿包含敏感信息”。删除能力不提供；关闭表单仅通过 Agent CLI/RPC 完成，以防误操作。未来若开放给外部团队，再补 token、登录和角色权限，不能以 v1 的匿名写模型作为安全承诺。

## 10. 视觉与体验要求

- 沿用 Workboard 的纸张感、低饱和紫/粉与圆角系统；不要引入问卷平台式高饱和大色块。
- 题目卡信息层级清楚：`D1` 编号 → 标题 → 背景 → 选项 → 补充输入。
- 推荐项使用小型“推荐”标签和轻背景区分；选中态清晰但不以红/绿暗示对错。
- 长背景默认折叠，展开后不丢失阅读位置。
- 移动端每题单列，选项整块可点，底部固定显示“已回答 X/Y”与提交按钮。
- 成功提交与导出后给出明确的复制/下载反馈，不自动跳转。

## 11. 验收标准

### 功能验收

1. 将符合契约的 JSON 执行 `decision:create` 后，能获得稳定的 `#/decisions/:slug` 链接；刷新、重新打开后题目和推荐项不变。
2. 以拼图留存决策单导入 10 题，能正确呈现 `D1`～`D10`、A/B/C、推荐项、自由补充和必填规则。
3. 决策人可以在无登录状态下匿名提交，或选择 PM、运营、自定义提交身份；缺失必填题目答案或选择自定义却未填写身份时不能提交。
4. 两位决策人依次提交后，产生两份独立答卷；一人再次提交不会覆盖旧答卷。
5. 表单关闭后页面仍可查看和导出，但提交接口与前端均拒绝新答卷。
6. 决策收件箱可看到自动保存的反馈；页面“导出给 Agent”可复制/下载 Markdown，并能下载 JSON；Markdown 含题号、所选 option code + label、补充文本、提交身份（若填写）、提交时间，内容与 JSON 对账一致。
7. `decision:export --format markdown/json` 的结果与页面导出使用同一格式化规则；无答卷时得到明确的空结果，而非报错或虚构答案。
8. 失败导入（重复 slug、重复题号、引用不存在的推荐选项、非法题型）不会产生残留数据。
9. 创建与提交 RPC 的原子性、表单关闭拦截、导出格式化、必填校验均有自动测试；现有看板测试与生产构建继续通过。

### 人工体验验收

1. 收到链接的 PM 无需了解 Workboard 任务结构，可在 2 分钟内完成一份三题决策单。
2. 发起人点击一次即可获得可以直接粘贴到执行 Agent 对话中的 Markdown。
3. 不出现任务状态、任务进度或日程等与当前决策无关的信息。

## 12. 实施顺序

1. 数据库迁移、类型、`DecisionService`、RPC 与 CLI 契约。
2. 决策表单阅读/填答页及校验。
3. 提交成功页、答卷计数和关闭态。
4. 导出纯函数、CLI 与页面“复制/下载”面板。
5. 决策中心入口、视觉细化、自动测试与端到端验收。

实施 Agent 不得顺便调整现有任务/日程的数据权限或工作流；决策中心是新增领域。任何“文档 → JSON”的 LLM 提示词和生成策略也应作为单独文件/命令维护，避免把不确定的自然语言解析混进前端或数据库事务。
