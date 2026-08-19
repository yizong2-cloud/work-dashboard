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
                     check (priority in ('urgent','high','normal','low')),
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
  -- 兼容两个约束名：create table 内联约束自动命名 tasks_priority_check（旧库残留），
  -- 以及此前迁移添加的 tasks_priority_ck；两者都 drop 后重建为含 urgent 的单一约束。
  alter table public.tasks drop constraint if exists tasks_priority_check;
  alter table public.tasks drop constraint if exists tasks_priority_ck;
  alter table public.tasks add constraint tasks_priority_ck check (priority in ('urgent','high','normal','low'));
end $$;

-- ---------------- task_updates 表（时间线，保留完整历史） ----------------
create table if not exists public.task_updates (
  id                    uuid primary key default gen_random_uuid(),
  task_id               uuid not null references public.tasks(id) on delete cascade,
  type                  text not null default 'note'
                        check (type in ('progress','status_change','schedule_change','blocked','unblocked','interrupt','note','completed','urgent','deurgent','nudge')),
  content               text not null default '',
  old_expected_end_date date,
  new_expected_end_date date,
  created_at            timestamptz not null default now(),
  created_by            text not null default '',
  -- 推送意图（Agent 显式声明，无时间窗口）：
  --   immediate 单条秒推（默认）；merge 合并进同批聚合卡（batch 命令用，flush_merge 投递）；
  --   silent 只写时间线不推送（纯 note 备注/历史补记）。
  notify_mode           text not null default 'immediate'
                        check (notify_mode in ('immediate','merge','silent')),
  merge_key             text
);

-- 对已存在的表补充新列（create table if not exists 不追加列）
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='task_updates' and column_name='notify_mode') then
    alter table public.task_updates add column notify_mode text not null default 'immediate';
    alter table public.task_updates add column merge_key text;
  end if;
end $$;

create index if not exists task_updates_task_id_idx on public.task_updates (task_id);
create index if not exists tasks_status_idx on public.tasks (status);

-- 对已存在的表重建 task_updates.type 约束（支持 urgent/nudge 新类型）
do $$
begin
  alter table public.task_updates drop constraint if exists task_updates_type_check;
  alter table public.task_updates add constraint task_updates_type_check check
    (type in ('progress','status_change','schedule_change','blocked','unblocked','interrupt','note','completed','urgent','deurgent','nudge'));
end $$;

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
  p_created_by text default 'agent',
  p_notify_mode text default 'immediate',
  p_merge_key text default null
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

  insert into public.task_updates (task_id, type, content, old_expected_end_date, new_expected_end_date, created_at, created_by, notify_mode, merge_key)
  values (p_task_id, p_type, p_content, p_old_date, p_new_date, now(), p_created_by, p_notify_mode, p_merge_key);

  return v_task;
end;
$$;

grant execute on function public.apply_task_update(uuid, jsonb, text, text, date, date, text, text, text) to anon, authenticated;

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

-- ============================================================
-- 通知投递队列（任务二：飞书通知闭环）
-- 数据库触发器把「任务时间线 / 反馈事件」写入 outbox（唯一事件源），
-- Database Webhook 监听 outbox → feishu-notify Edge Function 投递到飞书。
-- outbox 只由触发器（security definer）与 Edge Function（service_role）读写，
-- anon 无权限；幂等键 = 源记录 id，投递状态可审计可重试。
-- ============================================================

