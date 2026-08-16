# 看板「一条龙」更新流程（Agent 执行手册）

> 用户说 **「开始更新」/「应该更新了」** 时，按本流程执行。
> 目标：拉取最新飞书聊天 → 增量分析 → 更新线上看板 → 汇报，全程无需用户手动操作网页。

## 触发与前置

- 触发词：用户说「开始更新」「应该更新了」「帮我更新看板」等。
- 前置：项目根目录 `.env` 已配置（`VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`），Agent CLI 连线上库。

## 执行步骤

### 第 1 步：增量导出飞书聊天（机械化）

```bash
npm run update:export
# 等价于: ~/feishu_export/bin/feishu-export --incremental --markdown
```

- 输出到 `~/feishu_export/daily/`：最新 `range_*.json` + `range_*.md`（喂 AI 的 Markdown）。
- 若提示 cookie 过期：让用户重新从浏览器导出飞书 cookies 覆盖 `~/feishu_export/cookies.json`。
- 导出结果可能提示「没有新消息」——那本次只需检查确认，无需分析。

### 第 1.5 步：读取 Agent 工作摘要（真实工作进度第二/三来源）

```bash
npm run update:codex   # 读取 Codex 会话摘要（~/.codex/sessions）
npm run update:dsh     # 读取 DSH 会话摘要（~/.dsh/sessions，需本机 zstd）
```

- 输出每个会话：时间、工作目录（cwd）、用户请求、git commit 等。
- **飞书是沟通记录，Codex/DSH 是实际干活记录**——都要看，互相印证。
- 用 `docs/KNOWLEDGE_BASE.md` 第六节「项目目录 ↔ 看板任务映射」把会话关联到看板任务。
- DSH 会话包含用户用 DSH 处理的问题（如 BI 平台排查），是重要的进度来源。

### 第 2 步：读取三份上下文（并行）

1. **新导出的聊天**：`~/feishu_export/daily/` 里最新的 `range_*.md`
2. **任务上下文库**：`docs/KNOWLEDGE_BASE.md`（任务别名映射、已确认事实、依赖关系）
3. **当前线上任务**：`npm run agent -- list`（拿现有任务 id 与状态，避免重复创建）

### 第 3 步：增量分析（可派子 Agent）

把「新导出的聊天内容 + KNOWLEDGE_BASE.md + 当前任务清单」交给子 Agent 分析，规则：

- **只分析导出时间范围内的新消息**（增量游标保证不重不漏）。
- 先对照 KNOWLEDGE_BASE「任务别名映射」：命中的已有任务 → 更新该任务，**不新建**。
- 新出现的任务 → 按看板数据模型（title/status/priority/progress/日期/时间线）提炼。
- 口头确认、面聊信息以 KNOWLEDGE_BASE「已确认事实」为准，不被聊天推断覆盖。
- 产出：结构化的「变更建议」—— 每个改动对应一条 CLI 命令（create/progress/schedule/block/unblock/complete/note/update/status）。

### 第 4 步：执行 CLI 更新

```bash
npm run agent -- progress <id> --to 80 --note "..."
npm run agent -- create --title "..." --end YYYY-MM-DD ...
npm run agent -- schedule <id> --end YYYY-MM-DD --note "原因"
npm run agent -- update <id> --description "..." --current_status "..." --note "..."
npm run agent -- batch --file ops.json   # 改动多时用批量
```

先 `--dry-run` 预演再执行（可选）。

### 第 5 步：回写 KNOWLEDGE_BASE

分析中发现的新别名、新口头确认、新依赖 → 追加到 `docs/KNOWLEDGE_BASE.md` 对应小节，并 `git commit`。

### 第 6 步：汇报

向用户说明：本次更新了哪些任务（新增/进度/排期/阻塞/完成），是否有不确定点需要确认。**数据实时生效，用户刷新网页即见，无需重新部署。**

## 常用命令速查

```bash
npm run update:export          # ① 导出飞书增量
npm run update:codex           # ② 读取 Codex 工作摘要（真实干活记录）
npm run agent -- list          # 看当前任务
npm run agent -- get <id>      # 看任务详情+时间线
npm run agent -- progress <id> --to 70 --note "..."
npm run agent -- schedule <id> --end 2026-08-25 --note "..."
npm run agent -- block <id> --reason "..."
npm run agent -- unblock <id> --note "..."
npm run agent -- complete <id> --note "..."
npm run agent -- note <id> --type progress --content "..."
npm run agent -- update <id> --description "..." --current_status "..." --note "..."
npm run agent -- create --title "..." --priority normal --end YYYY-MM-DD
```

完整命令说明见 `docs/AGENT_GUIDE.md`。

## 常见问题（实测踩坑记录）

- **首次运行**不能用 `--incremental`（会提示"状态文件中没有上次同步记录"）——首次用 `--since YYYY-MM-DDT00:00 --markdown`，之后才有增量游标。
- **会话打开失败（openfail）**：偶发，重跑一次并加 `--refresh-chats` 强制重扫会话列表即可。
- **大量会话被"跳过（无更新）"**：正常，工具按会话最后活跃时间判断，只有有更新的会话才会打开。
- **导出的消息多是闲聊/表情包**：正常，分析时要过滤掉（图片、表情、玩笑话），只提炼实质工作。
- **本次无实质更新**：流程正常结束，看板不用改，向用户说明即可。
- **cookies 过期**：工具提示登录态失效时，让用户重新导出飞书 cookies 覆盖 `~/feishu_export/cookies.json`。
