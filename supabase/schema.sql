-- ============================================================
-- 个人工作进度看板 —— Supabase 数据库初始化脚本
-- 在 Supabase 控制台 → SQL Editor 中一次性执行。
--
-- 权限说明：本看板仅本人与 Leader 使用，无敏感数据，
-- 不做登录与权限控制 —— RLS 策略全开放，anon key 可读可写。
-- ============================================================

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

-- ---------------- 权限：全开放（无登录、无权限控制） ----------------
-- 仅本人与 Leader 使用，无敏感数据；打开网页即可查看与编辑。
-- 若未来需要加权限，可在此启用 RLS 并按需收紧策略。
alter table public.tasks        enable row level security;
alter table public.task_updates enable row level security;

create policy "allow_all_tasks"        on public.tasks        for all using (true) with check (true);
create policy "allow_all_task_updates" on public.task_updates for all using (true) with check (true);

-- anon（前端网页使用的匿名 key）与 authenticated 角色均授予全权限
grant all on public.tasks        to anon, authenticated;
grant all on public.task_updates to anon, authenticated;
grant usage on schema public to anon, authenticated;
