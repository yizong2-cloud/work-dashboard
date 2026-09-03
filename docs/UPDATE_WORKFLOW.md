# 看板更新流程（运行时精简版）

> 用户说「开始更新」时，优先使用 `workflow/dashboard-update.skill.md`。本文件保留为人类可读的流程契约；不要同时把本文件、总览、命令手册和脚本源码塞进日常 Agent 上下文。

入口约束：在 `/Users/zongyi/Workspace/work-dashboard` 运行 `dashboard:prepare`。不要直接调用 `feishu-export`；聊天代码来自 `feishu-export-public`，Cookies 与输出来自私有 `feishu_export` 工作目录，两者由 prepare 组合为同一条采集链路。

## 固定步骤

```text
prepare → review-packet 全量对账 → evidence 按需展开
        → ops（或空 ops 结案）→ 待确认？保存 pending 并提问/停止
        → 无待确认 → apply --dry-run → publish preview → 用户确认 → apply → verify
```

1. `npm run dashboard:prepare` 采集四源，产出：
   - `workflow/review-packet.json`：日常唯一审查输入，包含每项 `source_id`、短摘录、任务线索与当前任务简表。
   - `workflow/update-context.json`：原始证据库，不可整包读取。
   - 最近一次健康快照另存为 `last-healthy-*.json`，只供采集故障时按 ID 对照，不参与当前对账或 apply。
2. Agent 先完整阅读知识库，再读审查包，对每个 `source_id` 给出 `mapped` / `irrelevant` / `needs_confirmation`。
3. 不确定时才运行 `npm run dashboard:evidence -- --id <source_id>`；一次只展开一个来源项。只有排障时才可追加 `--last-healthy`，且不得据此生成当前快照的 ops。
4. 输出 `ops.json` 必须带当前 `snapshot_id` 和全量 `reconciliation`。`ops: []` 合法，代表“已审查、无数据变更”。回复只引用 apply 生成的对账摘要，不重复逐条表格。
5. 若 reconciliation 有 `needs_confirmation`，运行 `npm run dashboard:pending -- hold`。它会保存当前快照的 pending plan，并输出可直接发给用户的逐项确认单；此时 apply/verify 都会拒绝继续。
6. 用户确认后，用 `npm run dashboard:pending -- resolve ...` 只更新对应 source_id 的结论；同一快照未过期时不得重新 prepare 或重做四源分析。全部解决后才继续 apply。
7. `dashboard:apply --dry-run` 通过后运行 `dashboard:publish -- preview`，把命令生成的完整预览逐项直接发在对话里并停止；数量摘要或文件链接不能代替正文。预览不会写库或触发飞书。
8. 用户对当前完整预览明确回复「确认」「可以更新」「按这版推送」等清晰授权后，把用户原话传给 `dashboard:publish -- confirm --phrase "<用户原话>"`，再执行 `dashboard:apply`。无需固定口令；机器仍校验快照健康、source_id 覆盖/唯一性、未解决确认项、任务引用、操作预条件和预览确认指纹。
9. apply 会先调用真实执行器对整批操作做无写入预检。若预检通过后仍因临时外部故障出现部分失败，changeset 保留整批逐项状态和原授权；运行 `dashboard:update -- retry` 只重试失败项，不重新确认、不手工删 ops。
10. `dashboard:verify` 通过后才推进分析游标。

对账回复建议格式：`对账共 N 项：已映射 A、无关 B、待确认 C；本次补录 X 项`。逐项结论仍保存在 `ops.json`，并由 apply 闸门逐项校验。

通知与进度是两个独立事实：`progress.to` 才是任务百分比；`note(type=progress)` 只记录阶段进展。预览和 apply 都会输出“即时入队/静默/历史补记”意图；只有 `dashboard:notify-status` 的实际状态才能表述为投递已送达。

## 质量不变的原因

- 四类来源仍全部被盘点；遗漏会被 apply 拒绝。
- 原始飞书、Codex、DSH 内容仍留在快照，可按 ID 展开，不会因摘要截断而丢失。
- 无变更也有可追溯 changeset，避免下次重复审查同一窗口。
- 只有工作流维护、排障或字段扩展时，才阅读 `WORKFLOW_OVERVIEW.md`、`AGENT_GUIDE.md`、`apply.mjs` 等完整资料。