create table if not exists public.notification_outbox (
  id          uuid primary key default gen_random_uuid(),
  event_type  text not null check (event_type in
              ('task_update','task_update_progress','task_nudged','feedback_created','feedback_replied','feedback_resolved')),
  source_key  text not null unique,          -- 幂等键（源记录 id；progress 聚合行用首条 id）
  payload     jsonb not null default '{}',
  status      text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts    int not null default 0,
  last_error  text not null default '',
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists notification_outbox_status_idx on public.notification_outbox (status, created_at);

-- 对已存在的表重建 event_type 约束（支持 task_nudged 新事件）
do $$
begin
  alter table public.notification_outbox drop constraint if exists notification_outbox_event_type_check;
  alter table public.notification_outbox add constraint notification_outbox_event_type_check check
    (event_type in ('task_update','task_update_progress','task_nudged','feedback_created','feedback_replied','feedback_resolved'));
end $$;

-- ---- 投递目标配置（URL 与签名 secret，值在部署时写入，不落仓库）----
create table if not exists public.webhook_endpoint (
  id     int primary key default 1 check (id = 1),
  url    text not null default '',
  secret text not null default ''
);
-- RLS：不允许 anon 读取投递配置；触发器以 security definer 访问
alter table public.webhook_endpoint enable row level security;
drop policy if exists webhook_endpoint_no_public on public.webhook_endpoint;

-- ---- 投递触发器：outbox 新事件（或失败重试置 pending）→ pg_net 调 Edge Function ----
-- 替代平台 Database Webhook（Management API 无 CRUD 端点，pg_net 全自动且无需控制台）。
-- 幂等由 Edge Function 的 claim 保证；失败事件由 retry_failed_notifications() 置回 pending 触发重发。
create or replace function public.notify_outbox_deliver()
returns trigger
language plpgsql
security definer
as $$
declare v_ep public.webhook_endpoint;
begin
  if new.status <> 'pending' then
    return new;
  end if;
  -- 普通 progress 聚合行：不即时投递，等待 30 分钟窗口结束由
  -- deliver_pending_notifications()（pg_cron 每 5 分钟）投递合并版，避免刷屏。
  if new.event_type = 'task_update_progress' then
    return new;
  end if;
  select * into v_ep from public.webhook_endpoint where id = 1;
  if v_ep is null or v_ep.url = '' then
    return new; -- 未配置投递目标，静默跳过（outbox 仍可审计）
  end if;
  perform net.http_post(
    url := v_ep.url,
    body := jsonb_build_object('type', TG_OP, 'table', 'notification_outbox', 'record', to_jsonb(new)),
    headers := jsonb_build_object('content-type', 'application/json', 'x-dashboard-secret', v_ep.secret),
    timeout_milliseconds := 30000
  );
  return new;
end;
$$;

drop trigger if exists notify_outbox_deliver_trigger on public.notification_outbox;
create trigger notify_outbox_deliver_trigger
  after insert or update of status on public.notification_outbox
  for each row execute function public.notify_outbox_deliver();

alter table public.notification_outbox enable row level security;
-- 无 anon/authenticated 策略：只有 service_role / 触发器（security definer）可访问
drop policy if exists outbox_no_public_access on public.notification_outbox;

-- ---- 触发器：task_updates → outbox（由 Agent 显式声明 immediate/merge/silent）----
create or replace function public.notify_task_update()
returns trigger
language plpgsql
security definer
as $$
declare v_existing uuid;
begin
  -- 历史补记（--at 回填 / 批量拆分补时间线）：不是「此刻发生」的事件，只入时间线不推送。
  if new.created_at < now() - interval '10 minutes' then
    return new;
  end if;

  -- silent（纯 note 备注/历史补记）：只写时间线，不推送。
  if new.notify_mode = 'silent' then
    return new;
  end if;

  -- merge（Agent 批量声明）：合并进同 merge_key 的聚合卡（pending，等待 flush_merge 一次性投递）。
  if new.notify_mode = 'merge' and new.merge_key is not null then
    select id into v_existing
      from public.notification_outbox
     where event_type = 'task_update_progress'
       and status = 'pending'
       and payload->>'merge_key' = new.merge_key
     order by created_at desc
     limit 1;
    if v_existing is not null then
      update public.notification_outbox
         set payload = jsonb_set(
               jsonb_set(payload, '{count}', to_jsonb(coalesce((payload->>'count')::int, 1) + 1)),
               '{latest}', to_jsonb(new.content)),
             updated_at = now()
       where id = v_existing;
      return new;
    end if;
    insert into public.notification_outbox (event_type, source_key, payload)
    values (
      'task_update_progress',
      new.id::text,
      jsonb_build_object(
        'task_id', new.task_id::text,
        'type', 'progress',
        'content', new.content,
        'created_by', new.created_by,
        'created_at', new.created_at,
        'merge_key', new.merge_key,
        'count', 1,
        'latest', new.content
      )
    );
    return new;
  end if;

  -- immediate（默认）与其他：单条立即投递。progress 不再有 30 分钟窗口，
  -- 单条进度秒推；批量由 Agent 显式声明 merge。
  insert into public.notification_outbox (event_type, source_key, payload)
  values (
    case when new.type = 'nudge' then 'task_nudged' else 'task_update' end,
    new.id::text,
    jsonb_build_object(
      'task_id', new.task_id::text,
      'type', new.type,
      'content', new.content,
      'created_by', new.created_by,
      'created_at', new.created_at
    )
  );
  return new;
end;
$$;

drop trigger if exists notify_task_update_trigger on public.task_updates;
create trigger notify_task_update_trigger
  after insert on public.task_updates
  for each row execute function public.notify_task_update();

-- ---- 触发器：反馈消息 → outbox（首条=feedback_created，其余=feedback_replied）----
create or replace function public.notify_feedback_message()
returns trigger
language plpgsql
security definer
as $$
declare v_count int;
begin
  select count(*) into v_count from public.task_feedback_messages where thread_id = new.thread_id;
  insert into public.notification_outbox (event_type, source_key, payload)
  values (
    case when v_count <= 1 then 'feedback_created' else 'feedback_replied' end,
    new.id::text,
    jsonb_build_object(
      'thread_id', new.thread_id::text,
      'body', new.body,
      'author_name', new.author_name,
      'author_role', new.author_role,
      'created_at', new.created_at
    )
  );
  return new;
end;
$$;

drop trigger if exists notify_feedback_message_trigger on public.task_feedback_messages;
create trigger notify_feedback_message_trigger
  after insert on public.task_feedback_messages
  for each row execute function public.notify_feedback_message();

-- ---- 触发器：反馈线程状态变化 → outbox（feedback_resolved / 重新打开）----
create or replace function public.notify_feedback_status()
returns trigger
language plpgsql
security definer
as $$
begin
  -- 仅「解决 ↔ 非解决」变化才通知；open→in_progress 这类普通状态流转不发（避免噪音）
  if (old.status = 'resolved') <> (new.status = 'resolved') then
    insert into public.notification_outbox (event_type, source_key, payload)
    values (
      'feedback_resolved',
      new.id::text || ':' || extract(epoch from new.updated_at)::text,
      jsonb_build_object(
        'thread_id', new.id::text,
        'old_status', old.status,
        'new_status', new.status,
        'resolved_by', new.resolved_by,
        'updated_at', new.updated_at
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists notify_feedback_status_trigger on public.task_feedback_threads;
create trigger notify_feedback_status_trigger
  after update on public.task_feedback_threads
  for each row execute function public.notify_feedback_status();


-- 定时投递：merge 聚合卡兜底与超时 pending（pg_net 队列失败兜底）
create or replace function public.deliver_pending_notifications()
returns int
language plpgsql
security definer
as $$
declare v_ep public.webhook_endpoint;
declare v_row public.notification_outbox;
declare v_count int := 0;
begin
  select * into v_ep from public.webhook_endpoint where id = 1;
  if v_ep is null or v_ep.url = '' then
    return 0;
  end if;
  -- 兜底投递：所有 pending 超过 2 分钟的行（含 merge 聚合卡——Agent 未 flush 时由这里兜底；
  -- 正常单条 immediate 由 webhook 实时投递，不走这里）。
  for v_row in
    select * from public.notification_outbox
     where status = 'pending'
       and created_at <= now() - interval '2 minutes'
     order by created_at
     limit 20
  loop
    perform net.http_post(
      url := v_ep.url,
      body := jsonb_build_object('type', 'INSERT', 'table', 'notification_outbox', 'record', to_jsonb(v_row)),
      headers := jsonb_build_object('content-type', 'application/json', 'x-dashboard-secret', v_ep.secret),
      timeout_milliseconds := 30000
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.deliver_pending_notifications() to service_role;

-- ---- merge 批量立即投递：Agent 批量命令结束后调用，把该批的聚合卡一次性发出 ----
create or replace function public.flush_merge(p_merge_key text)
returns int
language plpgsql
security definer
as $$
declare v_ep public.webhook_endpoint;
declare v_row public.notification_outbox;
declare v_count int := 0;
begin
  if p_merge_key is null or p_merge_key = '' then
    return 0;
  end if;
  select * into v_ep from public.webhook_endpoint where id = 1;
  if v_ep is null or v_ep.url = '' then
    return 0;
  end if;
  for v_row in
    select * from public.notification_outbox
     where event_type = 'task_update_progress'
       and status = 'pending'
       and payload->>'merge_key' = p_merge_key
     order by created_at
  loop
    perform net.http_post(
      url := v_ep.url,
      body := jsonb_build_object('type', 'INSERT', 'table', 'notification_outbox', 'record', to_jsonb(v_row)),
      headers := jsonb_build_object('content-type', 'application/json', 'x-dashboard-secret', v_ep.secret),
      timeout_milliseconds := 30000
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.flush_merge(text) to service_role;

-- ---- 失败重试：把 failed（且未超次数）的行重新置为 pending（webhook 监听 UPDATE 会重新投递）----
create or replace function public.retry_failed_notifications(max_attempts int default 5)
returns int
language plpgsql
security definer
as $$
declare v_updated int := 0;
declare v_more int;
begin
  -- 投递失败未超次数的 → 重新投递
  update public.notification_outbox
     set status = 'pending', updated_at = now()
   where status = 'failed' and attempts < max_attempts;
  get diagnostics v_updated = ROW_COUNT;
  -- 长时间停留在 sending（进程中断）的 → 重新投递
  update public.notification_outbox
     set status = 'pending', updated_at = now()
   where status = 'sending' and updated_at < now() - interval '10 minutes';
  get diagnostics v_more = ROW_COUNT;
  return v_updated + v_more;
end;
$$;

-- attempts 原子递增（失败回写用，REST PATCH 无法做表达式）
create or replace function public.mark_notification_status(
  p_id uuid, p_status text, p_error text default '', p_sent_at timestamptz default null
) returns public.notification_outbox
language plpgsql
security definer
as $$
declare v_row public.notification_outbox;
begin
  update public.notification_outbox
     set status = p_status,
         attempts = case when p_status = 'failed' then attempts + 1 else attempts end,
         last_error = case when p_error = '' then last_error else p_error end,
         sent_at = coalesce(p_sent_at, sent_at),
         updated_at = now()
   where id = p_id
  returning * into v_row;
  if v_row is null then
    raise exception 'outbox 行不存在: %', p_id;
  end if;
  return v_row;
end;
$$;

grant execute on function public.mark_notification_status(uuid, text, text, timestamptz) to service_role;

grant execute on function public.retry_failed_notifications(int) to service_role;

-- ============================================================
-- 日粒度工作计划（任务三：按天的线性工作计划视图）
-- task_plan_blocks 表示「具体哪几天计划投入」；tasks.start_date/expected_end_date
-- 表示任务整体生命周期，两者互不覆盖。plan_block_changes 保留调整历史。
-- ============================================================

create table if not exists public.task_plan_blocks (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  summary     text not null default '',
  status      text not null default 'planned' check (status in ('planned','active','done','changed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  text not null default '',
  constraint plan_block_date_ck check (end_date >= start_date)
);

create table if not exists public.task_plan_block_changes (
  id             uuid primary key default gen_random_uuid(),
  block_id       uuid not null references public.task_plan_blocks(id) on delete cascade,
  old_start_date date,
  old_end_date   date,
  old_status     text,
  new_start_date date,
  new_end_date   date,
  new_status     text,
  note           text not null default '',
  changed_at     timestamptz not null default now(),
  changed_by     text not null default ''
);

create index if not exists task_plan_blocks_task_idx on public.task_plan_blocks (task_id);
create index if not exists task_plan_blocks_dates_idx on public.task_plan_blocks (start_date, end_date);
create index if not exists task_plan_block_changes_block_idx on public.task_plan_block_changes (block_id);

drop trigger if exists task_plan_blocks_set_updated_at on public.task_plan_blocks;
create trigger task_plan_blocks_set_updated_at
  before update on public.task_plan_blocks
  for each row execute function public.set_updated_at();

-- 原子创建计划块
create or replace function public.create_plan_block(
  p_task_id uuid, p_start_date date, p_end_date date,
  p_summary text default '', p_status text default 'planned',
  p_created_by text default ''
) returns public.task_plan_blocks
language plpgsql
security definer
as $$
declare v_block public.task_plan_blocks;
begin
  if p_end_date < p_start_date then
    raise exception '结束日期不得早于开始日期';
  end if;
  insert into public.task_plan_blocks (task_id, start_date, end_date, summary, status, created_by)
  values (p_task_id, p_start_date, p_end_date, p_summary, p_status, p_created_by)
  returning * into v_block;
  return v_block;
end;
$$;

-- 原子调整计划块（更新 + 写变更历史）
create or replace function public.move_plan_block(
  p_block_id uuid, p_start_date date default null, p_end_date date default null,
  p_note text default '', p_by text default ''
) returns public.task_plan_blocks
language plpgsql
security definer
as $$
declare v_block public.task_plan_blocks;
begin
  select * into v_block from public.task_plan_blocks where id = p_block_id;
  if v_block is null then
    raise exception '计划块不存在: %', p_block_id;
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception '调整计划块必须填写原因（--note）';
  end if;
  if p_start_date is null then p_start_date := v_block.start_date; end if;
  if p_end_date is null then p_end_date := v_block.end_date; end if;
  if p_end_date < p_start_date then
    raise exception '结束日期不得早于开始日期';
  end if;
  insert into public.task_plan_block_changes
    (block_id, old_start_date, old_end_date, old_status, new_start_date, new_end_date, new_status, note, changed_by)
  values
    (p_block_id, v_block.start_date, v_block.end_date, v_block.status, p_start_date, p_end_date, 'changed', p_note, p_by);
  update public.task_plan_blocks
     set start_date = p_start_date, end_date = p_end_date, status = 'changed'
   where id = p_block_id
  returning * into v_block;
  return v_block;
end;
$$;

-- 原子标记完成（记录历史）
create or replace function public.done_plan_block(
  p_block_id uuid, p_note text default '', p_by text default ''
) returns public.task_plan_blocks
language plpgsql
security definer
as $$
declare v_block public.task_plan_blocks;
begin
  select * into v_block from public.task_plan_blocks where id = p_block_id;
  if v_block is null then
    raise exception '计划块不存在: %', p_block_id;
  end if;
  insert into public.task_plan_block_changes
    (block_id, old_start_date, old_end_date, old_status, new_start_date, new_end_date, new_status, note, changed_by)
  values
    (p_block_id, v_block.start_date, v_block.end_date, v_block.status, v_block.start_date, v_block.end_date, 'done', p_note, p_by);
  update public.task_plan_blocks
     set status = 'done'
   where id = p_block_id
  returning * into v_block;
  return v_block;
end;
$$;

grant execute on function public.create_plan_block(uuid, date, date, text, text, text) to anon, authenticated;
grant execute on function public.move_plan_block(uuid, date, date, text, text) to anon, authenticated;
grant execute on function public.done_plan_block(uuid, text, text) to anon, authenticated;

-- 幂等安排到某天：同任务当天已有未完成计划则返回该计划；否则在同一事务中创建计划块与静默审计时间线。
-- advisory lock 防止同一任务同一天的并发点击创建重复计划块。
create or replace function public.ensure_plan_for_day(
  p_task_id uuid, p_date date, p_created_by text default ''
) returns public.task_plan_blocks
language plpgsql
security definer
as $$
declare v_block public.task_plan_blocks;
begin
  if p_date is null then
    raise exception '计划日期不能为空';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_task_id::text), (p_date - date '2000-01-01')::integer);
  select * into v_block
    from public.task_plan_blocks
   where task_id = p_task_id
     and start_date <= p_date
     and end_date >= p_date
     and status <> 'done'
   order by created_at asc
   limit 1;
  if v_block is not null then
    return v_block;
  end if;

  insert into public.task_plan_blocks (task_id, start_date, end_date, summary, status, created_by)
  values (p_task_id, p_date, p_date, '', 'planned', p_created_by)
  returning * into v_block;
  insert into public.task_updates (task_id, type, content, created_by, notify_mode)
  values (p_task_id, 'note', format('安排到今天日计划（%s）', p_date), p_created_by, 'silent');
  return v_block;
end;
$$;

grant execute on function public.ensure_plan_for_day(uuid, date, text) to anon, authenticated;

-- ---------------- 权限：全开放（无登录、无权限控制） ----------------
-- 仅本人与 Leader 使用，无敏感数据；打开网页即可查看与编辑。
-- 若未来需要加权限，可在此收紧策略。
alter table public.tasks        enable row level security;
alter table public.task_updates enable row level security;

drop policy if exists allow_all_tasks        on public.tasks;
drop policy if exists allow_all_task_updates on public.task_updates;
-- 任务与时间线：全开放（CLI/网页任务更新）
drop policy if exists allow_all_tasks        on public.tasks;
drop policy if exists allow_all_task_updates on public.task_updates;
create policy allow_all_tasks        on public.tasks        for all using (true) with check (true);
create policy allow_all_task_updates on public.task_updates for all using (true) with check (true);
grant all on public.tasks        to anon, authenticated;
grant all on public.task_updates to anon, authenticated;

-- 反馈 / 计划 / 通知：匿名只读；写必须走原子 RPC（security definer），
-- 防止绕过 RPC 直接写表（无首条消息的线程、无历史的计划调整、伪造投递）。
alter table public.task_feedback_threads  enable row level security;
alter table public.task_feedback_messages enable row level security;
alter table public.task_plan_blocks       enable row level security;
alter table public.task_plan_block_changes enable row level security;

-- 撤销旧的「全权限」授权（grant 是持久的，必须显式 revoke）
revoke all on public.task_feedback_threads   from anon, authenticated;
revoke all on public.task_feedback_messages  from anon, authenticated;
revoke all on public.task_plan_blocks        from anon, authenticated;
revoke all on public.task_plan_block_changes from anon, authenticated;

drop policy if exists allow_all_feedback_threads  on public.task_feedback_threads;
drop policy if exists allow_all_feedback_messages on public.task_feedback_messages;
drop policy if exists allow_all_plan_blocks        on public.task_plan_blocks;
drop policy if exists allow_all_plan_block_changes on public.task_plan_block_changes;
drop policy if exists outbox_no_public_access      on public.notification_outbox;
drop policy if exists webhook_endpoint_no_public   on public.webhook_endpoint;

drop policy if exists feedback_threads_read  on public.task_feedback_threads;
drop policy if exists feedback_messages_read on public.task_feedback_messages;
drop policy if exists plan_blocks_read       on public.task_plan_blocks;
drop policy if exists plan_changes_read      on public.task_plan_block_changes;
create policy feedback_threads_read  on public.task_feedback_threads  for select using (true);
create policy feedback_messages_read on public.task_feedback_messages for select using (true);
create policy plan_blocks_read       on public.task_plan_blocks       for select using (true);
create policy plan_changes_read      on public.task_plan_block_changes for select using (true);

grant select on public.task_feedback_threads  to anon, authenticated;
grant select on public.task_feedback_messages to anon, authenticated;
grant select on public.task_plan_blocks       to anon, authenticated;
grant select on public.task_plan_block_changes to anon, authenticated;
grant usage on schema public to anon, authenticated;

-- ============================================================
-- 工作日日报（产品：Leader 每天 19:30 收到全局风险汇总卡，回应
-- 「未排期的我咋知道啥时候完成」——未排期任务在日报里直接列出原因）
-- ============================================================

create or replace function public.send_daily_report()
returns int
language plpgsql
security definer
as $$
declare v_ep public.webhook_endpoint;
  v_overdue jsonb; v_week jsonb; v_urgent jsonb; v_blocked jsonb; v_unscheduled jsonb;
  v_feedback int; v_updates int; v_active int; v_planned int;
  v_payload jsonb;
begin
  select * into v_ep from public.webhook_endpoint where id = 1;
  if v_ep is null or v_ep.url = '' then
    return 0;
  end if;

  -- 已逾期：预计完成 < 今天 且未完成
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'expected_end_date', expected_end_date, 'current_status', current_status)
           order by expected_end_date), '[]'::jsonb)
    into v_overdue
    from public.tasks
   where status not in ('completed','cancelled')
     and expected_end_date is not null
     and expected_end_date < CURRENT_DATE;

  -- 本周到期（今天起未来 7 天）
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'expected_end_date', expected_end_date, 'current_status', current_status)
           order by expected_end_date), '[]'::jsonb)
    into v_week
    from public.tasks
   where status not in ('completed','cancelled')
     and expected_end_date between CURRENT_DATE and CURRENT_DATE + 6;

  -- 加急中
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'expected_end_date', expected_end_date) order by title), '[]'::jsonb)
    into v_urgent
    from public.tasks
   where priority = 'urgent' and status not in ('completed','cancelled');

  -- 阻塞中
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'block_reason', block_reason) order by title), '[]'::jsonb)
    into v_blocked
    from public.tasks
   where status = 'blocked';

  -- 未排期（进行中但无预计完成日期）——Leader 核心痛点
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'current_status', current_status) order by title), '[]'::jsonb)
    into v_unscheduled
    from public.tasks
   where status = 'in_progress' and expected_end_date is null;

  -- 待回应反馈
  select count(*) into v_feedback
    from public.task_feedback_threads
   where status <> 'resolved';

  -- 今日更新 / 活跃任务 / 待开始
  select count(*) into v_updates from public.task_updates
   where created_at >= date_trunc('day', now());
  select count(*) into v_active from public.tasks where status = 'in_progress';
  select count(*) into v_planned from public.tasks where status = 'planned';

  v_payload := jsonb_build_object(
    'kind', 'daily', 'date', CURRENT_DATE,
    'overdue', v_overdue, 'week', v_week, 'urgent', v_urgent,
    'blocked', v_blocked, 'unscheduled', v_unscheduled,
    'feedback_open', v_feedback, 'updates_today', v_updates,
    'active_count', v_active, 'planned_count', v_planned
  );

  perform net.http_post(
    url := v_ep.url,
    -- record 结构与 outbox 一致：{id, event_type, payload}，Edge Function 统一解析
    body := jsonb_build_object('type', 'INSERT', 'table', 'daily_report', 'record',
             jsonb_build_object('id', 'daily-report', 'event_type', 'daily_report', 'payload', v_payload)),
    headers := jsonb_build_object('content-type', 'application/json', 'x-dashboard-secret', v_ep.secret),
    timeout_milliseconds := 30000
  );
  return 1;
