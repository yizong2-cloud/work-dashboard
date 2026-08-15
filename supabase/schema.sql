-- ============================================================
-- 个人工作进度看板 —— Supabase 数据库初始化脚本
-- 在 Supabase 控制台 → SQL Editor 中一次性执行。
--
-- 使用前必改：把下方 is_admin() 里的邮箱换成你自己的管理员邮箱。
-- ============================================================

-- 管理员邮箱（本人）。只改这一处，所有写权限策略都引用它。
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'you@example.com'  -- ← 替换成你的邮箱
$$;

-- ---------------- tasks 表 ----------------
create table if not exists public.tasks (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  description        text not null default '',
  status             text not null default 'planned'
                     check (status in ('planned','in_progress','blocked','paused','completed','cancelled')),
  priority           text not null default 'normal'
                     check (priority in ('high','normal','low')),
  progress           integer not null default 0 check (progress between 0 and 100),
  start_date         date,
  expected_end_date  date,
  actual_end_date    date,
  current_status     text not null default '',
  block_reason       text not null default '',
  is_interrupt_task  boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------- task_updates 表（时间线，保留完整历史） ----------------
create table if not exists public.task_updates (
  id                    uuid primary key default gen_random_uuid(),
  task_id               uuid not null references public.tasks(id) on delete cascade,
  type                  text not null default 'note'
                        check (type in ('progress','status_change','schedule_change','blocked','unblocked','interrupt','note','completed')),
  content               text not null default '',
  old_expected_end_date date,
  new_expected_end_date date,
  created_at            timestamptz not null default now(),
  created_by            text not null default ''
);

create index if not exists task_updates_task_id_idx on public.task_updates (task_id);
create index if not exists tasks_status_idx on public.tasks (status);

-- ---------------- updated_at 自动维护 ----------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------- RLS：开启行级安全 ----------------
alter table public.tasks        enable row level security;
alter table public.task_updates enable row level security;

-- 读：允许所有人（Leader 打开链接即可看，无需登录）。
-- 如需改为「必须登录才能看」，把 using (true) 换成 using (auth.role() = 'authenticated')。
create policy "tasks_select_public"        on public.tasks        for select using (true);
create policy "task_updates_select_public" on public.task_updates for select using (true);

-- 写：仅管理员（本人）可增 / 改 / 删；普通用户即使登录也无写权限。
create policy "tasks_insert_admin"        on public.tasks        for insert with check (public.is_admin());
create policy "tasks_update_admin"        on public.tasks        for update using (public.is_admin());
create policy "tasks_delete_admin"        on public.tasks        for delete using (public.is_admin());

create policy "task_updates_insert_admin" on public.task_updates for insert with check (public.is_admin());
create policy "task_updates_update_admin" on public.task_updates for update using (public.is_admin());
create policy "task_updates_delete_admin" on public.task_updates for delete using (public.is_admin());

-- ============================================================
-- 后续手动步骤（控制台操作，脚本无法代劳）：
--   1. Authentication → Users：创建管理员账号（用你自己的邮箱）
--      （如需 Leader 账号，可再建只读账号；读权限已放开，非必需）
--   2. 可选：Authentication → Providers → Email 开启「邮箱+密码」或 Magic Link
--   3. 把下方注释里的邮箱替换进 is_admin() 后重新执行本脚本（幂等）
-- ============================================================
