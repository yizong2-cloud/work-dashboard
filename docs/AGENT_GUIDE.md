# Agent 维护手册（看板更新接口）

> 本文件是「未来 Agent 用自然语言维护个人工作进度看板」的操作手册。
> 当人类用户说：「帮我更新看板，我今天把 XX 做完了 / 新接了一个任务 / 排期要延后」，
> 你（Agent）按本手册把自然语言翻译成下面的结构化命令来执行。
>
> **重要**：用户说「开始更新」时，走 **`docs/UPDATE_WORKFLOW.md`** 的一条龙流程
> （拉飞书聊天 → 分析 → CLI 更新）；分析前**必读 `docs/KNOWLEDGE_BASE.md`**
> （任务别名映射 / 已确认事实 / 依赖关系），避免把同一任务误判成多个。

---

## 1. 一句话定位

看板 = **任务**（`tasks`）+ **时间线**（`task_updates`）。每次变化都写一条时间线，这是「为什么延期/为什么变化」能被 Leader 看到的根本。

## 2. 数据模型（唯一契约，与 `supabase/schema.sql`、`src/types.ts` 一致）

### tasks（任务）

| 字段 | 说明 | 取值 |
| --- | --- | --- |
| `id` | 任务 id（命令中引用） | uuid 或演示数据里的 `t-xxx` |
| `title` | 任务名称 | 文本 |
| `description` | 任务描述 | 文本 |
| `status` | 状态 | `planned` 待开始 / `in_progress` 进行中 / `blocked` 阻塞 / `paused` 暂停 / `completed` 已完成 / `cancelled` 已取消 |
| `priority` | 优先级 | `high` / `normal` / `low` |
| `progress` | 进度 | 0~100 整数 |
| `start_date` | 开始日期 | `YYYY-MM-DD` |
| `expected_end_date` | 预计完成日期 | `YYYY-MM-DD` |
| `actual_end_date` | 实际完成日期 | 完成时自动写今天 |
| `current_status` | 一句话现状 | 如「UI 已完成，正在接入后端接口」 |
| `block_reason` | 阻塞原因 | `blocked` 时必填 |
| `is_interrupt_task` | 是否临时插入任务 | `true` / `false` |

### task_updates（时间线）

| 字段 | 说明 |
| --- | --- |
| `type` | `progress` 进展 / `status_change` 状态 / `schedule_change` 排期 / `blocked` 阻塞 / `unblocked` 解除 / `interrupt` 临时插入 / `note` 说明 / `completed` 完成 |
| `content` | 这条变化说了什么（要写清楚，Leader 靠它理解过程） |
| `old_expected_end_date` / `new_expected_end_date` | 排期调整时的旧/新日期 |
| `created_by` | 操作者（Agent 固定写「agent」，网页端写「本人」） |

## 3. 必须遵守的更新规则（违反 = 看板失真）

1. **任何变化都要追加时间线**，绝不只改字段。CLI 的语义命令会自动帮你加。
2. **排期调整必须体现旧日期 → 新日期**（`schedule` 命令自动记录）。
3. **标记完成** = 状态 `completed` + 进度 `100` + 实际完成日=今天（`complete` 命令自动处理）。
4. **标记阻塞必须给原因**；解除阻塞时原因被清空。
5. **临时插入任务**要打上 `--interrupt` 标记，并在内容里说明影响了哪个原任务（这样 Leader 能理解原任务为什么变慢/延期）。
6. 日期统一 `YYYY-MM-DD`；进度是 0~100 整数。
7. 先 `list`/`get` 确认任务 id，再执行修改，避免改错任务。

## 4. 环境准备（Agent 执行前先确认）

```bash
cd work-dashboard
npm install        # 首次
```

- 未配置 `.env` 时，命令读写本地 `data/local.json`（**本地模式**，用于测试）。
- 配置 `.env` 的 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` 后，命令直接写 **线上 Supabase 库**（正式模式）。
- 不确定连的是哪：`npm run agent -- list` 输出的第一行会显示 `[数据模式] local/supabase`。

## 5. 命令速查（全部支持 `--dry-run` 预演、`--json` 机器输出）

```bash
# 查看
npm run agent -- list --status in_progress      # 按状态过滤；--interrupt 只看临时任务
npm run agent -- list                           # 全部任务（拿 id 用）
npm run agent -- get <id>                       # 任务详情 + 时间线