end;
$$;

grant execute on function public.send_daily_report() to service_role;

-- 调度：工作日（周一~五）19:30 北京时间。pg_cron 按数据库时区（UTC）解释，
-- 11:30 UTC = 19:30 北京。同名 job 幂等（cron.schedule 同名即更新）。
select cron.schedule('workboard-daily-report', '30 11 * * 1-5', 'select public.send_daily_report()');

-- 通知维护：pending 兜底每 5 分钟投递；failed 每 15 分钟重试，最多 5 次。
-- 先按名称移除旧 job，保证重复执行 schema / 迁移不会创建重复调度。
do $$
declare v_jobid bigint;
begin
  for v_jobid in
    select jobid from cron.job
     where jobname in ('workboard-notification-pending', 'workboard-notification-retry')
  loop
    perform cron.unschedule(v_jobid);
  end loop;
  perform cron.schedule('workboard-notification-pending', '*/5 * * * *', 'select public.deliver_pending_notifications()');
  perform cron.schedule('workboard-notification-retry', '*/15 * * * *', 'select public.retry_failed_notifications(5)');
end $$;

-- ============================================================
-- 决策中心（Decision Hub）数据模型与 RPC
-- ============================================================

-- ---------------- 1. decision_forms 表 ----------------
create table if not exists public.decision_forms (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  title           text not null,
  summary         text not null default '',
  source_document text,
  status          text not null default 'open'
                  check (status in ('draft', 'open', 'closed')),
  created_by      text not null default 'agent',
  created_at      timestamptz not null default now(),
  closed_at       timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists decision_forms_slug_idx on public.decision_forms (slug);
create index if not exists decision_forms_status_idx on public.decision_forms (status);

drop trigger if exists decision_forms_set_updated_at on public.decision_forms;
create trigger decision_forms_set_updated_at
  before update on public.decision_forms
  for each row execute function public.set_updated_at();

-- ---------------- 2. decision_questions 表 ----------------
create table if not exists public.decision_questions (
  id                    uuid primary key default gen_random_uuid(),
  form_id               uuid not null references public.decision_forms(id) on delete cascade,
  code                  text not null,
  sort_order            integer not null default 0,
  title                 text not null,
  context               text not null default '',
  type                  text not null
                        check (type in ('single_choice', 'multiple_choice', 'free_text', 'confirmation')),
  required              boolean not null default true,
  allow_other           boolean not null default false,
  recommended_option_id uuid,
  recommended_reason    text not null default '',
  created_at            timestamptz not null default now(),
  constraint decision_questions_form_code_unique unique (form_id, code)
);

create index if not exists decision_questions_form_id_idx on public.decision_questions (form_id);

-- ---------------- 3. decision_options 表 ----------------
create table if not exists public.decision_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.decision_questions(id) on delete cascade,
  code        text not null,
  label       text not null,
  detail      text not null default '',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint decision_options_question_code_unique unique (question_id, code)
);

