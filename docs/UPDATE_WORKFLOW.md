# 看板更新流程（运行时精简版）

> 用户说「开始更新」时，优先使用 `workflow/dashboard-update.skill.md`。本文件保留为人类可读的流程契约；不要同时把本文件、总览、命令手册和脚本源码塞进日常 Agent 上下文。

## 固定步骤

```text
prepare → review-packet 全量对账 → evidence 按需展开
        → ops（或空 ops 结案）→ apply --dry-run → apply → verify
```

1. `npm run dashboard:prepare` 采集四源，产出：
   - `workflow/review-packet.json`：日常唯一审查输入，包含每项 `source_id`、短摘录、任务线索与当前任务简表。
   - `workflow/update-context.json`：原始证据库，不可整包读取。
2. Agent 阅读知识库与审查包，对每个 `source_id` 给出 `mapped` / `irrelevant` / `needs_confirmation`。
3. 不确定时才运行 `npm run dashboard:evidence -- --id <source_id>`；一次只展开一个来源项。
4. 输出 `ops.json` 必须带当前 `snapshot_id` 和全量 `reconciliation`。`ops: []` 合法，代表“已审查、无数据变更”。
5. `dashboard:apply` 先 dry-run 再执行；机器校验快照健康、source_id 覆盖/唯一性、任务引用及操作预条件。
6. `dashboard:verify` 通过后才推进分析游标。

## 质量不变的原因

- 四类来源仍全部被盘点；遗漏会被 apply 拒绝。
- 原始飞书、Codex、DSH 内容仍留在快照，可按 ID 展开，不会因摘要截断而丢失。
- 无变更也有可追溯 changeset，避免下次重复审查同一窗口。
- 只有工作流维护、排障或字段扩展时，才阅读 `WORKFLOW_OVERVIEW.md`、`AGENT_GUIDE.md`、`apply.mjs` 等完整资料。
