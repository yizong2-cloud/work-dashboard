# 个人工作进度看板（work-dashboard）

> 一个用于向 Leader 持续透明展示个人任务、进度、排期及变化原因的轻量级个人工作看板。

- **前端**：React 18 + Vite 5 + TypeScript + React Router
- **后端 / 数据库**：Supabase（PostgreSQL + Auth + RLS）
- **托管**：GitHub Pages（免费、0 运维）
- **维护方式**：本人（网页操作）+ **Agent（自然语言 → CLI 自动更新）**

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
│   ├── pages/              # Dashboard / TaskDetail / Login
│   ├── components/         # TaskCard / TaskTimeline / QuickUpdateModal ...
│   ├── lib/                # 数据层（local / supabase 双实现）+ taskService
│   ├── context/            # AuthContext（登录态 / 管理员判断）
│   ├── hooks/
│   ├── types.ts            # 数据模型契约
│   └── styles.css
├── scripts/                # Agent 更新接口（Node CLI）
│   ├── agent.js            # 主入口：list/get/create/progress/schedule/block/...
│   ├── seed.json           # 种子演示数据
│   └── lib/                # 参数解析 / .env 加载 / 存储层
├── supabase/schema.sql     # 建表 + RLS + 触发器（唯一数据契约）
├── docs/
│   ├── SETUP.md            # 部署上线教程（Supabase + GitHub Pages）
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

## 关键约定

- 每次「变化」都会追加一条时间线记录（`task_updates`），绝不只覆盖字段 —— 这是 Leader 能看到「为什么延期/变化」的基础。
- 前端只使用 Supabase **anon key**；`service_role key` 仅存在于本地 `.env`，**严禁进入前端或提交仓库**。
- 写权限由数据库 RLS 控制（只有管理员邮箱可写），不依赖前端隐藏按钮。

## 后续可扩展（已预留）

- Supabase Realtime 自动刷新
- 基于 `task_updates` 的日报/周报生成
- 排期时间轴 / 统计

详细部署步骤见 [docs/SETUP.md](docs/SETUP.md)。