create index if not exists decision_options_question_id_idx on public.decision_options (question_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'decision_questions_recommended_opt_fk'
  ) then
    alter table public.decision_questions
      add constraint decision_questions_recommended_opt_fk
      foreign key (recommended_option_id) references public.decision_options(id) on delete set null;
  end if;
end $$;

-- ---------------- 4. decision_responses 表 ----------------
create table if not exists public.decision_responses (
  id              uuid primary key default gen_random_uuid(),
  form_id         uuid not null references public.decision_forms(id) on delete cascade,
  respondent_name text not null,
  respondent_note text not null default '',
  submitted_at    timestamptz not null default now()
);

create index if not exists decision_responses_form_id_idx on public.decision_responses (form_id);
create index if not exists decision_responses_submitted_at_idx on public.decision_responses (submitted_at desc);

-- ---------------- 5. decision_answers 表 ----------------
create table if not exists public.decision_answers (
  id                  uuid primary key default gen_random_uuid(),
  response_id         uuid not null references public.decision_responses(id) on delete cascade,
  question_id         uuid not null references public.decision_questions(id) on delete cascade,
  selected_option_ids jsonb not null default '[]'::jsonb,
  text_answer         text not null default '',
  other_text          text not null default '',
  constraint decision_answers_response_question_unique unique (response_id, question_id)
);

