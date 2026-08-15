# 部署上线教程（Supabase + GitHub Pages）

> 按顺序操作，总耗时约 20~30 分钟，全程 0 元。

## 第 1 步：创建 Supabase 项目

1. 打开 https://supabase.com 注册/登录（可用 GitHub 账号）。
2. 创建新项目：`New project` → 填项目名（如 `work-dashboard`）、数据库密码 → **区域建议选 Singapore 或 Tokyo**（国内访问更快）。
3. 创建完成后进入项目 Dashboard。

## 第 2 步：执行数据库脚本

1. 左侧菜单 → **SQL Editor** → `New query`。
2. 把 `supabase/schema.sql` 全部内容粘贴进去。
3. **修改脚本中的管理员邮箱**：把 `is_admin()` 里的 `'you@example.com'` 换成你自己的邮箱。
4. 点 **Run**。看到成功提示即可。

> 脚本是幂等的，以后想改管理员邮箱或调整权限，改完重新执行即可。

## 第 3 步：创建账号

1. 左侧菜单 → **Authentication** → **Users** → `Add user` → 创建管理员账号（用你自己的邮箱，设置密码）。
2. （可选）**Authentication → Providers → Email**：勾选 `Enable Sign up`、`Confirm email`。
   - 若想用「魔法链接免密码登录」，保持默认开启即可（登录页有对应按钮）。

> Leader 是否需要账号？
> 当前 RLS 配置是「所有人可读、仅管理员可写」，所以 **Leader 无需登录就能看**。
> 如果想改成「必须登录才能看」，把 schema.sql 里两条 `select using (true)` 改成
> `select using (auth.role() = 'authenticated')`，再给 Leader 建一个只读账号。

## 第 4 步：配置 GitHub 仓库 + 自动部署

1. 在 GitHub 新建仓库，例如 `work-dashboard`（**必须是 main 分支**）。
2. 把本目录推上去：

   ```bash
   cd work-dashboard
   git init
   git add .
   git commit -m "init: 个人工作进度看板"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/work-dashboard.git
   git push -u origin main
   ```

3. 仓库 Settings → **Pages** → Source 选 **GitHub Actions**（重要，选 Actions 而不是 branch）。
4. 仓库 Settings → **Secrets and variables → Actions**，添加以下 Secrets：

   | Secret 名 | 值 | 从哪拿 |
   | --- | --- | --- |
   | `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Project Settings → API |
   | `SUPABASE_ANON_KEY` | `anon` 开头的 key | 同上（API → anon public key） |
   | `ADMIN_EMAIL` | 你的管理员邮箱 | 你填的 |

5. push 后 GitHub Actions 会自动构建部署，完成后访问 `https://<你的用户名>.github.io/work-dashboard/`。

> 部署用 `VITE_BASE=/仓库名/` 自动注入，无需改代码。

## 第 5 步：本地配置 Agent 写库权限（可选，推荐）

Agent CLI 需要 `service_role` key 才能以管理员身份直接写 Supabase：

1. 复制 `.env.example` 为 `.env`（**`.env` 已被 gitignore，不会提交**）。
2. 填入：

   ```dotenv
   VITE_DATA_MODE=supabase
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>   # 仅本地，严禁提交
   ADMIN_EMAIL=you@example.com
   ```

3. `service_role` key 位置：Supabase → Project Settings → API → `service_role` secret。

## 第 6 步：上线验证

1. 打开 GitHub Pages 网址 → 应看到看板页面（数据来自 Supabase）。
2. 点右上角「登录」→ 用管理员账号登录 → 出现「＋新建任务」等编辑按钮。
3. 用手机浏览器打开同一网址，确认移动端可用。

## 安全注意事项（必读）

- ✅ 前端只用 `anon key`（本来就是公开的）。
- ❌ **绝不**把 `service_role key` 写进前端代码、`.env.example` 或提交到仓库。
- ✅ 写权限靠数据库 RLS 把关；就算有人拿到 anon key，也无法增删改。
- 如果将来想撤销 Agent 写库权限，删除本地 `.env` 里的 `SUPABASE_SERVICE_ROLE_KEY` 即可（不影响网页只读/管理员网页操作）。

## 常见问题

- **登录后没有编辑按钮？** 检查 `.env` 的 `VITE_ADMIN_EMAIL` 是否与 `is_admin()` 中的邮箱一致。
- **网页数据是空白的？** 先在 SQL Editor 执行 `select * from public.tasks;` 确认有数据；再检查 `VITE_SUPABASE_URL/ANON_KEY` 是否正确（需重新部署或本地 dev 重启）。
- **想改域名？** 支持自定义域名：仓库 Settings → Pages → Custom domain。
