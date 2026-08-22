-- Leader 协作反馈与给 Agent 的处理指令必须是两类数据，不能仅靠前端改标题区分。
-- 既有线程均保留为 Leader 反馈：它们在此迁移前即以该语义创建，绝不静默丢失。

alter table public.task_feedback_threads
  add column if not exists kind text not null default 'leader_feedback';

alter table public.task_feedback_threads
  drop constraint if exists task_feedback_threads_kind_check;

alter table public.task_feedback_threads
  add constraint task_feedback_threads_kind_check
  check (kind in ('leader_feedback', 'agent_instruction'));

create index if not exists task_feedback_threads_kind_updated_idx
  on public.task_feedback_threads (kind, updated_at desc);

drop function if exists public.create_feedback_thread(uuid, text, text, text);

create function public.create_feedback_thread(
  p_task_id uuid,
  p_body text,
  p_author_name text default '',
  p_author_role text default 'leader',
  p_kind text default 'leader_feedback'
) returns public.task_feedback_threads
language plpgsql
security definer
as $$
declare v_thread public.task_feedback_threads;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception '反馈内容不能为空';
  end if;
  if p_author_role not in ('leader', 'owner') then
    raise exception '非法反馈角色: %', p_author_role;
  end if;
  if p_kind not in ('leader_feedback', 'agent_instruction') then
    raise exception '非法反馈类型: %', p_kind;
  end if;
  insert into public.task_feedback_threads (task_id, kind, status, created_by)
  values (p_task_id, p_kind, 'open', p_author_name)
  returning * into v_thread;
  insert into public.task_feedback_messages (thread_id, body, author_name, author_role)
  values (v_thread.id, p_body, p_author_name, p_author_role);
  return v_thread;
end;
$$;

grant execute on function public.create_feedback_thread(uuid, text, text, text, text) to anon, authenticated;

-- 给 Agent 的网页指令只进入处理箱；它不是 Leader 协作反馈，不能误发到 Leader 群。
create or replace function public.notify_feedback_message()
returns trigger
language plpgsql
security definer
as $$
declare v_count int;
declare v_kind text;
begin
  select kind into v_kind from public.task_feedback_threads where id = new.thread_id;
  if v_kind = 'agent_instruction' then
    return new;
  end if;
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

create or replace function public.notify_feedback_status()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.kind = 'agent_instruction' then
    return new;
  end if;
  -- 仅「解决 ↔ 非解决」变化才通知；处理中不发，避免噪音。
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