create index if not exists decision_answers_response_id_idx on public.decision_answers (response_id);
create index if not exists decision_answers_question_id_idx on public.decision_answers (question_id);

-- ---------------- 5.1 决策可追溯记录 ----------------
alter table public.decision_questions
  add column if not exists group_name text not null default '待确认事项',
  add column if not exists source_excerpt text not null default '',
  add column if not exists conversion_note text not null default '',
  add column if not exists resolution_status text not null default 'pending'
    check (resolution_status in ('pending', 'clarified', 'decided', 'changed'));

create table if not exists public.decision_clarifications (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.decision_forms(id) on delete cascade,
  question_id uuid not null references public.decision_questions(id) on delete cascade,
  kind text not null check (kind in ('clarification', 'decision', 'change')),
  content text not null check (btrim(content) <> ''),
  source_channel text not null default 'feishu',
  source_url text not null default '',
  created_by text not null default 'agent',
  created_at timestamptz not null default now()
);
create index if not exists decision_clarifications_form_question_idx
  on public.decision_clarifications(form_id, question_id, created_at desc);

-- ---------------- 6. RLS：匿名可读，写入只走受校验的 RPC ----------------
alter table public.decision_forms enable row level security;
alter table public.decision_questions enable row level security;
alter table public.decision_options enable row level security;
alter table public.decision_responses enable row level security;
alter table public.decision_answers enable row level security;
alter table public.decision_clarifications enable row level security;

