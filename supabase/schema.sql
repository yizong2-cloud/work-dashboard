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
  --   已完成的任务进度必须为 100 且必须有实际完成日期；
  --   被阻塞的任务必须有阻塞原因（trim 后非空）。
  constraint tasks_completed_progress_ck check (status <> 'completed' or progress = 100),
  constraint tasks_completed_actual_ck   check (status <> 'completed' or actual_end_date is not null),
  constraint tasks_blocked_reason_ck     check (status <> 'blocked' or btrim(block_reason) <> '')
);

-- ---------------- 状态不变量（数据库强制，代码绕不过） ----------------
-- 注意：对已存在的表，create table if not exists 不会追加约束，
-- 因此这里用 DO block 幂等重建（新库则由建表语句自带约束）。
do $$
begin
  alter table public.tasks drop constraint if exists tasks_completed_progress_ck;
  alter table public.tasks add constraint tasks_completed_progress_ck check (status <> 'completed' or progress = 100);
  alter table public.tasks drop constraint if exists tasks_completed_actual_ck;
  alter table public.tasks add constraint tasks_completed_actual_ck check (status <> 'completed' or actual_end_date is not null);
  alter table public.tasks drop constraint if exists tasks_blocked_reason_ck;
  alter table public.tasks add constraint tasks_blocked_reason_ck check (status <> 'blocked' or btrim(block_reason) <> '');
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

-- ---------------- 原子创建 RPC（创建任务 + 初始时间线 一次事务） ----------------
create or replace function public.create_task_with_note(
  p_title text,
  p_patch jsonb default '{}'::jsonb,
  p_content text default '任务创建。',
  p_created_by text default 'agent'
) returns public.tasks
language plpgsql
security definer
as $$
declare v_task public.tasks;
begin
  insert into public.tasks (title, description, status, priority, progress, start_date, expected_end_date, is_interrupt_task, current_status)
  values (
    p_title,
    coalesce(p_patch->>'description', ''),
    coalesce(p_patch->>'status', 'planned'),
    coalesce(p_patch->>'priority', 'normal'),
    coalesce((p_patch->>'progress')::int, 0),
    (p_patch->>'start_date')::date,
    (p_patch->>'expected_end_date')::date,
    coalesce((p_patch->>'is_interrupt_task')::boolean, false),
    coalesce(p_patch->>'current_status', '')
  )
  returning * into v_task;

  insert into public.task_updates (task_id, type, content, created_by)
  values (v_task.id, 'note', p_content, p_created_by);

  return v_task;
end;
$$;

grant execute on function public.create_task_with_note(text, jsonb, text, text) to anon, authenticated;

-- ============================================================
-- 反馈线程（任务一：Leader 留言升级为可回复/可跟进的线程）
-- 免登录：author_name/author_role 仅用于展示（UI 已标注"署名未做身份校验"）
-- ============================================================

create table if not exists public.task_feedback_threads (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  status      text not null default 'open' check (status in ('open','in_progress','resolved')),
  created_at  timestamptz not null default now(),
  created_by  text not null default '',
  resolved_at timestamptz,
  resolved_by text not null default '',
  updated_at  timestamptz not null default now()
);

create table if not exists public.task_feedback_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.task_feedback_threads(id) on delete cascade,
  body        text not null,
  author_name text not null default '',
  author_role text not null default 'leader' check (author_role in ('leader','owner')),
  created_at  timestamptz not null default now()
);

create index if not exists task_feedback_threads_task_idx on public.task_feedback_threads (task_id);
create index if not exists task_feedback_messages_thread_idx on public.task_feedback_messages (thread_id);

drop trigger if exists task_feedback_threads_set_updated_at on public.task_feedback_threads;
create trigger task_feedback_threads_set_updated_at
  before update on public.task_feedback_threads
  for each row execute function public.set_updated_at();

