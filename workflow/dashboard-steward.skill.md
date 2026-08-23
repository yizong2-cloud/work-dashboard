---
name: dashboard-steward
description: 管理和整理 Workboard 的任务质量、处理箱、排期与陈旧信息。适用于“整理看板”“检查看板是否乱了”“处理处理箱”或要求 Agent 主动维护工作状态；“开始更新”仍使用 dashboard-update。
---

# Workboard Agent 治理

仓库：`/Users/zongyi/Workspace/work-dashboard`。这是**治理入口**，不是数据源更新入口。

## 先做只读体检

运行：

```bash
cd /Users/zongyi/Workspace/work-dashboard
npm run dashboard:steward -- --json
```

它会统一发现：给 Agent 的未结处理箱、逾期、长期未更新、缺少一句话现状、未排期、近期到期但无日计划、完成状态不一致、精确标题重复候选，以及孤儿时间线。报告本身不写库、不发飞书、不改变任务。

## 如何处理结果

- 处理箱优先。开始处理时用 `agent inbox-reply` 回写理解并标记处理中；完成并验证后才回写结果、标记解决。
- 报告只是一张待办清单，不是事实来源。更新进度、现状、任务名称、描述或日期前，必须有用户指令或可核验证据。
- 需要查看飞书 / Codex / DSH / 本地工作证据时，转入 `$dashboard-update` 的采集、全量对账、预览与「确认推送」流程；不要绕过它直接猜测写入。
- 可以在已有明确证据下使用 `agent progress/update/schedule/block/complete/plan-*` 等语义命令；保留时间线原因。
- 标题重复只提示，绝不自动合并或删除。语义“润色”先给用户看前后对比，得到明确确认再写入。

## 不变量

- 看板由 Agent 维护，不代表 Agent 可以编造事实。
- 不做 `delete`，除非用户明确要求。
- 不把 service role、Cookies 或任何本机凭据写入文件、输出或提交。
- 对来源驱动的批量更新，必须先发完整预览；只有用户说「确认推送」才可写入或触发通知。
