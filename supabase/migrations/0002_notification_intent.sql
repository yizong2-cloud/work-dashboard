-- ============================================================
-- 通知意图契约：同步当前 CLI 与 supabase/schema.sql
--
-- 0001 仍使用旧的 30 分钟 progress 聚合，并且 apply_task_update 只有 7 个参数。
-- 当前 Agent 在写入时显式声明 immediate/merge/silent；本迁移补齐该契约。
-- ============================================================

begin;

-- ---------------- 时间线通知字段与类型约束 ----------------
alter table public.task_updates
  add column if not exists notify_mode text not null default 'immediate';
alter table public.task_updates
  add column if not exists merge_key text;

alter table public.task_updates drop constraint if exists task_updates_type_check;
alter table public.task_updates add constraint task_updates_type_check check
  (type in ('progress','status_change','schedule_change','blocked','unblocked','interrupt','note','completed','urgent','deurgent','nudge'));

alter table public.task_updates drop constraint if exists task_updates_notify_mode_check;
alter table public.task_updates add constraint task_updates_notify_mode_check check
  (notify_mode in ('immediate','merge','silent'));

-- ---------------- 原子更新 RPC：补齐通知意图参数 ----------------
-- 删除旧签名，避免带默认参数的新函数与旧函数产生调用歧义。
drop function if exists public.apply_task_update(uuid, jsonb, text, text, date, date, text);

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

  insert into public.task_updates
    (task_id, type, content, old_expected_end_date, new_expected_end_date,
     created_at, created_by, notify_mode, merge_key)
  values
    (p_task_id, p_type, p_content, p_old_date, p_new_date,
     now(), p_created_by, p_notify_mode, p_merge_key);

  return v_task;
end;
$$;

grant execute on function public.apply_task_update(uuid, jsonb, text, text, date, date, text, text, text)
  to anon, authenticated;

-- ---------------- outbox 事件类型 ----------------
alter table public.notification_outbox drop constraint if exists notification_outbox_event_type_check;
alter table public.notification_outbox add constraint notification_outbox_event_type_check check
  (event_type in ('task_update','task_update_progress','task_nudged','feedback_created','feedback_replied','feedback_resolved'));

-- ---------------- task_updates → outbox ----------------
-- 清理早期直连飞书的旧触发器；保留会让同一条时间线同时走旧 webhook 与新 outbox，造成重复推送。
drop trigger if exists task_updates_feishu_notify on public.task_updates;
drop function if exists public.notify_feishu_task_update();

create or replace function public.notify_task_update()
returns trigger
language plpgsql
security definer
as $$
declare v_existing uuid;
begin
  -- 历史补记不是此刻发生的事件，永不推送。
  if new.created_at < now() - interval '10 minutes' then
    return new;
  end if;

  -- 纯备注只写时间线；进展类 note 由 Agent 写成 progress + immediate。
  if new.notify_mode = 'silent' then
    return new;
  end if;

  -- 批量进度显式声明 merge，同批只生成一张待投递聚合卡。
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

  -- immediate：单条进展与关键事件即时投递，不再使用时间窗口猜测。
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

-- ---------------- pending/merge 兜底投递 ----------------
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

commit;