drop policy if exists "decision_forms_all" on public.decision_forms;
drop policy if exists "decision_questions_all" on public.decision_questions;
drop policy if exists "decision_options_all" on public.decision_options;
drop policy if exists "decision_responses_all" on public.decision_responses;
drop policy if exists "decision_answers_all" on public.decision_answers;
drop policy if exists "decision_forms_read" on public.decision_forms;
drop policy if exists "decision_questions_read" on public.decision_questions;
drop policy if exists "decision_options_read" on public.decision_options;
drop policy if exists "decision_responses_read" on public.decision_responses;
drop policy if exists "decision_answers_read" on public.decision_answers;
drop policy if exists "decision_clarifications_read" on public.decision_clarifications;
create policy "decision_forms_read" on public.decision_forms for select using (true);
create policy "decision_questions_read" on public.decision_questions for select using (true);
create policy "decision_options_read" on public.decision_options for select using (true);
create policy "decision_responses_read" on public.decision_responses for select using (true);
create policy "decision_answers_read" on public.decision_answers for select using (true);
create policy "decision_clarifications_read" on public.decision_clarifications for select using (true);
revoke all on public.decision_forms, public.decision_questions, public.decision_options,
  public.decision_responses, public.decision_answers from anon, authenticated;
revoke all on public.decision_clarifications from anon, authenticated;
grant select on public.decision_forms, public.decision_questions, public.decision_options,
  public.decision_responses, public.decision_answers to anon, authenticated;
grant select on public.decision_clarifications to anon, authenticated;

