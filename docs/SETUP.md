# 部署上线教程（Supabase + GitHub Pages）

> 按顺序操作，总耗时约 20~30 分钟，全程 0 元。
> 本教程面向没接触过 Supabase 的新手，每一步都写到了「点哪里」。

## 第 1 步：注册 / 登录 Supabase（约 3 分钟）

1. 打开浏览器，访问 **https://supabase.com**
2. 点右上角 **Start your project**（或 **Sign in**）
3. 用 **GitHub 账号**登录（Sign in with GitHub），也可以填邮箱注册。授权页面点允许即可
4. 登录后进入后台（Dashboard）

## 第 2 步：创建项目（约 5 分钟）

1. 在 Dashboard 页面点 **New project**（绿色按钮，或左上角「+ New project」）
2. **Organization**：如果没有组织，点旁边的 **New organization** 随便建一个（名字随意，如 `personal`）；有的话直接选
3. **Project name**：填 `work-dashboard`
4. **Database Password**：填一个密码（**一定要记住**，随便编一个长密码，比如 `Wb-2026-xxxx` 之类的，记到备忘录里）。也可以点 **Generate a password** 让系统生成，复制保存
5. **Region**：选 **Southeast Asia (Singapore)** —— 离国内近，访问快
6. **Pricing plan**：选 **Free**（免费）
7. 点 **Create new project**，等它初始化（大概 1~3 分钟，页面会显示进度）

## 第 3 步：找到你的 URL 和 Key（约 2 分钟）

1. 项目创建完成后，进入项目控制台。看**左侧栏最底部**的 **Project Settings**（齿轮图标）→ 点进去
2. 左侧菜单选 **API**
3. 在这个页面你会看到三样东西，**把前两个复制给我**：
   - **Project URL**：形如 `https://xxxxxxxx.supabase.co`
   - **anon public**（也叫 anon key）：一长串以 `eyJhbGciOi...` 开头的字符，复制时点旁边的 **Copy** 按钮，选「anon public」那行
   - （**service_role** 那行先不用动，等会儿你发我 anon key 后我再告诉你用不用）

> 复制好后直接发给我即可，例如：
> Project URL: https://abc123.supabase.co
> anon key: eyJhbGciOiJIUzI1NiIs...

## 第 4 步：建数据库表（约 3 分钟，复制粘贴即可）

1. 回到项目控制台，左侧栏点 **SQL Editor**（有个「>_」图标）
2. 点 **New query**（新建查询）
3. 把仓库里的 **`supabase/schema.sql`** 文件内容全部复制，粘贴到中间的大编辑框里
   （不会看文件？用编辑器打开 `work-dashboard/supabase/schema.sql`，全选复制即可）
4. 点右下角绿色 **Run**（或 **Run** 按钮）
5. 看到绿色对勾 / "Success. No rows returned" 之类的提示 = 成功
6. 验证一下：左侧栏点 **Table Editor**，应该能看到 `tasks` 和 `task_updates` 两张表

> 这个脚本已经配置好：无需登录、任何人打开网页都能查看和编辑（只有你和你 Leader 看，没有敏感信息）。

## 第 5 步：把网站部署到 GitHub Pages（我来做，约 5 分钟）

你只需要告诉我两件事：

1. **用哪个 GitHub 账号部署**（你之前问过：GitHub Pages 没有「一个账号只能部署一个网站」的限制，每个仓库都能独立部署一个站点，两个号都行。推荐用你平时常用的 `yizong-boop`，或者你指定的 `yizong2-cloud`）
2. **仓库名**：建议直接用 `work-dashboard`（部署后网址就是 `https://<用户名>.github.io/work-dashboard/`）

剩下的事我来做：
- 用你的 `gh` CLI 创建仓库并推送代码
- 在仓库 Settings 里把 Pages 源设为 GitHub Actions
- 配置两个 Actions Secrets（`SUPABASE_URL`、`SUPABASE_ANON_KEY`）
- 触发第一次构建部署，然后给你最终网址

## 第 6 步：本地配置 Agent 写库权限（可选，但强烈推荐）

之后你想「用自然语言让 Agent 更新网站」，需要让 Agent CLI 能写 Supabase：

1. 在 `work-dashboard` 目录复制一份环境文件：把 `.env.example` 复制为 `.env`（macOS：`cp .env.example .env`）
2. 用编辑器打开 `.env` 填入：
   - `VITE_DATA_MODE=supabase`
   - `VITE_SUPABASE_URL=` 填第 3 步的 Project URL
   - `VITE_SUPABASE_ANON_KEY=` 填第 3 步的 anon key
   - `SUPABASE_SERVICE_ROLE_KEY=` 填 Supabase 控制台 Project Settings → API 里的 **service_role**（一长串以 `eyJ...` 开头）
3. 测试：在终端运行 `npm run agent -- list`，如果输出了任务列表，说明 Agent 已经能读写线上库了

> `.env` 已被 git 忽略（不会提交），service_role key 只存在于你本机。

## 安全注意事项（必读）

- ✅ 前端只放 `anon key`（本来就是公开的，无所谓）。
- ❌ **绝不**把 `service_role key` 写进前端代码或提交到仓库 —— 它等于数据库的万能钥匙。
- 本看板按你的要求**不做任何登录/权限控制**；如果以后有敏感内容了，再找我加。

## 常见问题

- **网页打开是空白/报错？** 大概率是 Secrets 里的 URL 或 anon key 复制错了，或 SQL 没执行成功。重新核对第 3、4 步。
- **Agent CLI 报「任务不存在」？** 确认 `.env` 里 `SUPABASE_SERVICE_ROLE_KEY` 填的是 service_role（不是 anon）。
- **想改网址（自定义域名）？** 仓库 Settings → Pages → Custom domain。