# 新增
npm run agent -- create --title "任务名" \
  --description "描述" --priority high --start 2025-08-20 --end 2025-08-22 \
  [--status in_progress] [--progress 30] [--interrupt] [--note "创建说明"]

# 更新进度 / 状态
npm run agent -- progress <id> --to 75 --note "完成 XX 模块，正在联调"
npm run agent -- status <id> --to paused --note "等待设计稿，暂时挂起"

# 排期
npm run agent -- schedule <id> --end 2025-08-23 --note "接口方案调整，预计顺延一天"

# 阻塞
npm run agent -- block <id> --reason "等待美术资源，预计 8/22 到位"
npm run agent -- unblock <id> --note "素材已到位，恢复开发"

# 完成 / 追加说明
npm run agent -- complete <id> --note "已发布上线，观察无异常"
npm run agent -- note <id> --type interrupt --content "临时插入线上问题排查，占用约2小时"

# 删除（谨慎） / 批量 / 种子
npm run agent -- delete <id>
npm run agent -- batch --file ops.json
npm run agent -- seed --force     # 仅本地演示模式（local）可用；连线上库时请用网页或 create 命令添加真实任务
```

## 6. 自然语言 → 命令 的翻译示例（照着做）

| 用户说 | 你执行 |
| --- | --- |
| 「我新建了一个任务：XXX，预计下周五完成」 | `create --title "XXX" --end <下周五日期> [--priority normal]` |
| 「XXX 做了一半了，大概 50%」 | `progress <id> --to 50` |
| 「XXX 做完了」 | `complete <id> --note <用户提到的补充>` |
| 「XXX 被堵住了，因为等 XX」 | `block <id> --reason "等 XX"` |
| 「XXX 排期要延后两天」 | `schedule <id> --end <新日期> --note "原因"` |
| 「临时插了个事：处理线上告警」 | `create --title "线上告警处理" --interrupt [--status in_progress]` |
| 「我今天在 XXX 上做了这些…」 | `note <id> --type progress --content "<用户原话>"`（必要时同时 `progress` 更新百分比） |
| 「帮我看看现在有什么任务」 | `list`（把结果用自然语言总结给用户） |

**不确定用户意思时**：先 `list` / `get` 现状，再问清楚「新建还是更新？哪个任务？新进度多少？」，不要瞎猜。
**涉及排期变化的**：必须追问原因并写进 `--note` —— 这是看板存在的意义。

## 7. 批量操作（一次应用多个改动）

`ops.json` 可以是数组或 `{ "ops": [...] }`，每个元素一个操作，字段与命令行参数一致：

```json
{
  "ops": [
    { "op": "create", "title": "分享海报生成", "priority": "normal", "end": "2025-08-25", "note": "用户反馈需要分享海报" },
    { "op": "progress", "id": "t-theme", "to": 80, "note": "主题解锁逻辑完成，开始联调" },
    { "op": "schedule", "id": "t-theme", "end": "2025-08-20", "note": "联调比预期顺利，提前一天" },
    { "op": "block", "id": "t-bgm", "reason": "音效资源未到位" }
  ]
}
```

```bash
npm run agent -- batch --file ops.json --dry-run   # 先预演
npm run agent -- batch --file ops.json             # 再执行
```

注意：`create` 的结果里有新任务 id，后续操作如果依赖它，先跑一次 batch 拿 id，再写第二批。

## 8. 安全红线（Agent 必须遵守）

- ❌ **绝不把 `SUPABASE_SERVICE_ROLE_KEY` 写进任何代码、文档、前端或提交到 git** —— 它有数据库管理员权限，一旦进前端/仓库等于把数据库钥匙公开。
- ❌ 不修改 `supabase/schema.sql` 里的表结构（改之前先问用户）。
- ❌ 不执行 `delete` 除非用户明确要求。
- ✅ 本看板无登录/权限控制：网页只读或写库都通过同一套数据，写库请走 CLI，不要绕过。

## 9. 更新完成后

1. 用 `npm run agent -- list` 复查结果，确认状态/进度/日期正确。
2. 用自然语言向用户总结：「已更新看板：XXX 进度 50% → 75%（完成 XX 模块）…」
3. 如果用户是在网页上看的：**数据是动态的，无需重新部署**，刷新页面即可。