-- ---------------- 7. 原子创建表单 RPC: create_decision_form ----------------
create or replace function public.create_decision_form(p_payload jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_slug text;
  v_title text;
  v_summary text;
  v_source_doc text;
  v_status text;
  v_created_by text;
  v_form_id uuid;
  v_questions jsonb;
  v_q jsonb;
  v_q_id uuid;
  v_q_code text;
  v_q_type text;
  v_q_title text;
  v_q_context text;
  v_q_required boolean;
  v_q_allow_other boolean;
  v_q_rec_code text;
  v_q_rec_reason text;
  v_options jsonb;
  v_opt jsonb;
  v_opt_id uuid;
  v_opt_code text;
  v_opt_label text;
  v_opt_detail text;
  v_rec_opt_id uuid;
  v_idx int;
  v_opt_idx int;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload 必须是 JSON 对象';
  end if;
  v_slug := btrim(coalesce(p_payload->>'slug', ''));
  v_title := btrim(coalesce(p_payload->>'title', ''));
  v_summary := coalesce(p_payload->>'summary', '');
  v_source_doc := p_payload->>'source_document';
  v_status := coalesce(p_payload->>'status', 'open');
  v_created_by := coalesce(p_payload->>'created_by', 'agent');
  v_questions := p_payload->'questions';

  if v_slug = '' then
    raise exception 'slug 不能为空';
  end if;
  if v_slug !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'slug 格式非法：只允许英文字母、数字、下划线及连字符';
  end if;
  if v_title = '' then
    raise exception 'title 不能为空';
  end if;
  if v_status not in ('draft', 'open', 'closed') then
    raise exception '非法状态: %', v_status;
  end if;
  if v_questions is null or jsonb_typeof(v_questions) <> 'array' or jsonb_array_length(v_questions) = 0 then
    raise exception 'questions 不能为空';
  end if;

  if exists (select 1 from public.decision_forms where slug = v_slug) then
    raise exception 'slug 已存在: %', v_slug;
  end if;

  insert into public.decision_forms (slug, title, summary, source_document, status, created_by)
  values (v_slug, v_title, v_summary, v_source_doc, v_status, v_created_by)
  returning id into v_form_id;

  for v_idx in 0 .. jsonb_array_length(v_questions) - 1 loop
    v_q := v_questions->v_idx;
    if jsonb_typeof(v_q) <> 'object' then
      raise exception '题目 % 必须是 JSON 对象', v_idx + 1;
    end if;
    v_q_code := btrim(coalesce(v_q->>'code', ''));
    v_q_title := btrim(coalesce(v_q->>'title', ''));
    v_q_context := coalesce(v_q->>'context', '');
    v_q_type := coalesce(v_q->>'type', 'single_choice');
    v_q_required := coalesce((v_q->>'required')::boolean, true);
    v_q_allow_other := coalesce((v_q->>'allow_other')::boolean, false);
    v_q_rec_code := btrim(coalesce(v_q->>'recommended_option_code', ''));
    v_q_rec_reason := coalesce(v_q->>'recommended_reason', '');
    v_options := v_q->'options';

    if v_q_code = '' or v_q_title = '' then
      raise exception '题目编号与标题不能为空: 索引 %', v_idx;
    end if;
    if v_q_type not in ('single_choice', 'multiple_choice', 'free_text', 'confirmation') then
      raise exception '非法题型: %', v_q_type;
    end if;
    if v_q_type in ('single_choice', 'multiple_choice')
       and (v_options is null or jsonb_typeof(v_options) <> 'array' or jsonb_array_length(v_options) = 0) then
      raise exception '选择题 % 必须至少包含一个选项', v_q_code;
    end if;
    if v_options is not null and jsonb_typeof(v_options) <> 'array' then
      raise exception '题目 % 的 options 必须是数组', v_q_code;
    end if;

    insert into public.decision_questions (
      form_id, code, sort_order, title, context, type, required, allow_other, recommended_reason
    ) values (
      v_form_id, v_q_code, v_idx, v_q_title, v_q_context, v_q_type, v_q_required, v_q_allow_other, v_q_rec_reason
    ) returning id into v_q_id;

    v_rec_opt_id := null;

    if v_options is not null and jsonb_array_length(v_options) > 0 then
      for v_opt_idx in 0 .. jsonb_array_length(v_options) - 1 loop
        v_opt := v_options->v_opt_idx;
        v_opt_code := btrim(coalesce(v_opt->>'code', ''));
        v_opt_label := btrim(coalesce(v_opt->>'label', ''));
        v_opt_detail := coalesce(v_opt->>'detail', '');

        if v_opt_code = '' or v_opt_label = '' then
          raise exception '选项编号与文案不能为空: 题 % 选项 %', v_q_code, v_opt_idx;
        end if;

        insert into public.decision_options (
          question_id, code, label, detail, sort_order
        ) values (
          v_q_id, v_opt_code, v_opt_label, v_opt_detail, v_opt_idx
        ) returning id into v_opt_id;

        if v_q_rec_code <> '' and v_q_rec_code = v_opt_code then
          v_rec_opt_id := v_opt_id;
        end if;
      end loop;

    end if;

    if v_q_rec_code <> '' and v_rec_opt_id is null then
      raise exception '推荐项 code "%" 在题目 "%" 中不存在', v_q_rec_code, v_q_code;
    end if;

    if v_rec_opt_id is not null then
      update public.decision_questions
         set recommended_option_id = v_rec_opt_id
       where id = v_q_id;
    end if;
  end loop;

  return jsonb_build_object(
    'id', v_form_id,
    'slug', v_slug,
    'title', v_title,
    'status', v_status
  );
end;
$$;

grant execute on function public.create_decision_form(jsonb) to anon, authenticated, service_role;

-- ---------------- 8. 原子提交答卷 RPC: submit_decision_response ----------------
create or replace function public.submit_decision_response(
  p_form_slug text,
  p_respondent_name text,
  p_answers jsonb,
  p_respondent_note text default ''
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_form public.decision_forms;
  v_response_id uuid;
  v_ans jsonb;
  v_idx int;
  v_q_id uuid;
  v_q public.decision_questions;
  v_selected_opts jsonb;
  v_opt_count int;
  v_text_ans text;
  v_other_text text;
  v_opt_id text;
  v_opt_idx int;
  v_req_q record;
  v_answered_q_ids uuid[] := array[]::uuid[];
  v_clean_note text;
begin
  p_respondent_name := btrim(coalesce(p_respondent_name, ''));
  v_clean_note := btrim(coalesce(p_respondent_note, ''));

  if length(p_respondent_name) > 50 then
    raise exception '提交身份过长（最多 50 字）';
  end if;

  select * into v_form from public.decision_forms where slug = p_form_slug;
  if v_form is null then
    raise exception '表单不存在: %', p_form_slug;
  end if;
  if v_form.status = 'draft' then
    raise exception '表单当前为草稿状态，尚未开放提交: %', p_form_slug;
  end if;
  if v_form.status = 'closed' then
    raise exception '表单已关闭，无法提交新答卷: %', p_form_slug;
  end if;

  if p_answers is null or jsonb_array_length(p_answers) = 0 then
    raise exception '提交答案不能为空';
  end if;

  for v_idx in 0 .. jsonb_array_length(p_answers) - 1 loop
    v_ans := p_answers->v_idx;
    v_q_id := (v_ans->>'question_id')::uuid;
    v_selected_opts := coalesce(v_ans->'selected_option_ids', '[]'::jsonb);
    v_text_ans := btrim(coalesce(v_ans->>'text_answer', ''));
    v_other_text := btrim(coalesce(v_ans->>'other_text', ''));
    v_opt_count := jsonb_array_length(v_selected_opts);

    select * into v_q from public.decision_questions where id = v_q_id and form_id = v_form.id;
    if v_q is null then
      raise exception '题目 % 不属于此表单', v_q_id;
    end if;

    if not v_q.allow_other and v_other_text <> '' then
      raise exception '题目 %（%）未开启“其他”选项，禁止提交其他说明', v_q.code, v_q.title;
    end if;

    if v_opt_count > 0 then
      for v_opt_idx in 0 .. v_opt_count - 1 loop
        v_opt_id := v_selected_opts->>v_opt_idx;
        if not exists (
          select 1 from public.decision_options where id = v_opt_id::uuid and question_id = v_q.id
        ) then
          raise exception '选项 % 不属于题目 %', v_opt_id, v_q.code;
        end if;
      end loop;
    end if;

    if v_q.type = 'single_choice' then
      if v_opt_count > 1 then
        raise exception '单选题 % 只能选择一个选项', v_q.code;
      end if;
      if v_opt_count = 1 and v_other_text <> '' then
        raise exception '单选题 % 已选择选项，不可同时填写其他说明', v_q.code;
      end if;
      if v_q.required and v_opt_count = 0 and v_other_text = '' then
        raise exception '必答单选题 % 未作答', v_q.code;
      end if;
      if v_opt_count > 0 or v_other_text <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;

    elsif v_q.type = 'multiple_choice' then
      if v_q.required and v_opt_count = 0 and v_other_text = '' then
        raise exception '必答多选题 % 未作答', v_q.code;
      end if;
      if v_opt_count > 0 or v_other_text <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;

    elsif v_q.type = 'free_text' then
      if v_opt_count > 0 then
        raise exception '自由文本题 % 不得包含选项选择', v_q.code;
      end if;
      if v_q.required and v_text_ans = '' then
        raise exception '必答自由文本题 % 未填写内容', v_q.code;
      end if;
      if v_text_ans <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;

    elsif v_q.type = 'confirmation' then
      if v_opt_count > 0 then
        raise exception '确认题 % 不得包含选项选择', v_q.code;
      end if;
      if v_text_ans <> '' and v_text_ans not in ('confirmed', 'unconfirmed') then
        raise exception '确认题 % 结果非法: "%"，只允许 confirmed 或 unconfirmed', v_q.code, v_text_ans;
      end if;
      if v_q.required and v_text_ans = '' then
        raise exception '必答确认题 % 未进行确认选择', v_q.code;
      end if;
      if v_text_ans <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;
    end if;
  end loop;

  for v_req_q in select id, code from public.decision_questions where form_id = v_form.id and required = true loop
    if not (v_req_q.id = any(v_answered_q_ids)) then
      raise exception '必答题未完成: %', v_req_q.code;
    end if;
  end loop;

  insert into public.decision_responses (form_id, respondent_name, respondent_note)
  values (v_form.id, p_respondent_name, v_clean_note)
  returning id into v_response_id;

  for v_idx in 0 .. jsonb_array_length(p_answers) - 1 loop
    v_ans := p_answers->v_idx;
    v_q_id := (v_ans->>'question_id')::uuid;
    v_selected_opts := coalesce(v_ans->'selected_option_ids', '[]'::jsonb);
    v_text_ans := coalesce(v_ans->>'text_answer', '');
    v_other_text := coalesce(v_ans->>'other_text', '');

    insert into public.decision_answers (
      response_id, question_id, selected_option_ids, text_answer, other_text
    ) values (
      v_response_id, v_q_id, v_selected_opts, v_text_ans, v_other_text
    );
  end loop;

  return jsonb_build_object(
    'id', v_response_id,
    'form_id', v_form.id,
    'respondent_name', p_respondent_name,
    'respondent_note', v_clean_note,
    'submitted_at', now()
  );
end;
$$;

grant execute on function public.submit_decision_response(text, text, jsonb, text) to anon, authenticated, service_role;

-- ---------------- 9. 状态流转 RPC ----------------
create or replace function public.close_decision_form(p_slug text)
returns void
language plpgsql
security definer
as $$
begin
  update public.decision_forms
     set status = 'closed',
         closed_at = now(),
         updated_at = now()
   where slug = p_slug;

  if not found then
    raise exception '表单不存在: %', p_slug;
  end if;
end;
$$;

grant execute on function public.close_decision_form(text) to anon, authenticated, service_role;

create or replace function public.open_decision_form(p_slug text)
returns void
language plpgsql
security definer
as $$
begin
  update public.decision_forms
     set status = 'open',
         closed_at = null,
         updated_at = now()
   where slug = p_slug;

  if not found then
    raise exception '表单不存在: %', p_slug;
  end if;
end;
$$;

grant execute on function public.open_decision_form(text) to anon, authenticated, service_role;

-- ---------------- 10. 决策依据补齐与外部澄清同步 ----------------
create or replace function public.enrich_decision_form(p_form_slug text, p_payload jsonb)
returns void
language plpgsql
security definer
as $$
declare
  v_form public.decision_forms;
  v_q jsonb;
  v_question public.decision_questions;
  v_idx int;
begin
  select * into v_form from public.decision_forms where slug = btrim(p_form_slug);
  if v_form is null then raise exception '表单不存在: %', p_form_slug; end if;
  if p_payload is null or jsonb_typeof(p_payload->'questions') <> 'array' then raise exception 'payload 缺少 questions 数组'; end if;
  if p_payload ? 'source_document' then
    update public.decision_forms set source_document = p_payload->>'source_document', updated_at = now() where id = v_form.id;
  end if;
  for v_idx in 0 .. jsonb_array_length(p_payload->'questions') - 1 loop
    v_q := p_payload->'questions'->v_idx;
    select * into v_question from public.decision_questions where form_id = v_form.id and code = btrim(coalesce(v_q->>'code', ''));
    if v_question is null then raise exception '题目不存在，无法补齐依据: %', v_q->>'code'; end if;
    update public.decision_questions set
      group_name = coalesce(nullif(btrim(v_q->>'group_name'), ''), '待确认事项'),
      source_excerpt = coalesce(v_q->>'source_excerpt', ''),
      conversion_note = coalesce(v_q->>'conversion_note', '')
      where id = v_question.id;
  end loop;
end;
$$;
grant execute on function public.enrich_decision_form(text, jsonb) to anon, authenticated, service_role;

create or replace function public.append_decision_clarification(
  p_form_slug text, p_question_code text, p_kind text, p_content text,
  p_source_channel text default 'feishu', p_source_url text default '', p_created_by text default 'agent'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_form public.decision_forms;
  v_question public.decision_questions;
  v_entry public.decision_clarifications;
  v_status text;
begin
  select * into v_form from public.decision_forms where slug = btrim(p_form_slug);
  if v_form is null then raise exception '表单不存在: %', p_form_slug; end if;
  select * into v_question from public.decision_questions where form_id = v_form.id and code = btrim(p_question_code);
  if v_question is null then raise exception '题目不存在: %', p_question_code; end if;
  if p_kind not in ('clarification', 'decision', 'change') then raise exception '澄清类型非法: %', p_kind; end if;
  if btrim(coalesce(p_content, '')) = '' then raise exception '澄清内容不能为空'; end if;
  insert into public.decision_clarifications (form_id, question_id, kind, content, source_channel, source_url, created_by)
  values (v_form.id, v_question.id, p_kind, btrim(p_content), coalesce(nullif(btrim(p_source_channel), ''), 'feishu'), btrim(coalesce(p_source_url, '')), coalesce(nullif(btrim(p_created_by), ''), 'agent'))
  returning * into v_entry;
  v_status := case when p_kind = 'decision' then 'decided' when p_kind = 'change' then 'changed' when v_question.resolution_status = 'decided' then 'decided' else 'clarified' end;
  update public.decision_questions set resolution_status = v_status where id = v_question.id;
  update public.decision_forms set updated_at = now() where id = v_form.id;
  return to_jsonb(v_entry);
end;
$$;
grant execute on function public.append_decision_clarification(text, text, text, text, text, text, text) to anon, authenticated, service_role;