-- 原子创建线程（线程 + 首条消息 同事务）
create or replace function public.create_feedback_thread(
  p_task_id uuid,
  p_body text,
  p_author_name text default '',
  p_author_role text default 'leader'
) returns public.task_feedback_threads
language plpgsql
security definer
as $$
declare v_thread public.task_feedback_threads;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception '反馈内容不能为空';
  end if;
  insert into public.task_feedback_threads (task_id, status, created_by)
  values (p_task_id, 'open', p_author_name)
  returning * into v_thread;
  insert into public.task_feedback_messages (thread_id, body, author_name, author_role)
  values (v_thread.id, p_body, p_author_name, p_author_role);
  return v_thread;
end;
$$;

-- 原子回复（插入消息；若线程已解决则自动重新打开）
create or replace function public.add_feedback_reply(
  p_thread_id uuid,
  p_body text,
  p_author_name text default '',
  p_author_role text default 'owner'
) returns public.task_feedback_messages
language plpgsql
security definer
as $$
declare v_msg public.task_feedback_messages;
declare v_thread public.task_feedback_threads;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception '回复内容不能为空';
  end if;
  select * into v_thread from public.task_feedback_threads where id = p_thread_id;
  if v_thread is null then
    raise exception '反馈线程不存在: %', p_thread_id;
  end if;
  insert into public.task_feedback_messages (thread_id, body, author_name, author_role)
  values (p_thread_id, p_body, p_author_name, p_author_role)
  returning * into v_msg;
  -- 已解决的线程被再次回复 → 重新打开
  if v_thread.status = 'resolved' then
    update public.task_feedback_threads
       set status = 'open', resolved_at = null, resolved_by = ''
     where id = p_thread_id;
  end if;
  return v_msg;
end;
$$;

-- 状态迁移（resolved 记录解决者与时间）
create or replace function public.set_feedback_status(
  p_thread_id uuid,
  p_status text,
  p_by_name text default ''
) returns public.task_feedback_threads
language plpgsql
security definer
as $$
declare v_thread public.task_feedback_threads;
begin
  if p_status not in ('open','in_progress','resolved') then
    raise exception '非法状态: %', p_status;
  end if;
  update public.task_feedback_threads
     set status = p_status,
         resolved_at = case when p_status = 'resolved' then now() else null end,
         resolved_by = case when p_status = 'resolved' then p_by_name else '' end
   where id = p_thread_id
  returning * into v_thread;
  if v_thread is null then
    raise exception '反馈线程不存在: %', p_thread_id;
  end if;
  return v_thread;
end;
$$;

grant execute on function public.create_feedback_thread(uuid, text, text, text) to anon, authenticated;
grant execute on function public.add_feedback_reply(uuid, text, text, text) to anon, authenticated;
grant execute on function public.set_feedback_status(uuid, text, text) to anon, authenticated;

-- ---------------- 权限：全开放（无登录、无权限控制） ----------------
-- 仅本人与 Leader 使用，无敏感数据；打开网页即可查看与编辑。
-- 若未来需要加权限，可在此收紧策略。
alter table public.tasks        enable row level security;
alter table public.task_updates enable row level security;

drop policy if exists allow_all_tasks        on public.tasks;
drop policy if exists allow_all_task_updates on public.task_updates;
drop policy if exists allow_all_feedback_threads  on public.task_feedback_threads;
drop policy if exists allow_all_feedback_messages on public.task_feedback_messages;
create policy allow_all_tasks        on public.tasks        for all using (true) with check (true);
create policy allow_all_task_updates on public.task_updates for all using (true) with check (true);
create policy allow_all_feedback_threads  on public.task_feedback_threads  for all using (true) with check (true);
create policy allow_all_feedback_messages on public.task_feedback_messages for all using (true) with check (true);

-- anon（前端网页使用的匿名 key）与 authenticated 角色均授予全权限
grant all on public.tasks        to anon, authenticated;
grant all on public.task_updates to anon, authenticated;
grant all on public.task_feedback_threads  to anon, authenticated;
grant all on public.task_feedback_messages to anon, authenticated;
grant usage on schema public to anon, authenticated;
