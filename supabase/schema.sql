-- ============================================================
-- 个人工作进度看板 —— Supabase 数据库初始化脚本
-- 在 Supabase 控制台 → SQL Editor 中一次性执行。
-- 脚本幂等：可重复执行（策略先 drop 再 create，函数 create or replace）。
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
  updated_at         timestamptz not null default now(),
  -- 状态不变量（数据库强制，代码绕不过）：
  --   已完成的任务进度必须为 100；被阻塞的任务必须有阻塞原因。
  constraint tasks_completed_progress_ck check (status <> 'completed' or progress = 100),
  constraint tasks_blocked_reason_ck     check (status <> 'blocked' or block_reason <> '')
);

-- ---------------- 状态不变量（数据库强制，代码绕不过） ----------------
-- 注意：对已存在的表，create table if not exists 不会追加约束，
-- 因此这里用 DO block 幂等添加（新库则由建表语句自带约束）。
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_completed_progress_ck') then
    alter table public.tasks add constraint tasks_completed_progress_ck check (status <> 'completed' or progress = 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_blocked_reason_ck') then
    alter table public.tasks add constraint tasks_blocked_reason_ck check (status <> 'blocked' or block_reason <> '');
  end if;
end $$;

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

-- ---------------- 原子更新 RPC（任务字段 + 时间线 一次事务写入） ----------------
-- CLI 与网页的「状态类更新」（进度/状态/排期/阻塞/完成）都走这个函数，
-- 保证字段变更与时间线要么同时成功、要么同时失败，不会出现改了字段没记时间线的中间态。
-- 注意：p_patch 用 coalesce 语义，未提供的字段保持不变；不支持显式置 NULL。
create or replace function public.apply_task_update(
  p_task_id uuid,
  p_patch jsonb,
  p_type text default 'note',
  p_content text default '',
  p_old_date date default null,
  p_new_date date default null,
  p_created_by text default 'agent'
) returns public.tasks
language plpgsql
security definer
as $$
declare v_task public.tasks;
begin
  update public.tasks t
    set title             = coalesce(p_patch->>'title', t.title),
        description       = coalesce(p_patch->>'description', t.description),
        status            = coalesce(p_patch->>'status', t.status),
        priority          = coalesce(p_patch->>'priority', t.priority),
        progress          = coalesce((p_patch->>'progress')::int, t.progress),
        start_date        = coalesce((p_patch->>'start_date')::date, t.start_date),
        expected_end_date = coalesce((p_patch->>'expected_end_date')::date, t.expected_end_date),
        actual_end_date   = coalesce((p_patch->>'actual_end_date')::date, t.actual_end_date),
        current_status    = coalesce(p_patch->>'current_status', t.current_status),
        block_reason      = coalesce(p_patch->>'block_reason', t.block_reason),
        is_interrupt_task = coalesce((p_patch->>'is_interrupt_task')::boolean, t.is_interrupt_task),
        updated_at        = now()
    where t.id = p_task_id
    returning * into v_task;

  if v_task is null then
    raise exception '任务不存在: %', p_task_id;
  end if;

  insert into public.task_updates (task_id, type, content, old_expected_end_date, new_expected_end_date, created_at, created_by)
  values (p_task_id, p_type, p_content, p_old_date, p_new_date, now(), p_created_by);

  return v_task;
end;
$$;

grant execute on function public.apply_task_update(uuid, jsonb, text, text, date, date, text) to anon, authenticated;

-- ---------------- 权限：全开放（无登录、无权限控制） ----------------
-- 仅本人与 Leader 使用，无敏感数据；打开网页即可查看与编辑。
-- 若未来需要加权限，可在此收紧策略。
alter table public.tasks        enable row level security;
alter table public.task_updates enable row level security;

drop policy if exists allow_all_tasks        on public.tasks;
drop policy if exists allow_all_task_updates on public.task_updates;
create policy allow_all_tasks        on public.tasks        for all using (true) with check (true);
create policy allow_all_task_updates on public.task_updates for all using (true) with check (true);

-- anon（前端网页使用的匿名 key）与 authenticated 角色均授予全权限
grant all on public.tasks        to anon, authenticated;
grant all on public.task_updates to anon, authenticated;
grant usage on schema public to anon, authenticated;
