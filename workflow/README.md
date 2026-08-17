# 看板更新「唯一入口」

> 目标：让任何 Agent（或人）只需一条命令即可完成看板更新准备；让定时任务无人值守拉数据。
> **分析（LLM 判断）与写入由 Agent 按需触发**——需要语义理解，且用户确认更稳。

## 命令总览

| 命令 | 作用 |
| --- | --- |
| `npm run dashboard:prepare` | 拉取四数据源（飞书/Codex/DSH/本地 Downloads 白名单）+ 当前看板 + 知识库 + 候选提示，打包 `workflow/update-context.json`，生成 `workflow/latest-report.md`（规则化提示，无需 LLM）。**可无人值守** |
| `npm run dashboard:apply -- --file ops.json` | 校验并执行变更建议（先 `-- --dry-run` 预演） |
| `npm run dashboard:verify` | 校验数据不变量 + 输出健康报告 |
| `npm run dashboard:cron:install` | 安装定时任务（macOS launchd，工作日 11:00/15:30/19:30 自动 `prepare` + 通知，无状态不推进游标） |
| `npm run dashboard:cron:uninstall` | 卸载定时任务 |

## 一条龙流程（用户说「开始更新」时）

```text
prepare → Agent 分析 update-context.json（结合 KNOWLEDGE_BASE）
        → 产出 workflow/ops.json → apply --dry-run → apply → verify → 回写知识库 → 汇报
```

对应命令序列：

```bash
npm run dashboard:prepare                        # ① 拉数据打包
# Agent 读取 workflow/update-context.json + docs/KNOWLEDGE_BASE.md，增量分析
# 产出 workflow/ops.json（格式见 operation.schema.json）
npm run dashboard:apply -- --dry-run             # ② 预演
npm run dashboard:apply                          # ③ 执行
npm run dashboard:verify                         # ④ 校验
# 新别名/事实回写 KNOWLEDGE_BASE 并 git commit
```

## 定时任务（工作日每天 3 次自动准备）

- 安装：`npm run dashboard:cron:install`（**周一至周五** 的 **11:00 / 15:30 / 19:30** 自动跑 `prepare`，完成后发 macOS 通知）
- 通知内容会提示「活跃任务未排期数量」，提醒你有数据可更新
- 你看到通知后说「开始更新」→ Agent 走上面的一条龙（分析+写入）
- 日志：`~/Library/Logs/work-dashboard-prepare.{out,err}.log`
- 卸载：`npm run dashboard:cron:uninstall`；状态：`launchctl list | grep workdashboard`

> 说明：定时任务只做**机械的拉取与打包**（安全、无写入）；分析判断交给 Agent 在你确认后执行，
> 避免 LLM 误判直接自动写库。如后续要「全自动分析写入」，需要接入 LLM API + 高风险变更人工闸门。

## DSH Skill（可选）

`workflow/dashboard-update.skill.md` 是按 DSH skill 格式（SKILL.md + frontmatter）写的技能草稿，
供在 DSH 中把「更新看板」变成可调用的技能；注册方式随 DSH 版本而定，本文件为独立交付物。
