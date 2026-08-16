# 个人工作进度看板（work-dashboard）

> 一个用于向 Leader 持续透明展示个人任务、进度、排期及变化原因的轻量级个人工作看板。
> **维护方式**：用自然语言告诉 Agent，Agent 自动更新网站（飞书 + Codex + DSH 三数据源）。

**系统全景**：先读 **[docs/WORKFLOW_OVERVIEW.md](docs/WORKFLOW_OVERVIEW.md)**（完整工作流程与组件说明）。

- **前端**：React 18 + Vite 5 + TypeScript + React Router
- **后端 / 数据库**：Supabase（PostgreSQL）
- **托管**：GitHub Pages（免费、0 运维）
- **维护方式**：本人直接操作网页 + **Agent（自然语言 → CLI 自动更新）**
- **权限**：无登录、无权限控制 —— 仅本人与 Leader 使用，打开即看、即改

## 快速开始

```bash
npm install
npm run dev        # 本地开发（默认 local 演示模式，无需任何配置）
```

浏览器打开 `http://localhost:5173` 即可看到演示看板（数据存在浏览器 localStorage）。

## 目录结构

```text
work-dashboard/
├── src/                    # 前端
│   ├── pages/              # Dashboard / TaskDetail
│   ├── components/         # TaskCard / TaskTimeline / QuickUpdateModal ...
│   ├── lib/                # 数据层（local / supabase 双实现）+ taskService
│   ├── hooks/
│   ├── types.ts            # 数据模型契约
│   └── styles.css
├── scripts/                # Agent 更新接口（Node CLI）
│   ├── agent.js            # 主入口：list/get/create/progress/schedule/block/...
│   ├── seed.json           # 种子演示数据
│   └── lib/                # 参数解析 / .env 加载 / 存储层
├── supabase/schema.sql     # 建表 + 全开放策略（唯一数据契约）
├── docs/
│   ├── SETUP.md            # 部署上线教程（Supabase + GitHub Pages，含新手步骤）
│   └── AGENT_GUIDE.md      # Agent 维护手册（自然语言 → CLI 命令）
├── .github/workflows/deploy.yml  # GitHub Pages 自动部署
└── .env.example            # 环境变量样例（绝不提交 .env 本身）
```

## 两种数据模式

| 模式 | 何时使用 | 数据位置 |
| --- | --- | --- |
| `local`（默认） | 本地演示 / 未配置 Supabase | 浏览器 localStorage（网页）/ `data/local.json`（CLI） |
| `supabase` | 正式上线 | Supabase PostgreSQL |

切换方式：`.env` 中设置 `VITE_DATA_MODE=supabase` 及 Supabase 连接信息（见 `.env.example` 与 `docs/SETUP.md`）。

## Agent 更新接口（重要）

这个项目的定位是：**以后你想更新网站时，用自然语言告诉 Agent，Agent 帮你改**，你不必手动在网页上操作。

因此项目预留了两套接口：

1. **`npm run agent -- <命令>`** —— 结构化 CLI（新建任务 / 更新进度 / 调整排期 / 标记阻塞 / 标记完成 / 追加时间线…）
2. **`npm run agent -- batch --file ops.json`** —— 批量 JSON 操作，适合 Agent 一次性应用多个改动

所有命令支持 `--dry-run` 预演。详见 **[docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md)**（这是给未来 Agent 看的操作手册，请连同代码一起交给它）。

## 一条龙更新流程（"开始更新"即触发）

用户说「开始更新」→ `npm run update:export` 自动拉取飞书最新聊天（调用用户自写的 `feishu-export` 工具）→ Agent 结合 **[docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md)**（任务别名映射/已确认事实/依赖关系）做增量分析 → 通过 CLI 更新线上数据 → 刷新即见。完整流程见 **[docs/UPDATE_WORKFLOW.md](docs/UPDATE_WORKFLOW.md)**。

## 关键约定

- 每次「变化」都会追加一条时间线记录（`task_updates`），绝不只覆盖字段 —— 这是 Leader 能看到「为什么延期/变化」的基础。
- 前端只使用 Supabase **anon key**；`service_role key` 仅存在于本地 `.env`，**严禁进入前端或提交仓库**（它有数据库管理员权限，一旦泄露数据库等于裸奔）。
- 数据库已按「无权限控制」配置：任何人拿到网页地址都可查看与编辑（仅本人与 Leader 使用，无敏感数据）。

## 后续可扩展（已预留）

- Supabase Realtime 自动刷新
- 基于 `task_updates` 的日报/周报生成
- 排期时间轴 / 统计

详细部署步骤见 [docs/SETUP.md](docs/SETUP.md)。
